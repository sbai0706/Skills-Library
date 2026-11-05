#!/usr/bin/env node

import { resolve } from "node:path";
import { canonicalize, loadCapture } from "../adapters/mcp/index.js";
import {
  M365MappingError, M365_REDACT, M365_TOOL, MAX_OFFSET, MAX_PAGES_PER_SEARCH, PAGE_LIMIT, SEARCH_QUERY,
  isValidAccountId, loadM365AccountMapping, parseSearchResult, sharepointSearchPlan,
} from "../adapters/m365/index.js";
import { CaptureFileUsageError, initCaptureFile } from "../cli/capture-files.js";
import { DEFAULT_M365_MAPPING_FILE, warnIfNotGitIgnored } from "../cli/capture-mode.js";

const HELP = `Usage: npm run m365-capture-plan -- <mode> [options]

Prints the exact read-only Microsoft 365 connector calls (sharepoint_search only) a host agent
must make and record so the capture-mode CLIs (--capture-m365) can replay them. The host calls
ONLY the printed args, verbatim; never read_resource, sharepoint_folder_search or any
write/send/create/move/delete/upload tool. This tool makes no network call and never reads
Microsoft 365 data. Its plan output contains folder names from your local mapping: never paste it
into chat.

Modes:
  --account-id ID          Plan the SharePoint search calls for a resolved account id (sf_<Id>);
                           unmapped accounts need no call
  --init-capture PATH      Write an empty valid M365 capture skeleton (PATH must be a file under
                           the repository .captures/ directory; refuses to overwrite)
  --validate PATH          Validate a finished M365 capture (schema, limits, sharepoint_search only,
                           pagination) and print a payload-free summary; add --account-id to also
                           check that the planned page-1 calls are present
  --check-mapping          Validate the account-to-SharePoint mapping file; prints counts only
  --m365-mapping PATH      Mapping file (default: local/m365-account-mapping.yaml, git-ignored);
                           valid with --account-id, --validate with --account-id, --check-mapping
  --help                   Show this help

Output is JSON on stdout. Exit codes: 0 ok, 1 invalid usage or validation problems.
`;

const HOST_RULES = [
  `Call only the Microsoft 365 connector tool ${M365_TOOL}, with exactly the printed args. Never call read_resource, sharepoint_folder_search or any write/send/create/move/delete/upload tool for this workflow; never add filters or change query.`,
  "Record every call's raw result as {\"content\":[{\"type\":\"text\",\"text\":\"<item JSON verbatim>\"}, ..., {\"type\":\"text\",\"text\":\"<trailer JSON verbatim>\"}]} (an empty result as {\"content\":[]}), or a tool error as \"error\": {code, message, details} exactly as returned, in a capture entry {tool, args, result|error, captured_at}, in call order.",
  `Follow nextOffset while the trailer has moreResults:true, up to ${MAX_PAGES_PER_SEARCH} pages per search.`,
  "On a rate-limit error wait graphRetryAfterSeconds, retry the identical call once and record only the final attempt.",
  "Raw captures may contain real customer data: keep them under .captures/ (git-ignored), never commit them and never paste raw results, snippets, file names or paths into chat.",
];

const MODES = ["--account-id", "--init-capture", "--validate", "--check-mapping"];
const VALUE_FLAGS = new Set(["--account-id", "--init-capture", "--validate", "--m365-mapping"]);

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([...MODES, "--m365-mapping"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    if (Object.hasOwn(parsed, option)) throw new Error(`Option may only be provided once: ${option}`);
    if (!VALUE_FLAGS.has(option)) {
      parsed[option] = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.trim() === "") throw new Error(`Missing value for ${option}`);
    parsed[option] = value;
    index += 1;
  }
  const modes = MODES.filter((flag) => Object.hasOwn(parsed, flag));
  if (modes.length === 0) throw new Error("Choose a mode: --account-id, --init-capture, --validate or --check-mapping.");
  const validateWithPlan = modes.includes("--validate") && modes.every((flag) => ["--validate", "--account-id"].includes(flag));
  if (modes.length > 1 && !validateWithPlan) throw new Error("Modes cannot be combined, except --validate with --account-id.");
  if (Object.hasOwn(parsed, "--m365-mapping") && modes.length === 1 && modes[0] === "--init-capture") {
    throw new Error("--m365-mapping is not valid with --init-capture.");
  }
  if (Object.hasOwn(parsed, "--account-id") && !isValidAccountId(parsed["--account-id"].trim())) {
    throw new Error("--account-id must be sf_ followed by the 18-character Salesforce Account Id (or a mapped acct_ id).");
  }
  return { help: false, parsed };
}

/** Load the mapping; a failure is reported with problem kinds and indexes only. */
function loadMapping(path) {
  const resolved = resolve(path ?? DEFAULT_M365_MAPPING_FILE);
  warnIfNotGitIgnored(resolved, "mapping");
  return loadM365AccountMapping(resolved);
}

function mappingProblems(error) {
  if (error instanceof M365MappingError) return [error.message, ...error.problems];
  return ["The M365 account mapping could not be loaded."];
}

function buildPlan(accountId, mapping) {
  const plan = sharepointSearchPlan(accountId, mapping);
  return {
    phase: plan.phase,
    account_id: plan.account_id,
    mapped: plan.mapped,
    calls: plan.calls.map(({ step, args }) => ({ step, tool: M365_TOOL, args })),
    max_pages_per_search: plan.max_pages_per_search,
    pagination: plan.pagination,
    host_rules: HOST_RULES,
    note: plan.mapped
      ? "Make every printed call (and its pages) and record it in the M365 capture. The post-filter by the mapped locations runs when the capture is replayed."
      : "No M365 call is needed: the account has no SharePoint mapping. An empty M365 capture skeleton is valid.",
  };
}

