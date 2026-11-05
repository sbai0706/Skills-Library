#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { rankSources } from "../skills/source-rank/index.js";
import { parseTimestamp } from "../skills/source-rank/timestamps.js";

const DEFAULT_FIXTURE = "source-rank-recency";
const FIXTURES = new Set([DEFAULT_FIXTURE]);

const HELP = `Usage: npm run source-rank -- [options]

Development and demonstration interface. Ranks the sources of one account by data recency
only, from a local fixture; it does not connect to live systems and makes no reliability,
authority or quality judgement.

Options:
  --fixture NAME   Bundled source-rank fixture (default: ${DEFAULT_FIXTURE})
  --account VALUE  Account ID to rank for; items of other accounts are excluded
                   (default: the fixture's account_id)
  --now VALUE      RFC 3339 date-time with an explicit offset, used as the clock (default: fixture's now)
  --output FORMAT  json or markdown (default: json)
  --help           Show this help

Exit codes: 0 success, 2 partial with data, 3 blocked, 1 failed/invalid invocation.
`;

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set(["--fixture", "--account", "--now", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    if (Object.hasOwn(parsed, option)) throw new Error(`Option may only be provided once: ${option}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    parsed[option] = value;
    index += 1;
  }

  const fixture = parsed["--fixture"] ?? DEFAULT_FIXTURE;
  if (!FIXTURES.has(fixture)) throw new Error(`Unknown fixture. Choose ${DEFAULT_FIXTURE}.`);
  const output = parsed["--output"] ?? "json";
  if (!new Set(["json", "markdown"]).has(output)) {
    throw new Error("--output must be json or markdown.");
  }
  if (Object.hasOwn(parsed, "--account") && !parsed["--account"].trim()) {
    throw new Error("--account must not be empty.");
  }
  if (Object.hasOwn(parsed, "--now") && parseTimestamp(parsed["--now"]) === null) {
    throw new Error("--now must be a valid RFC 3339 date-time with an explicit offset.");
  }
  return {
    help: false,
    fixture,
    output,
    ...(Object.hasOwn(parsed, "--account") ? { account: parsed["--account"].trim() } : {}),
    ...(Object.hasOwn(parsed, "--now") ? { now: parsed["--now"] } : {}),
  };
}

function emitDiagnostics(result) {
  for (const diagnostic of [...result.warnings, ...result.errors]) {
    process.stderr.write(`source.rank: ${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

function exitCode(status) {
  return { success: 0, partial: 2, blocked: 3, failed: 1 }[status] ?? 1;
}

const cell = (value) => String(value).replace(/\|/g, "\|").replace(/\r?\n/g, " ");

function notesFor(source) {
  const notes = [];
  if (source.tied_with.length > 0) notes.push(`tie with ${source.tied_with.join(", ")}`);
  if (source.recency === "retrieval_fallback") notes.push("retrieval fallback (fetch time, not data time)");
  if (source.recency === "unknown") notes.push("unknown recency (no usable timestamp)");
  if (source.age_days !== null && source.age_days < 0) notes.push("future timestamp");
  if (source.invalid_timestamp_count > 0) {
    notes.push(`${source.invalid_timestamp_count} invalid timestamp(s) ignored`);
  }
  return notes.join("; ") || "-";
}

function renderMarkdown(result) {
  const { data } = result;
  const lines = [
    `# Source recency ranking: ${data.account_id}`,
    "",
    `As of ${data.now}. Status: ${result.status}.`,
    "",
    "Recency ordering only: sources are ordered by how recent their data is. This is not a",
    "reliability, authority or quality judgement.",
    "",
    "| Rank | Source | Latest data timestamp | Field | Age (days) | Notes |",
    "| ---: | --- | --- | --- | ---: | --- |",
  ];
  for (const source of data.sources) {
    lines.push(
      `| ${source.rank ?? "-"} | ${cell(source.source_id)} | ${source.latest_data_at ?? "unknown"} | ` +
        `${source.latest_data_at_field ?? "-"} | ${source.age_days ?? "-"} | ${cell(notesFor(source))} |`,
    );
  }
  lines.push("", "## Warnings", "");
  if (result.warnings.length === 0) lines.push("None.");
  for (const warning of result.warnings) lines.push(`- ${warning.code}: ${warning.message}`);
  if (result.errors.length > 0) {
    lines.push("", "## Errors", "");
    for (const error of result.errors) lines.push(`- ${error.code}: ${error.message}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  let input;
  try {
    const fixtureUrl = new URL(`../fixtures/${options.fixture}/input.json`, import.meta.url);
    input = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  } catch {
    process.stderr.write("The selected source-rank fixture could not be loaded.\n");
    process.exitCode = 1;
    return;
  }
  if (options.account !== undefined) input.account_id = options.account;
  if (options.now !== undefined) input.now = options.now;

  let result;
  try {
    result = rankSources(input);
  } catch {
    process.stderr.write("Skill failed before producing a valid result.\n");
    process.exitCode = 1;
    return;
  }

  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    emitDiagnostics(result);
  } else if (result.data && ["success", "partial"].includes(result.status)) {
    process.stdout.write(renderMarkdown(result));
    emitDiagnostics(result);
  } else {
    const code = result.errors[0]?.code ?? result.status.toUpperCase();
    process.stderr.write(`Skill ${result.status}: ${code}. No ranking was produced.\n`);
    emitDiagnostics(result);
  }

  process.exitCode = exitCode(result.status);
}

await main();
