#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCapture, canonicalize } from "../adapters/mcp/index.js";
import { accountSearchPlan, evidencePlan, parseSfAccountId, SF_TOOL } from "../adapters/salesforce/index.js";
import { toSearchTerm } from "../skills/account-resolve/search.js";

const HELP = `Usage: npm run salesforce-capture-plan -- <mode> [options]

Prints the exact read-only Salesforce connector calls a host agent must make and record so the
capture-mode CLIs (--source capture) can replay them. The host calls ONLY the printed
dispatch_readonly args, verbatim; never hand-written SOQL, never dispatch/describe/discover.
This tool makes no network call and never reads Salesforce data.

Modes:
  --account VALUE          Phase 1: account search calls for a name, domain or sf_<Id> reference
  --account-id sf_<Id>     Phase 2: evidence calls for a resolved Salesforce Account Id
  --init-capture PATH      Write an empty valid capture skeleton (needs --source-system salesforce;
                           refuses to overwrite; keep it under .captures/, which is git-ignored)
  --validate PATH          Validate a finished capture (schema, limits, read-only tools only) and
                           print a payload-free summary; add --account and/or --account-id to also
                           check that the planned calls are present
  --source-system VALUE    Only with --init-capture; must be salesforce
  --help                   Show this help

Output is JSON on stdout. Exit codes: 0 ok, 1 invalid usage or validation problems.
`;

const HOST_RULES = [
  "Call only the Salesforce connector tool dispatch_readonly, with exactly the printed args. Never call dispatch, describe or discover for this workflow and never write SOQL by hand.",
  "Record every call's raw result (success or error payload, unmodified) as one capture entry {tool, args, result|error, captured_at}, in call order.",
  "On a 401 with INVALID_AUTH_HEADER, retry the identical call once and record only the final attempt.",
  "If a result has done:false, immediately also call {url: <nextRecordsUrl>, method: \"GET\"} and record that page; repeat until done.",
  "Raw captures may contain real customer data: keep them under .captures/ (git-ignored), never commit them and never paste raw content into chat.",
];

