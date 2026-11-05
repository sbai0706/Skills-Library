#!/usr/bin/env node

import { resolve } from "node:path";
import { loadCapture, canonicalize, unwrapToolResult } from "../adapters/mcp/index.js";
import { warnIfNotGitIgnored } from "../cli/capture-mode.js";
import { CaptureFileUsageError, appendCaptureEntry, initCaptureFile, selectPlanStep } from "../cli/capture-files.js";
import { accountSearchPlan, evidencePlan, nextPageArgs, parseSfAccountId, SF_TOOL } from "../adapters/salesforce/index.js";
import { NEXT_URL } from "../adapters/salesforce/transport.js";
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
                           PATH must be a file under the repository .captures/ directory, which is
                           git-ignored; refuses to overwrite)
  --validate PATH          Validate a finished capture (schema, limits, read-only tools only) and
                           print a payload-free summary; add --account and/or --account-id to also
                           check that the planned calls are present
  --append PATH            Append ONE recorded call to the capture at PATH (an existing file under .captures/,
                           created with --init-capture). The tool and args come from the printed plan step,
                           never from you. Needs --result-file or --error-file, plus either
                           --step with exactly one of --account / --account-id (a plan call), or
                           --page-url (a page).
  --source-system VALUE    Only with --init-capture; must be salesforce
  --help                   Show this help

Append options (only with --append):
  --step STEP              The printed step name (search, exact_name_guard, Account, Opportunity, Contact,
                           Task, Event) or its 1-based position in the printed calls; with exactly one of
                           --account / --account-id, the same reference that printed the plan
  --page-url URL           A pagination page: the nextRecordsUrl of an earlier recorded result; the
                           call recorded is {url, method: "GET"}. Do not combine with --step
  --result-file PATH       The connector's raw response, verbatim, as a JSON file under .captures/
                           (for example .captures/tmp/r1.json); stored exactly as parsed
  --error-file PATH        The connector's raw error payload (a JSON object file under .captures/)
  --replace-last           Replace the last entry, which must be the same call (a retry's final attempt)
  --captured-at RFC3339    Override captured_at (tests); default is the time of the append

Append refuses (exit 1, nothing written, payload never printed): files outside .captures/, non-JSON
input, a result or error file with a duplicate key in any object, a capture with another source_system, a duplicate of the last entry without --replace-last,
and entries or files over the capture size limits. Output is a payload-free summary.

Output is JSON on stdout. Exit codes: 0 ok, 1 invalid usage or validation problems.
`;

const HOST_RULES = [
  "Call only the Salesforce connector tool dispatch_readonly, with exactly the printed args. Never call dispatch, describe or discover for this workflow and never write SOQL by hand.",
  "Record every call with --append, in call order: write the connector's raw response, unmodified, to a JSON file under .captures/ (for example .captures/tmp/r1.json), then run: npm run -s salesforce-capture-plan -- --append <capture path> --step <step> (--account <ref> | --account-id <sf_Id>) --result-file <file> (or --error-file <file> for an error payload). Never hand-write capture entries or captured_at.",
  "On a 401 with INVALID_AUTH_HEADER, retry the identical call once and append only the final attempt (if the failed attempt was already appended, append the retry with --replace-last).",
  "If a result has done:false, immediately also call {url: <nextRecordsUrl>, method: \"GET\"} and append that page with: --append <capture path> --page-url <nextRecordsUrl> --result-file <file>; repeat until done.",
  "Raw captures may contain real customer data: keep them under .captures/ (git-ignored), never commit them and never paste raw content into chat.",
];

const MODES = ["--account", "--account-id", "--init-capture", "--validate", "--append"];
const APPEND_OPTIONS = ["--step", "--page-url", "--result-file", "--error-file", "--replace-last", "--captured-at"];
const BOOLEAN_FLAGS = new Set(["--replace-last"]);

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([...MODES, "--source-system", ...APPEND_OPTIONS]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    if (Object.hasOwn(parsed, option)) throw new Error(`Option may only be provided once: ${option}`);
    if (BOOLEAN_FLAGS.has(option)) {
      parsed[option] = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    parsed[option] = value;
    index += 1;
  }
  const modes = MODES.filter((flag) => Object.hasOwn(parsed, flag));
  if (modes.length === 0) throw new Error("Choose a mode: --account, --account-id, --init-capture, --validate or --append.");
  const only = (flag) => modes.length === 1 && modes[0] === flag;
  const validateWithPlan = modes.includes("--validate") && modes.every((flag) => ["--validate", "--account", "--account-id"].includes(flag));
  const appendWithPlan = modes.includes("--append") && modes.every((flag) => ["--append", "--account", "--account-id"].includes(flag));
  if (modes.length > 1 && !validateWithPlan && !appendWithPlan) {
    throw new Error("Modes cannot be combined, except --validate or --append with --account and/or --account-id.");
  }
  for (const flag of [...modes, ...APPEND_OPTIONS, "--source-system"]) {
    if (Object.hasOwn(parsed, flag) && !BOOLEAN_FLAGS.has(flag) && parsed[flag].trim() === "") throw new Error(`Missing value for ${flag}`);
  }
  if (Object.hasOwn(parsed, "--source-system") && !only("--init-capture")) {
    throw new Error("--source-system is only valid with --init-capture.");
  }
  if (modes.includes("--append")) {
    if (Object.hasOwn(parsed, "--result-file") === Object.hasOwn(parsed, "--error-file")) {
      throw new Error("--append needs exactly one of --result-file and --error-file.");
    }
    if (Object.hasOwn(parsed, "--page-url")) {
      if (Object.hasOwn(parsed, "--step") || modes.length > 1) throw new Error("--page-url cannot be combined with --step, --account or --account-id.");
    } else {
      if (!Object.hasOwn(parsed, "--step")) throw new Error("--append needs --step (a plan call) or --page-url (a pagination page).");
      if (modes.length !== 2) throw new Error("--append --step needs exactly one of --account and --account-id (the reference that printed the plan).");
    }
  } else {
    for (const flag of APPEND_OPTIONS) {
      if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} is only valid with --append.`);
    }
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
  return initCaptureFile(path, { sourceSystem: "salesforce", connector: "Salesforce connector (dispatch_readonly)" });
}

