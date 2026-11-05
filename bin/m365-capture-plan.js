#!/usr/bin/env node

import { resolve } from "node:path";
import { canonicalize, loadCapture } from "../adapters/mcp/index.js";
import {
  M365MappingError, M365_REDACT, M365_TOOL, MAX_OFFSET, MAX_PAGES_PER_SEARCH, PAGE_LIMIT, SEARCH_QUERY,
  isValidAccountId, loadM365AccountMapping, parseSearchResult, searchArgs, sharepointSearchPlan,
} from "../adapters/m365/index.js";
import { CaptureFileUsageError, appendCaptureEntry, initCaptureFile, selectPlanStep } from "../cli/capture-files.js";
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
  --append PATH            Append ONE recorded sharepoint_search call to the capture at PATH (an existing
                           file under .captures/, created with --init-capture). The tool and args come
                           from the printed plan step, never from you. Needs --account-id, --step and
                           --result-file or --error-file
  --m365-mapping PATH      Mapping file (default: local/m365-account-mapping.yaml, git-ignored);
                           valid with --account-id, --validate with --account-id, --check-mapping,
                           --append
  --help                   Show this help

Append options (only with --append, which needs --account-id):
  --step STEP              The printed step name (search_1, search_2, ...) or its 1-based position in the
                           printed calls
  --offset N               Only for a follow-up page: the previous page's trailer nextOffset, exactly;
                           omit for the first page (offset 0)
  --result-file PATH       The connector's raw response, verbatim, as a JSON file under .captures/
                           (for example .captures/tmp/r1.json); stored exactly as parsed
  --error-file PATH        The connector's raw error payload (a JSON object file under .captures/)
  --replace-last           Replace the last entry, which must be the same call (a retry's final attempt)
  --captured-at RFC3339    Override captured_at (tests); default is the time of the append

Append refuses (exit 1, nothing written, payload never printed): files outside .captures/, non-JSON
input, a capture with another source_system, a duplicate of the last entry without --replace-last,
an --offset that does not follow a recorded page, and entries or files over the capture size limits.
Output is a payload-free summary.

Output is JSON on stdout. Exit codes: 0 ok, 1 invalid usage or validation problems.
`;

const HOST_RULES = [
  `Call only the Microsoft 365 connector tool ${M365_TOOL}, with exactly the printed args. Never call read_resource, sharepoint_folder_search or any write/send/create/move/delete/upload tool for this workflow; never add filters or change query.`,
  "Record every call with --append, in call order: write the connector's raw response, unmodified ({\"content\":[<item text blocks>, <trailer text block>]}, an empty result as {\"content\":[]}), to a JSON file under .captures/ (for example .captures/tmp/r1.json), then run: npm run m365-capture-plan -- --append <capture path> --account-id <id> --step <step> --result-file <file>. A tool error payload goes to a JSON file too and is appended with --error-file. Never hand-write capture entries or captured_at.",
  `Follow nextOffset while the trailer has moreResults:true, up to ${MAX_PAGES_PER_SEARCH} pages per search: call the same search with offset = nextOffset and append that page with: --append <capture path> --account-id <id> --step <the same step> --offset <nextOffset> --result-file <file>.`,
  "On a rate-limit error wait graphRetryAfterSeconds, retry the identical call once and append only the final attempt (if the failed attempt was already appended, append the retry with --replace-last).",
  "Raw captures may contain real customer data: keep them under .captures/ (git-ignored), never commit them and never paste raw results, snippets, file names or paths into chat.",
];

const MODES = ["--account-id", "--init-capture", "--validate", "--check-mapping", "--append"];
const APPEND_OPTIONS = ["--step", "--offset", "--result-file", "--error-file", "--replace-last", "--captured-at"];
const VALUE_FLAGS = new Set(["--account-id", "--init-capture", "--validate", "--m365-mapping", "--append", "--step", "--offset", "--result-file", "--error-file", "--captured-at"]);

function parseArgs(argv) {
  const parsed = {};
  const supported = new Set([...MODES, "--m365-mapping", ...APPEND_OPTIONS]);
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
  if (modes.length === 0) throw new Error("Choose a mode: --account-id, --init-capture, --validate, --check-mapping or --append.");
  const validateWithPlan = modes.includes("--validate") && modes.every((flag) => ["--validate", "--account-id"].includes(flag));
  const appendWithPlan = modes.includes("--append") && modes.every((flag) => ["--append", "--account-id"].includes(flag));
  if (modes.length > 1 && !validateWithPlan && !appendWithPlan) throw new Error("Modes cannot be combined, except --validate or --append with --account-id.");
  if (modes.includes("--append")) {
    if (!Object.hasOwn(parsed, "--account-id")) throw new Error("--append needs --account-id (the account that printed the plan).");
    if (!Object.hasOwn(parsed, "--step")) throw new Error("--append needs --step.");
    if (Object.hasOwn(parsed, "--result-file") === Object.hasOwn(parsed, "--error-file")) {
      throw new Error("--append needs exactly one of --result-file and --error-file.");
    }
    if (Object.hasOwn(parsed, "--offset") && !/^\d+$/.test(parsed["--offset"].trim())) throw new Error("--offset must be a non-negative integer.");
  } else {
    for (const flag of APPEND_OPTIONS) {
      if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} is only valid with --append.`);
    }
  }
  if (Object.hasOwn(parsed, "--m365-mapping") && modes.length === 1 && modes[0] === "--init-capture") {
    throw new Error("--m365-mapping is not valid with --init-capture.");
  }
  if (Object.hasOwn(parsed, "--m365-mapping") && modes.length === 1 && modes[0] === "--validate") {
    throw new Error("--m365-mapping with --validate requires --account-id (the mapping is only used to check planned calls).");
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

/** Pages already recorded for one search folder: successful, parseable results only. */
function recordedPages(entries, folderName) {
  const pages = [];
  for (const entry of entries) {
    if (entry.tool !== M365_TOOL || entry.args?.folderName !== folderName) continue;
    const parsed = entry.result === undefined ? null : parseSearchResult(entry.result);
    pages.push({ offset: entry.args.offset, hits: parsed?.ok ? parsed.hits.length : 0, trailer: parsed?.ok ? parsed.trailer : null, ok: parsed?.ok === true });
  }
  return pages;
}

/** Append one recorded search call (page 1 of a plan step, or a follow-up page). Payload-free summary. */
function appendEntry(parsed, mapping) {
  const plan = sharepointSearchPlan(parsed["--account-id"].trim(), mapping);
  const call = selectPlanStep(plan.calls, parsed["--step"]);
  const offset = Object.hasOwn(parsed, "--offset") ? Number(parsed["--offset"].trim()) : 0;
  const args = searchArgs(call.args.folderName, offset);
  const checkPriorEntries = (entries) => {
    if (offset === 0) return;
    const pages = recordedPages(entries, call.args.folderName);
    if (new Set(pages.map((page) => page.offset)).size >= MAX_PAGES_PER_SEARCH) {
      throw new CaptureFileUsageError(`This search already has ${MAX_PAGES_PER_SEARCH} recorded pages (the maximum); nothing was changed.`);
    }
    const follows = offset <= MAX_OFFSET && pages.some((page) => page.ok && page.hits > 0 && page.trailer?.moreResults === true && page.trailer.nextOffset === offset);
    if (!follows) throw new CaptureFileUsageError("--offset must equal the nextOffset of a recorded page of this search that has moreResults:true; nothing was changed.");
  };
  const done = appendCaptureEntry({
    capturePath: parsed["--append"],
    sourceSystem: "m365",
    tool: M365_TOOL,
    args,
    resultFile: parsed["--result-file"],
    errorFile: parsed["--error-file"],
    replaceLast: parsed["--replace-last"] === true,
    capturedAt: parsed["--captured-at"],
    checkPriorEntries,
  });
  let counts = {};
  if (done.outcome === "result") {
    const result = parseSearchResult(done.value);
    counts = result.ok
      ? {
        result_is_error: false,
        hits: result.hits.length,
        more_results: result.trailer?.moreResults === true,
        ...(Number.isInteger(result.trailer?.nextOffset) ? { next_offset: result.trailer.nextOffset } : {}),
      }
      : result.error.code === "ADAPTER_MALFORMED_RESPONSE" ? { result_valid: false } : { result_is_error: true };
  }
  return {
    appended: true,
    replaced_last: done.replaced,
    entry_index: done.entryIndex,
    entries: done.entries,
    tool: M365_TOOL,
    step: call.step,
    offset,
    outcome: done.outcome,
    captured_at: done.capturedAt,
    ...counts,
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
  if (Object.hasOwn(parsed, "--append")) {
    let mapping;
    try {
      mapping = loadMapping(mappingPath);
    } catch (error) {
      process.stderr.write(`${mappingProblems(error).join("\n")}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      print(appendEntry(parsed, mapping));
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
