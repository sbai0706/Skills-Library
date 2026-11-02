#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { runQualification } from "../workflows/qualification/index.js";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";

const DEFAULT_FIXTURE = "workflow-first-meeting-success";
const WORKFLOW_FIXTURES = new Set([
  "workflow-first-meeting-success",
  "workflow-first-meeting-ambiguous",
  "workflow-first-meeting-fuzzy-confirmation",
  "workflow-first-meeting-missing-account",
  "workflow-first-meeting-sparse",
  "workflow-first-meeting-partial-source-failure",
  "workflow-first-meeting-normalization-rejection",
  "workflow-first-meeting-conflicted",
  "workflow-first-meeting-classification-filtered",
  "workflow-first-meeting-retrieval-failure",
  "workflow-first-meeting-renderer-failure",
]);
const ASSESSMENT_FIXTURES = new Set(["none", "northstar-provisional"]);

const HELP = `Usage: npm run qualification -- --account NAME [options]

Deterministic fixture-only workflow. No model, network, or CRM actions.

Options:
  --account VALUE             Required account reference
  --sources LIST              Comma-separated sources (default: crm,public_source)
  --classification VALUE      Output ceiling: public, internal, confidential (default: internal)
  --fixture NAME              workflow-first-meeting-* fixture (default: ${DEFAULT_FIXTURE})
  --assessment-fixture NAME   none or northstar-provisional (default: none)
  --output FORMAT             json or markdown (default: json)
  --help                      Show this help

The provisional assessment fixture is illustrative input, not approved policy.
`;

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([
    "--account",
    "--sources",
    "--classification",
    "--fixture",
    "--assessment-fixture",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (Object.hasOwn(parsed, option)) throw new Error(`Option may only be provided once: ${option}`);
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    parsed[option] = value;
    index += 1;
  }
  if (!parsed["--account"]?.trim()) throw new Error("--account is required.");

  const output = parsed["--output"] ?? "json";
  if (!new Set(["json", "markdown"]).has(output)) {
    throw new Error("--output must be json or markdown.");
  }
  const fixture = parsed["--fixture"] ?? DEFAULT_FIXTURE;
  if (!WORKFLOW_FIXTURES.has(fixture)) throw new Error("Unknown workflow fixture.");
  const assessmentFixture = parsed["--assessment-fixture"] ?? "none";
  if (!ASSESSMENT_FIXTURES.has(assessmentFixture)) throw new Error("Unknown assessment fixture.");

  let sources;
  if (parsed["--sources"] !== undefined) {
    sources = parsed["--sources"].split(",").map((source) => source.trim());
    if (sources.length === 0 || sources.some((source) => source === "")) {
      throw new Error("--sources must be a comma-separated list of source IDs.");
    }
  }

  return {
    help: false,
    account: parsed["--account"].trim(),
    ...(sources ? { sources } : {}),
    ...(Object.hasOwn(parsed, "--classification") ? { classification: parsed["--classification"] } : {}),
    fixture,
    assessmentFixture,
    output,
  };
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

  const workflowInput = {
    account_reference: options.account,
    ...(options.sources ? { requested_sources: options.sources } : {}),
    ...(Object.hasOwn(options, "classification") ? { classification_ceiling: options.classification } : {}),
  };
  let assessmentMapping = {};
  if (options.assessmentFixture !== "none") {
    try {
      assessmentMapping = JSON.parse(readFileSync(
        new URL(`../fixtures/qualification-event/${options.assessmentFixture}.json`, import.meta.url),
        "utf8",
      ));
    } catch {
      process.stderr.write("The selected assessment fixture could not be loaded.\n");
      process.exitCode = 1;
      return;
    }
  }

  let result;
  try {
    result = await runQualification(
      { workflow_input: workflowInput, ...assessmentMapping },
      {
        accountAdapter: createFixtureAccountAdapter({ fixture: options.fixture }),
        evidenceAdapter: createFixtureEvidenceAdapter({ fixture: options.fixture }),
        claimExtractor: createFixtureClaimExtractor(),
      },
    );
  } catch {
    process.stderr.write("Qualification workflow failed before producing a valid result.\n");
    process.exitCode = 1;
    return;
  }

  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.artifact && ["success", "partial"].includes(result.status)) {
    process.stdout.write(result.artifact.markdown);
  } else {
    process.stderr.write(`Workflow ${result.status}. No artifact was produced.\n`);
  }
  for (const diagnostic of [...result.warnings, ...result.errors]) {
    process.stderr.write(`${diagnostic.step}: ${diagnostic.code}: ${diagnostic.message}\n`);
  }
  process.exitCode = exitCode(result.status);
}

await main();