function queryObject(args) {
  const soql = args?.queryParams?.q;
  const match = typeof soql === "string" ? /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(soql) : null;
  return match ? match[1] : args?.queryParams === undefined ? "page" : "other";
}

/** `nextRecordsUrl` of a successful result whose body says done:false, else null. */
function nextRecordsUrlOf(result) {
  const unwrapped = unwrapToolResult(result);
  if (!unwrapped.ok) return null;
  let body = unwrapped.payload;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return body && typeof body === "object" && body.done === false && typeof body.nextRecordsUrl === "string" ? body.nextRecordsUrl : null;
}

/** Payload-free summary. Never prints SOQL, args or results. */
function validateCapture(path, { account, accountId }) {
  const problems = [];
  let client;
  try {
    client = loadCapture(resolve(path));
    warnIfNotGitIgnored(resolve(path));
  } catch (cause) {
    return { valid: false, problems: [`${cause?.code ?? "CAPTURE_UNREADABLE"}: ${cause?.message ?? "capture could not be loaded"}`] };
  }
  const entries = client.entries;
  if (client.capture.source_system !== "salesforce") problems.push("capture.source_system must be salesforce.");
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
    const nextUrl = entry.result === undefined ? null : nextRecordsUrlOf(entry.result);
    if (nextUrl !== null) {
      const wanted = canonicalize(nextPageArgs(nextUrl));
      const hasPage = entries.slice(index + 1).some((later) =>
        later.tool === SF_TOOL && later.error === undefined && later.result !== undefined && canonicalize(later.args) === wanted);
      if (!hasPage) problems.push(`entry ${index}: missing pagination page.`);
    }
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

/** Counts only (rows, done flag); never row content. */
function resultCounts(result) {
  try {
    const unwrapped = unwrapToolResult(result);
    if (!unwrapped.ok) return { result_is_error: true };
    let body = unwrapped.payload;
    if (typeof body === "string") body = JSON.parse(body);
    if (body === null || typeof body !== "object") return { result_is_error: false };
    return {
      result_is_error: false,
      records: Array.isArray(body.records) ? body.records.length : null,
      total_size: Number.isInteger(body.totalSize) ? body.totalSize : null,
      done: typeof body.done === "boolean" ? body.done : null,
      next_page_pending: nextRecordsUrlOf(result) !== null,
    };
  } catch {
    return { result_is_error: null };
  }
}

/** Append one recorded call (a plan step or a pagination page). Payload-free summary. */
function appendEntry(parsed) {
  let step = null;
  let args;
  let checkPriorEntries;
  if (Object.hasOwn(parsed, "--page-url")) {
    const url = parsed["--page-url"].trim();
    if (!NEXT_URL.test(url)) {
      throw new CaptureFileUsageError("--page-url must be a Salesforce nextRecordsUrl of the form /services/data/vNN.N/query/<id>; nothing was changed.");
    }
    args = nextPageArgs(url);
    checkPriorEntries = (entries) => {
      const follows = entries.some((entry) => entry.tool === SF_TOOL && entry.result !== undefined && nextRecordsUrlOf(entry.result) === url);
      if (!follows) throw new CaptureFileUsageError("--page-url must be the nextRecordsUrl of an already recorded result with done:false, exactly as the connector returned it (in Git Bash on Windows set MSYS_NO_PATHCONV=1 so the leading / is not rewritten); nothing was changed.");
    };
  } else {
    const plan = Object.hasOwn(parsed, "--account")
      ? accountSearchPlan(toSearchTerm(parsed["--account"]))
      : evidencePlan(parsed["--account-id"].trim());
    const call = selectPlanStep(plan.calls, parsed["--step"]);
    step = call.step;
    args = call.args;
  }
  const done = appendCaptureEntry({
    capturePath: parsed["--append"],
    sourceSystem: "salesforce",
    tool: SF_TOOL,
    args,
    resultFile: parsed["--result-file"],
    errorFile: parsed["--error-file"],
    replaceLast: parsed["--replace-last"] === true,
    capturedAt: parsed["--captured-at"],
    checkPriorEntries,
  });
  return {
    appended: true,
    replaced_last: done.replaced,
    entry_index: done.entryIndex,
    entries: done.entries,
    tool: SF_TOOL,
    step: step ?? "page",
    object: queryObject(args),
    outcome: done.outcome,
    captured_at: done.capturedAt,
    ...(done.outcome === "result" ? resultCounts(done.value) : {}),
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
  if (Object.hasOwn(parsed, "--append")) {
    try {
      print(appendEntry(parsed));
    } catch (error) {
      process.stderr.write(error instanceof CaptureFileUsageError ? `${error.message}\n` : "The entry could not be appended; the capture file was not changed.\n");
      process.exitCode = 1;
    }
    return;
  }
  if (Object.hasOwn(parsed, "--init-capture")) {
    try {
      print(initCapture(parsed["--init-capture"]));
    } catch (error) {
      process.stderr.write(error instanceof CaptureFileUsageError ? `${error.message}\n`
        : error?.code === "EEXIST"
          ? "The capture file already exists; refusing to overwrite it.\n"
          : "The capture skeleton could not be written.\n");
      process.exitCode = 1;
    }
    return;
  }
  print(Object.hasOwn(parsed, "--account") ? buildPhase1(parsed["--account"]) : buildPhase2(parsed["--account-id"].trim()));
}

main();
