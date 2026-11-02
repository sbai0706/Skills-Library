#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { runOpportunityStrategy } from "../workflows/opportunity-strategy/index.js";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";

const FIXTURES = new Set(["northstar-example"]);
const HELP = `Usage: npm run opportunity-strategy -- --fixture northstar-example [options]

Development and demonstration interface. Uses local fixture adapters and a caller-supplied
qualification-result fixture; no live systems or model.

Options:
  --fixture NAME   Bundled opportunity-strategy fixture (default: northstar-example)
  --output FORMAT  json or markdown (default: json)
  --help           Show this help

Exit codes: 0 success, 2 partial with artifact, 3 blocked, 1 failed/invalid invocation.
`;

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set(["--fixture", "--output"]);
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

  const fixture = parsed["--fixture"] ?? "northstar-example";
  if (!FIXTURES.has(fixture)) throw new Error("Unknown fixture. Choose northstar-example.");
  const output = parsed["--output"] ?? "json";
  if (!new Set(["json", "markdown"]).has(output)) {
    throw new Error("--output must be json or markdown.");
  }
  return { help: false, fixture, output };
}

function emitDiagnostics(result) {
  for (const diagnostic of [...result.warnings, ...result.errors]) {
    process.stderr.write(`${diagnostic.step}: ${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

function exitCode(status) {
  return { success: 0, partial: 2, blocked: 3, failed: 1 }[status] ?? 1;
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
    const fixtureUrl = new URL(
      `../fixtures/opportunity-strategy/${options.fixture}.json`,
      import.meta.url,
    );
    input = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  } catch {
    process.stderr.write("The selected opportunity-strategy fixture could not be loaded.\n");
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await runOpportunityStrategy(input, {
      accountAdapter: createFixtureAccountAdapter({ fixture: "workflow-first-meeting-success" }),
      evidenceAdapter: createFixtureEvidenceAdapter({ fixture: "workflow-first-meeting-success" }),
      claimExtractor: createFixtureClaimExtractor(),
    });
  } catch {
    process.stderr.write("Workflow failed before producing a valid result.\n");
    process.exitCode = 1;
    return;
  }

  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    emitDiagnostics(result);
  } else if (result.artifact && ["success", "partial"].includes(result.status)) {
    process.stdout.write(result.artifact.markdown);
    emitDiagnostics(result);
  } else {
    const code = result.errors[0]?.code ?? result.status.toUpperCase();
    process.stderr.write(`Workflow ${result.status}: ${code}. No artifact was produced.\n`);
    emitDiagnostics(result);
  }

  process.exitCode = exitCode(result.status);
}

await main();
