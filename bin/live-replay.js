#!/usr/bin/env node

import { resolve } from "node:path";
import { REPO_ROOT } from "../cli/capture-files.js";
import { DEFAULT_EXPECTATIONS, LiveReplayError, formatTable, loadExpectations, replay } from "../cli/live-replay.js";

const HELP = `Usage: npm run live-replay -- [options]

Opt-in live-acceptance replay; it is not part of npm test. Reruns every command recorded in an
expectations file against its already recorded captures and compares the exit code and, when the
expectation has one, the stdout status. It makes no connector call and prints no payload: a table of
scenario id, run index (r = run, v = validate), npm script, and expected versus actual exit code and
status. Exits 0 when every row passes, 1 on any mismatch or invalid expectations.

Options:
  --expectations PATH  Expectations JSON (default: ${DEFAULT_EXPECTATIONS}, git-ignored; it holds real
                       paths and is never committed). A synthetic example:
                       reference/live-replay-expectations.example.json
  --scenario IDS       Only these scenario ids (comma-separated, for example S1,S5)
  --help               Show this help

Expectations: { "scenarios": { "<id>": { "runs": [ { "command", "exit_code", "status"? } ],
"validate": { "<name>": { "command", "exit_code" } } } } }; other keys are ignored. Commands run from
the repository root without a shell and must be \`npm run [-s] <script> -- <args>\` for an allow-listed
script (prepare-first-meeting, prepare-first-meeting-v2, opportunity-strategy, qualification,
prepare-engagement, source-rank) or, only with --validate or --check-mapping, salesforce-capture-plan or
m365-capture-plan. Anything else (including --append and --init-capture) is refused and nothing runs.
Paths inside commands are relative to the repository root.
`;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (option !== "--expectations" && option !== "--scenario") throw new Error(`Unknown option: ${option}`);
    if (Object.hasOwn(parsed, option)) throw new Error(`Option may only be provided once: ${option}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.trim() === "") throw new Error(`Missing value for ${option}`);
    parsed[option] = value;
    index += 1;
  }
  return { help: false, parsed };
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
  const path = parsed["--expectations"] === undefined ? resolve(REPO_ROOT, DEFAULT_EXPECTATIONS) : resolve(parsed["--expectations"]);
  try {
    const { items, refused } = loadExpectations(path);
    if (refused.length > 0) {
      for (const { scenario, run, reason } of refused) process.stderr.write(`${scenario} ${run}: ${reason}\n`);
      process.stderr.write(`live-replay: ${refused.length} entr${refused.length === 1 ? "y" : "ies"} refused; nothing was run.\n`);
      process.exitCode = 1;
      return;
    }
    let selected = items;
    if (parsed["--scenario"] !== undefined) {
      const wanted = new Set(parsed["--scenario"].split(",").map((id) => id.trim()));
      selected = items.filter((item) => wanted.has(item.scenario));
      const known = new Set(items.map((item) => item.scenario));
      if ([...wanted].some((id) => !known.has(id))) throw new LiveReplayError("--scenario names an id that is not in the expectations.");
    }
    if (selected.length === 0) throw new LiveReplayError("The expectations contain no runs to replay.");
    const rows = replay(selected);
    process.stdout.write(`${formatTable(rows)}\n`);
    if (rows.some((row) => row.pass === false)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof LiveReplayError ? error.message : "live-replay failed before comparing any result."}\n`);
    process.exitCode = 1;
  }
}

main();
