#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { prepareEngagement } from "../workflows/prepare-engagement/index.js";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";
import { captureExitCode, createCaptureSession, resolveSourceOptions } from "../cli/capture-mode.js";

const DEFAULT_FIXTURE = "engagement-initial";
const FIXTURES = new Set([
  "engagement-initial",
  "engagement-follow-up",
  "engagement-sparse",
  "engagement-empty",
  "engagement-conflicting",
]);

const HELP = `Usage: npm run prepare-engagement -- [options]

Fixture-only Engagement workflow by default; no live systems, message sending, or CRM writes.
With --source capture it replays a host-recorded Salesforce capture for an initial
draft (structured CRM claims only, no annotations or claim references) and never falls back
to fixtures.

Options:
  --fixture NAME       engagement-* fixture (default: ${DEFAULT_FIXTURE})
  --account VALUE      Override the fixture account reference
  --mode VALUE         initial or follow_up
  --classification     public, internal, or confidential
  --tone VALUE         neutral, concise, formal, or warm
  --source MODE        fixture (default) or capture
  --capture PATH       Salesforce capture file (required with, and only valid with,
                       --source capture, which also requires --account and mode initial;
                       keep raw captures under .captures/)
  --output FORMAT      json or markdown (default: json)
  --help               Show this help

Exit codes: 0 success, 2 partial with draft, 3 blocked, 1 failed/invalid invocation.
`;

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([
    "--fixture",
    "--account",
    "--mode",
    "--classification",
    "--tone",
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

  const fixture = parsed["--fixture"] ?? DEFAULT_FIXTURE;
  if (!FIXTURES.has(fixture)) throw new Error("Unknown Engagement fixture.");
  if (parsed["--mode"] !== undefined && !["initial", "follow_up"].includes(parsed["--mode"])) {
    throw new Error("--mode must be initial or follow_up.");
  }
  if (parsed["--classification"] !== undefined &&
      !["public", "internal", "confidential"].includes(parsed["--classification"])) {
    throw new Error("--classification must be public, internal, or confidential.");
  }
  if (parsed["--tone"] !== undefined &&
      !["neutral", "concise", "formal", "warm"].includes(parsed["--tone"])) {
    throw new Error("--tone must be neutral, concise, formal, or warm.");
  }
  const output = parsed["--output"] ?? "json";
  if (!["json", "markdown"].includes(output)) {
    throw new Error("--output must be json or markdown.");
  }
  const sourceOptions = resolveSourceOptions(parsed, {
    incompatible: [
      ["--fixture", "capture mode reads the account and evidence from the capture, not a bundled fixture"],
    ],
  });
  if (sourceOptions.source === "capture") {
    if (!parsed["--account"]?.trim()) throw new Error("--account is required with --source capture.");
    if (parsed["--mode"] === "follow_up") {
      throw new Error("--mode follow_up cannot be used with --source capture: follow-up needs caller-supplied evidence claim IDs that a live capture cannot provide.");
    }
  }
  return {
    help: false,
    ...sourceOptions,
    fixture,
    output,
    ...(parsed["--account"] !== undefined ? { account: parsed["--account"] } : {}),
    ...(parsed["--mode"] !== undefined ? { mode: parsed["--mode"] } : {}),
    ...(parsed["--classification"] !== undefined ? { classification: parsed["--classification"] } : {}),
    ...(parsed["--tone"] !== undefined ? { tone: parsed["--tone"] } : {}),
  };
}

function exitCode(status) {
  return { success: 0, partial: 2, blocked: 3, failed: 1 }[status] ?? 1;
}

function writeDiagnostics(result) {
  for (const diagnostic of [...result.warnings, ...result.errors]) {
    process.stderr.write(`${diagnostic.step}: ${diagnostic.code}: ${diagnostic.message}\n`);
  }
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
    input = {
      mode: "initial",
      workflow_input: { account_reference: options.account.trim(), requested_sources: ["crm"] },
    };
  } else {
    try {
      input = JSON.parse(readFileSync(
        new URL(`../fixtures/${options.fixture}/input.json`, import.meta.url),
        "utf8",
      ));
    } catch {
      process.stderr.write("The selected Engagement fixture input could not be loaded.\n");
      process.exitCode = 1;
      return;
    }
    deps = {
      accountAdapter: createFixtureAccountAdapter({ fixture: "workflow-first-meeting-success" }),
      evidenceAdapter: createFixtureEvidenceAdapter({ fixture: options.fixture }),
      claimExtractor: createFixtureClaimExtractor(),
    };
  }
  if (options.source === "fixture" && options.account !== undefined) {
    input.workflow_input.account_reference = options.account;
  }
  if (options.mode !== undefined) input.mode = options.mode;
  if (options.classification !== undefined) {
    input.workflow_input.classification_ceiling = options.classification;
  }
  if (options.tone !== undefined) {
    input.messaging_guidance ??= {};
    input.messaging_guidance.tone = options.tone;
  }

  let result;
  try {
    result = await prepareEngagement(input, deps);
  } catch {
    process.stderr.write("Workflow failed before producing a valid result.\n");
    process.exitCode = 1;
    return;
  }

  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.artifact && ["success", "partial"].includes(result.status)) {
    process.stdout.write(result.artifact.markdown);
  } else {
    const code = result.errors[0]?.code ?? result.status.toUpperCase();
    process.stderr.write(`Workflow ${result.status}: ${code}. No draft artifact was produced.\n`);
  }
  writeDiagnostics(result);
  process.exitCode = captureExitCode(exitCode(result.status), session);
}

await main();
