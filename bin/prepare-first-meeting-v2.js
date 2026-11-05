#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { prepareFirstMeetingV2 } from "../workflows/prepare-first-meeting-v2/index.js";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";
import {
  assertCaptureSources, captureExitCode, createCaptureSession, resolveSourceOptions,
} from "../cli/capture-mode.js";

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
const MAPPING_FIXTURES = new Set(["none", "northstar-example"]);

const HELP = `Usage: npm run prepare-first-meeting-v2 -- --account NAME [options]

Development and demonstration interface. By default uses local fixture adapters, a deterministic
fixture claim extractor, and optional explicit annotation fixtures; no live systems or model.
With --source capture it replays a host-recorded Salesforce capture (CRM data, structured-field
claims, no annotations) and never falls back to fixtures.

Options:
  --account VALUE          Required account reference
  --sources LIST           Comma-separated sources (default: crm,public_source)
  --classification VALUE   Output ceiling: public, internal, confidential (default: internal)
  --template VALUE         Renderer template (default: first-meeting-brief-v1)
  --audience VALUE         internal_sales, executive, or customer (default: internal_sales)
  --fixture NAME           workflow-first-meeting-* fixture (default: ${DEFAULT_FIXTURE})
  --mapping-fixture NAME   none or northstar-example (default: none)
  --source MODE            fixture (default) or capture
  --capture PATH           Salesforce capture file (required with, and only valid with,
                           --source capture; keep raw captures under .captures/)
  --output FORMAT          json or markdown (default: json)
  --help                   Show this help

Exit codes: 0 success, 2 partial with artifact, 3 blocked, 1 failed/invalid invocation.
`;

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([
    "--account",
    "--sources",
    "--classification",
    "--template",
    "--audience",
    "--fixture",
    "--mapping-fixture",
    "--output",
    "--source",
    "--capture",
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
  if (!parsed["--account"]?.trim()) throw new Error("--account is required.");

  const output = parsed["--output"] ?? "json";
  if (!new Set(["json", "markdown"]).has(output)) {
    throw new Error("--output must be json or markdown.");
  }
  const fixture = parsed["--fixture"] ?? DEFAULT_FIXTURE;
  if (!WORKFLOW_FIXTURES.has(fixture)) {
    throw new Error("Unknown fixture. Choose a documented workflow-first-meeting fixture.");
  }
  const mappingFixture = parsed["--mapping-fixture"] ?? "none";
  if (!MAPPING_FIXTURES.has(mappingFixture)) {
    throw new Error("Unknown mapping fixture. Choose none or northstar-example.");
  }

  let sources;
  if (parsed["--sources"] !== undefined) {
    sources = parsed["--sources"].split(",").map((source) => source.trim());
    if (sources.length === 0 || sources.some((source) => source === "")) {
      throw new Error("--sources must be a comma-separated list of source IDs.");
    }
  }

  const sourceOptions = resolveSourceOptions(parsed, {
    incompatible: [
      ["--fixture", "capture mode reads the account and evidence from the capture, not a bundled fixture"],
      ["--mapping-fixture", "annotation fixtures reference fixture evidence IDs; capture mode uses the no-mapping path"],
    ],
  });
  if (sourceOptions.source === "capture") assertCaptureSources(sources);

  return {
    help: false,
    ...sourceOptions,
    account: parsed["--account"].trim(),
    ...(sources ? { sources } : {}),
    ...(Object.hasOwn(parsed, "--classification") ? { classification: parsed["--classification"] } : {}),
    ...(Object.hasOwn(parsed, "--template") ? { template: parsed["--template"] } : {}),
    ...(Object.hasOwn(parsed, "--audience") ? { audience: parsed["--audience"] } : {}),
    fixture,
    mappingFixture,
    output,
  };
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

  const workflowInput = {
    account_reference: options.account,
    ...(options.sources ? { requested_sources: options.sources } : {}),
    ...(Object.hasOwn(options, "classification") ? { classification_ceiling: options.classification } : {}),
    ...(Object.hasOwn(options, "template") ? { template_id: options.template } : {}),
    ...(Object.hasOwn(options, "audience") ? { audience: options.audience } : {}),
  };
  let annotations = { signals: [], stakeholders: [], offerings: [] };
  if (options.mappingFixture !== "none") {
    try {
      const fixtureUrl = new URL(
        `../fixtures/account-intelligence-v2/${options.mappingFixture}.json`,
        import.meta.url,
      );
      annotations = JSON.parse(readFileSync(fixtureUrl, "utf8"));
    } catch {
      process.stderr.write("The selected mapping fixture could not be loaded.\n");
      process.exitCode = 1;
      return;
    }
  }

  let session;
  let deps;
  if (options.source === "capture") {
    try {
      session = createCaptureSession(options.capturePath);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    deps = session.deps;
    workflowInput.requested_sources ??= ["crm"];
  } else {
    deps = {
      accountAdapter: createFixtureAccountAdapter({ fixture: options.fixture }),
      evidenceAdapter: createFixtureEvidenceAdapter({ fixture: options.fixture }),
      claimExtractor: createFixtureClaimExtractor(),
    };
  }

  let result;
  try {
    result = await prepareFirstMeetingV2({ workflow_input: workflowInput, annotations }, deps);
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

  process.exitCode = captureExitCode(exitCode(result.status), session);
}

await main();