function initCapture(path) {
  return initCaptureFile(path, { sourceSystem: "m365", connector: "Microsoft 365 connector (sharepoint_search)" });
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Payload-free summary. Never prints args, names, URLs, paths or snippets. */
function validateCapture(path, { accountId, mappingPath }) {
  const problems = [];
  let client;
  try {
    client = loadCapture(resolve(path), { redact: [...M365_REDACT] });
    warnIfNotGitIgnored(resolve(path));
  } catch (cause) {
    return { valid: false, problems: [`${cause?.code ?? "CAPTURE_UNREADABLE"}: ${cause?.message ?? "capture could not be loaded"}`] };
  }
  const entries = client.entries;
  if (client.capture.source_system !== "m365") problems.push("capture.source_system must be m365.");

  const folders = new Set();
  let recordedErrors = 0;
  let pages = 0;
  let hitsTotal = 0;
  const parsedEntries = []; // {index, folder, offset, ok, trailer}
  entries.forEach((entry, index) => {
    if (entry.tool !== M365_TOOL) {
      problems.push(`entry ${index}: tool ${entry.tool} is not allowed; only ${M365_TOOL} may be captured.`);
      return;
    }
    const args = entry.args;
    const keys = isPlainObject(args) ? Object.keys(args).sort().join(",") : "";
    let argsOk = true;
    if (keys !== "folderName,limit,offset,query") {
      problems.push(`entry ${index}: args must have exactly query, folderName, limit and offset.`);
      argsOk = false;
    } else {
      if (args.query !== SEARCH_QUERY) { problems.push(`entry ${index}: query must be "${SEARCH_QUERY}".`); argsOk = false; }
      if (args.limit !== PAGE_LIMIT) { problems.push(`entry ${index}: limit must be ${PAGE_LIMIT}.`); argsOk = false; }
      if (!Number.isInteger(args.offset) || args.offset < 0) { problems.push(`entry ${index}: offset must be a non-negative integer.`); argsOk = false; }
      if (typeof args.folderName !== "string" || args.folderName.trim() === "") { problems.push(`entry ${index}: folderName must be a non-empty string.`); argsOk = false; }
    }
    if (argsOk) folders.add(args.folderName);
    if (entry.error !== undefined) {
      recordedErrors += 1;
      return;
    }
    const parsed = parseSearchResult(entry.result);
    if (!parsed.ok) {
      if (parsed.error.code === "ADAPTER_MALFORMED_RESPONSE") problems.push(`entry ${index}: the result is not a valid sharepoint_search result.`);
      else recordedErrors += 1; // a recorded isError result
      return;
    }
    pages += 1;
    hitsTotal += parsed.hits.length;
    if (argsOk) parsedEntries.push({ index, folder: args.folderName, offset: args.offset, hits: parsed.hits.length, trailer: parsed.trailer });
  });

  for (const page of parsedEntries) {
    if (page.trailer?.moreResults !== true || page.hits === 0) continue;
    const next = page.trailer.nextOffset;
    if (!Number.isInteger(next) || next <= page.offset || next > MAX_OFFSET) {
      problems.push(`entry ${page.index}: invalid nextOffset.`);
      continue;
    }
    const pageNumber = 1 + new Set(parsedEntries.filter((other) => other.folder === page.folder && other.offset < page.offset).map((other) => other.offset)).size;
    if (pageNumber >= MAX_PAGES_PER_SEARCH) continue; // the search is truncated at the page cap
    const hasNext = parsedEntries.some((other) => other.index > page.index && other.folder === page.folder && other.offset === next);
    if (!hasNext) problems.push(`entry ${page.index}: missing pagination page.`);
  }

  let planned = 0;
  if (accountId !== undefined) {
    let mapping;
    try { mapping = loadMapping(mappingPath); } catch (error) {
      problems.push(...mappingProblems(error).map((problem) => `mapping: ${problem}`));
    }
    if (mapping) {
      const have = new Set(entries.map((entry) => `${entry.tool}\u0000${canonicalize(entry.args)}`));
      for (const call of sharepointSearchPlan(accountId, mapping).calls) {
        planned += 1;
        if (!have.has(`${M365_TOOL}\u0000${canonicalize(call.args)}`)) problems.push(`missing planned call: ${call.step}.`);
      }
    }
  }
  return {
    valid: problems.length === 0,
    source_system: client.capture.source_system,
    created_at: client.capture.created_at,
    entries: entries.length,
    recorded_errors: recordedErrors,
    searches: folders.size,
    pages,
    hits_total: hitsTotal,
    ...(accountId !== undefined ? { planned_calls_checked: planned } : {}),
    problems,
  };
}

function checkMapping(path) {
  try {
    const mapping = loadMapping(path);
    return { valid: true, accounts: mapping.accounts.length, locations: mapping.accounts.reduce((sum, account) => sum + account.locations.length, 0), problems: [] };
  } catch (error) {
    return { valid: false, accounts: 0, locations: 0, problems: mappingProblems(error) };
  }
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
  const mappingPath = parsed["--m365-mapping"];

  if (Object.hasOwn(parsed, "--check-mapping")) {
    const summary = checkMapping(mappingPath);
    print(summary);
    if (!summary.valid) process.exitCode = 1;
    return;
  }
  if (Object.hasOwn(parsed, "--validate")) {
    const summary = validateCapture(parsed["--validate"], { accountId: parsed["--account-id"]?.trim(), mappingPath });
    print(summary);
    if (!summary.valid) process.exitCode = 1;
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
  let mapping;
  try {
    mapping = loadMapping(mappingPath);
  } catch (error) {
    process.stderr.write(`${mappingProblems(error).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  print(buildPlan(parsed["--account-id"].trim(), mapping));
}

main();