const MODES = ["--account", "--account-id", "--init-capture", "--validate"];

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([...MODES, "--source-system"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    if (Object.hasOwn(parsed, option)) throw new Error(`Option may only be provided once: ${option}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    parsed[option] = value;
    index += 1;
  }
  const modes = MODES.filter((flag) => Object.hasOwn(parsed, flag));
  if (modes.length === 0) throw new Error("Choose a mode: --account, --account-id, --init-capture or --validate.");
  const only = (flag) => modes.length === 1 && modes[0] === flag;
  const validateWithPlan = modes.includes("--validate") && modes.every((flag) => ["--validate", "--account", "--account-id"].includes(flag));
  if (modes.length > 1 && !validateWithPlan) {
    throw new Error("Modes cannot be combined, except --validate with --account and/or --account-id.");
  }
  for (const flag of modes) {
    if (parsed[flag].trim() === "") throw new Error(`Missing value for ${flag}`);
  }
  if (Object.hasOwn(parsed, "--source-system") && !only("--init-capture")) {
    throw new Error("--source-system is only valid with --init-capture.");
  }
  if (only("--init-capture")) {
    if (parsed["--source-system"] !== "salesforce") throw new Error("--init-capture requires --source-system salesforce.");
  }
  if (Object.hasOwn(parsed, "--account-id") && !parseSfAccountId(parsed["--account-id"].trim())) {
    throw new Error("--account-id must be sf_ followed by the 18-character Salesforce Account Id.");
  }
  return { help: false, parsed };
}

function callList(plan) {
  return plan.calls.map(({ step, kind, condition, args }) => ({
    step,
    ...(kind ? { kind } : {}),
    ...(condition ? { condition } : {}),
    tool: SF_TOOL,
    args,
  }));
}

function buildPhase1(reference) {
  const plan = accountSearchPlan(toSearchTerm(reference));
  const note = plan.calls.length === 0
    ? "No call is needed: an empty term or malformed sf_ reference matches nothing, so the CLI reports the account as not found."
    : "Record this phase, then run the CLI. If the account is ambiguous or needs confirmation, ask the user to choose and re-run Phase 1 with that sf_<Id> reference; then capture Phase 2 for the chosen sf_<Id> with --account-id.";
  return {
    phase: plan.phase,
    term: plan.term,
    calls: callList(plan),
    pagination: plan.pagination,
    note,
    host_rules: HOST_RULES,
  };
}

function buildPhase2(accountId) {
  const plan = evidencePlan(accountId);
  return {
    phase: plan.phase,
    account_id: plan.account_id,
    calls: callList(plan),
    pagination: plan.pagination,
    note: "Make all five calls in this order (Event is always queried; zero rows is a valid result). A single capture file may hold Phase 1 and Phase 2 entries; keep them in call order.",
    host_rules: HOST_RULES,
  };
}

function initCapture(path) {
  const target = resolve(path);
  const doc = {
    format_version: "mcp-capture/1",
    capture: {
      created_at: new Date().toISOString(),
      source_system: "salesforce",
      connector: "Salesforce connector (dispatch_readonly)",
    },
    entries: [],
  };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx" });
  return { initialized: target, entries: 0, note: "Append one entry per recorded call, in call order, then run --validate." };
}

function queryObject(args) {
  const soql = args?.queryParams?.q;
  const match = typeof soql === "string" ? /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(soql) : null;
  return match ? match[1] : args?.queryParams === undefined ? "page" : "other";
}

/** Payload-free summary. Never prints SOQL, args or results. */
function validateCapture(path, { account, accountId }) {
  const problems = [];
  let client;
  try {
    client = loadCapture(resolve(path));
  } catch (cause) {
    return { valid: false, problems: [`${cause?.code ?? "CAPTURE_UNREADABLE"}: ${cause?.message ?? "capture could not be loaded"}`] };
  }
  const entries = client.entries;
  const byTool = {};
  const byObject = {};
  let recordedErrors = 0;
  entries.forEach((entry, index) => {
    byTool[entry.tool] = (byTool[entry.tool] ?? 0) + 1;
    if (entry.tool !== SF_TOOL) problems.push(`entry ${index}: tool ${entry.tool} is not allowed; only ${SF_TOOL} may be captured.`);
    if (entry.args?.method !== "GET") problems.push(`entry ${index}: method must be GET.`);
    const object = queryObject(entry.args);
    byObject[object] = (byObject[object] ?? 0) + 1;
    if (entry.error !== undefined) recordedErrors += 1;
  });
  const planned = [];
  if (account !== undefined) planned.push(...accountSearchPlan(toSearchTerm(account)).calls.filter((call) => call.step === "search").map((call) => ({ phase: "account_search", step: call.step, args: call.args })));
  if (accountId !== undefined) planned.push(...evidencePlan(accountId).calls.map((call) => ({ phase: "evidence", step: call.step, args: call.args })));
  const have = new Set(entries.map((entry) => `${entry.tool}\u0000${canonicalize(entry.args)}`));
  const missing = planned.filter((call) => !have.has(`${SF_TOOL}\u0000${canonicalize(call.args)}`)).map(({ phase, step }) => ({ phase, step }));
  for (const gap of missing) problems.push(`missing planned call: ${gap.phase}/${gap.step}.`);
  return {
    valid: problems.length === 0,
    source_system: client.capture.source_system,
    created_at: client.capture.created_at,
    entries: entries.length,
    recorded_errors: recordedErrors,
    entries_by_tool: byTool,
    queries_by_object: byObject,
    ...(planned.length > 0 ? { planned_calls_checked: planned.length } : {}),
    problems,
  };
}

function main() {
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
  const { parsed } = options;
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (Object.hasOwn(parsed, "--validate")) {
    const summary = validateCapture(parsed["--validate"], {
      account: parsed["--account"]?.trim(),
      accountId: parsed["--account-id"]?.trim(),
    });
    print(summary);
    if (!summary.valid) process.exitCode = 1;
    return;
  }
  if (Object.hasOwn(parsed, "--init-capture")) {
    try {
      print(initCapture(parsed["--init-capture"]));
    } catch (error) {
      process.stderr.write(error?.code === "EEXIST"
        ? "The capture file already exists; refusing to overwrite it.\n"
        : "The capture skeleton could not be written.\n");
      process.exitCode = 1;
    }
    return;
  }
  print(Object.hasOwn(parsed, "--account") ? buildPhase1(parsed["--account"]) : buildPhase2(parsed["--account-id"].trim()));
}

main();
