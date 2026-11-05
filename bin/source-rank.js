#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isValidAccountId } from "../adapters/m365/index.js";
import { parseSfAccountId } from "../adapters/salesforce/index.js";
import { captureExitCode, createCaptureSession, resolveSourceOptions } from "../cli/capture-mode.js";
import { retrieveEvidence } from "../skills/evidence-retrieve/index.js";
import { rankSources } from "../skills/source-rank/index.js";
import { parseTimestamp } from "../skills/source-rank/timestamps.js";
import { loadDefaultQuestions } from "../workflows/prepare-first-meeting/reference.js";

const DEFAULT_FIXTURE = "source-rank-recency";
const FIXTURES = new Set([DEFAULT_FIXTURE]);

/** Access ceiling -> permitted classifications for evidence.retrieve (capture mode). */
const CEILINGS = Object.freeze({
  public: ["public"],
  internal: ["public", "internal"],
  confidential: ["public", "internal", "confidential"],
});

const HELP = `Usage: npm run source-rank -- [options]

Development and demonstration interface. Ranks the sources of one account by data recency
only, from a local fixture by default; it does not connect to live systems and makes no
reliability, authority or quality judgement. With --source capture it ranks the sources found in
host-recorded captures (Salesforce, optionally M365 SharePoint) instead; it never queries any
system itself and never falls back to the fixture.

Options:
  --fixture NAME   Bundled source-rank fixture (default: ${DEFAULT_FIXTURE}; fixture mode only)
  --account VALUE  Account ID to rank for; items of other accounts are excluded
                   (default: the fixture's account_id). Required with --source capture and must
                   be a resolved id: sf_<18-character Salesforce Id> (acct_<id> with only M365)
  --now VALUE      RFC 3339 date-time with an explicit offset, used as the clock
                   (default: the fixture's now; in capture mode the latest capture time)
  --source MODE    fixture (default) or capture
  --capture PATH   Salesforce capture file (capture mode; keep raw captures under .captures/)
  --capture-m365 PATH
                   M365 SharePoint capture file (capture mode; needs the mapping file below)
  --m365-mapping PATH
                   Account-to-SharePoint mapping (only with --capture-m365;
                   default local/m365-account-mapping.yaml, git-ignored)
  --classification VALUE
                   Access ceiling for retrieved records in capture mode: public, internal,
                   confidential (default: internal; capture mode only)
  --output FORMAT  json or markdown (default: json)
  --help           Show this help

Exit codes: 0 success, 2 partial with data, 3 blocked, 1 failed/invalid invocation.
`;

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([
    "--fixture", "--account", "--now", "--output", "--source", "--capture", "--capture-m365", "--m365-mapping", "--classification",
  ]);
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
  const sourceOptions = resolveSourceOptions(parsed, {
    salesforceOptional: true,
    incompatible: [["--fixture", "capture mode reads the evidence from the capture, not a bundled fixture"]],
  });
  const classification = parsed["--classification"] ?? "internal";
  if (!Object.hasOwn(CEILINGS, classification)) throw new Error("--classification must be public, internal or confidential.");
  if (sourceOptions.source === "fixture" && Object.hasOwn(parsed, "--classification")) {
    throw new Error("--classification requires --source capture.");
  }
  if (sourceOptions.source === "capture") {
    const account = parsed["--account"]?.trim();
    if (!account) throw new Error("--account is required with --source capture.");
    const resolved = sourceOptions.capturePath !== undefined ? parseSfAccountId(account) !== null : isValidAccountId(account);
    if (!resolved) {
      throw new Error("--account must be a resolved account id: sf_ followed by the 18-character Salesforce Id"
        + (sourceOptions.capturePath === undefined ? " (or a mapped acct_ id)." : "."));
    }
  }
  return {
    help: false,
    fixture,
    output,
    ...sourceOptions,
    classification,
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

  if (options.source === "capture") {
    await runCapture(options);
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

  present(result, options.output);
  process.exitCode = exitCode(result.status);
}

function present(result, output) {
  if (output === "json") {
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
}

const uniqueCodes = (items) => [...new Set(items.map((item) => item.code))].join(",");

/** Capture mode: retrieve from the captures, then rank the retrieved records by data recency. */
async function runCapture(options) {
  let session;
  try {
    session = createCaptureSession(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  let retrieval;
  try {
    retrieval = await retrieveEvidence(
      {
        account_id: options.account,
        questions: loadDefaultQuestions().questions.map((question) => ({ id: question.id, text: question.text })),
        requested_sources: session.defaultSources,
        context: { permitted_classifications: CEILINGS[options.classification] },
      },
      { adapter: session.deps.evidenceAdapter },
    );
  } catch {
    process.stderr.write("Evidence retrieval failed before producing a valid result.\n");
    process.exitCode = 1;
    return;
  }
  for (const issue of [...retrieval.warnings, ...retrieval.errors]) {
    const source = issue.details?.source ? ` (source ${issue.details.source})` : "";
    process.stderr.write(`evidence.retrieve: ${issue.code}${source}\n`);
  }
  if (retrieval.status === "failed" || retrieval.status === "blocked") {
    const label = retrieval.status === "failed" ? "RETRIEVAL_FAILED" : "RETRIEVAL_BLOCKED";
    process.stderr.write(`source.rank: ${label}: ${uniqueCodes(retrieval.errors)}\n`);
    process.exitCode = captureExitCode(retrieval.status === "failed" ? 1 : 3, session);
    return;
  }

  let result;
  try {
    result = rankSources({ account_id: options.account, records: retrieval.data.records, now: options.now ?? session.latestCreatedAt });
  } catch {
    process.stderr.write("Skill failed before producing a valid result.\n");
    process.exitCode = captureExitCode(1, session);
    return;
  }
  present(result, options.output);
  let code = exitCode(result.status);
  if (retrieval.status === "partial") {
    process.stderr.write("source.rank: PARTIAL_SOURCES: at least one requested source did not return usable records; the ranking covers the remaining sources only.\n");
    if (code === 0) code = 2;
  }
  process.exitCode = captureExitCode(code, session);
}

await main();
