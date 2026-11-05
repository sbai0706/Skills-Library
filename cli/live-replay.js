import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./capture-files.js";

/**
 * Opt-in live-acceptance replay (`npm run live-replay`; never part of `npm test`).
 *
 * Reads an expectations JSON, reruns each recorded command against its (already recorded)
 * captures and compares the exit code and, when given, the stdout `status`. It makes no connector
 * call, reads no Salesforce or Microsoft 365 data and prints no payload: only scenario ids, run
 * indexes, script names and expected-versus-actual exit codes and statuses.
 *
 * Commands are never run through a shell. A command must be `npm run [-s] <script> [-- <args>]`
 * where `<script>` is on the allow-list below (the repository's own read-only npm scripts, checked
 * against `package.json`); the two capture-plan scripts are further limited to their read-only
 * `--validate` and `--check-mapping` modes. Anything else is refused and nothing is run.
 */

export const DEFAULT_EXPECTATIONS = "local/p5-live-acceptance.json";
export const RUN_TIMEOUT_MS = 180_000;

/** npm script -> the file `package.json` must map it to (`node <file>`). */
export const ALLOWED_SCRIPTS = Object.freeze({
  "prepare-first-meeting": "bin/prepare-first-meeting.js",
  "prepare-first-meeting-v2": "bin/prepare-first-meeting-v2.js",
  "opportunity-strategy": "bin/opportunity-strategy.js",
  qualification: "bin/qualification.js",
  "prepare-engagement": "bin/prepare-engagement.js",
  "source-rank": "bin/source-rank.js",
  "salesforce-capture-plan": "bin/salesforce-capture-plan.js",
  "m365-capture-plan": "bin/m365-capture-plan.js",
});

/** Scripts that can write: only these read-only modes may be replayed, and these modes never. */
const PLAN_SCRIPTS = new Set(["salesforce-capture-plan", "m365-capture-plan"]);
const PLAN_READ_ONLY_MODES = ["--validate", "--check-mapping"];
const PLAN_WRITE_MODES = ["--append", "--init-capture"];

export class LiveReplayError extends Error {}

const SCENARIO_ID = /^[A-Za-z0-9_-]{1,32}$/;
const UNQUOTED_FORBIDDEN = new Set([";", "&", "|", "`", "$", "(", ")"]);

/**
 * Split a command line into tokens: whitespace separates, single or double quotes group (no
 * escapes, so Windows paths survive). Shell metacharacters outside quotes are refused.
 * @returns {string[]|null} null when the command cannot be tokenized safely
 */
export function tokenize(command) {
  if (typeof command !== "string" || command.length === 0 || command.length > 4000) return null;
  const tokens = [];
  let current = "";
  let quote = null;
  let inToken = false;
  for (const char of command) {
    const code = char.codePointAt(0);
    if (code < 0x20 && char !== "\t") return null; // control characters, including newlines
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
    } else if (char === " " || char === "\t") {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else if (UNQUOTED_FORBIDDEN.has(char)) {
      return null;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (quote !== null) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Parse and allow-list one recorded command.
 * @returns {{script: string, file: string, args: string[], placeholder: boolean}} `placeholder`: an
 *   argument still holds an unresolved `<...>` placeholder (a recording artefact), so it cannot be replayed
 * @throws {LiveReplayError} fixed text (never echoes the command)
 */
export function parseAllowedCommand(command) {
  const refuse = (reason) => new LiveReplayError(reason);
  const tokens = tokenize(command);
  if (tokens === null) throw refuse("command refused: it is empty or contains shell syntax or control characters");
  if (tokens[0] !== "npm" || tokens[1] !== "run") throw refuse("command refused: only `npm run <script> -- <args>` is allowed");
  let index = 2;
  if (tokens[index] === "-s" || tokens[index] === "--silent") index += 1;
  const script = tokens[index];
  if (script === undefined || !Object.hasOwn(ALLOWED_SCRIPTS, script)) throw refuse("command refused: the npm script is not on the allow-list");
  index += 1;
  let args = [];
  if (index < tokens.length) {
    if (tokens[index] !== "--") throw refuse("command refused: arguments must follow `--`");
    args = tokens.slice(index + 1);
  }
  if (PLAN_SCRIPTS.has(script)) {
    if (args.some((arg) => PLAN_WRITE_MODES.includes(arg))) throw refuse("command refused: a capture-plan script may not write when replayed");
    if (!args.some((arg) => PLAN_READ_ONLY_MODES.includes(arg))) throw refuse("command refused: a capture-plan script is only allowed with --validate or --check-mapping");
  }
  return { script, file: ALLOWED_SCRIPTS[script], args, placeholder: args.some((arg) => /<[^<>\s]+>/.test(arg)) };
}

/** The allow-list is only valid while `package.json` maps each script to the expected file. */
function assertPackageScripts(root) {
  let scripts;
  try { scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}; } catch {
    throw new LiveReplayError("package.json could not be read.");
  }
  for (const [name, file] of Object.entries(ALLOWED_SCRIPTS)) {
    if (scripts[name] !== `node ${file}`) throw new LiveReplayError("package.json does not map the allow-listed npm scripts as expected.");
  }
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Load and validate the expectations (nothing is run here). Accepts the structure of the real
 * acceptance record: `scenarios.<id>.runs[]` and `scenarios.<id>.validate.<name>` entries, each
 * `{command, exit_code, status?}`; every other key (captures, build steps, notes, checks, counts) is
 * ignored, and recorded build commands (init/append) are never replayed.
 * @returns {{items: Array<{scenario: string, run: string, command: string, exitCode: number, status: string|null}>, refused: Array<{scenario: string, run: string, reason: string}>}}
 * @throws {LiveReplayError} when the file is missing or not an expectations document
 */
export function loadExpectations(path) {
  let text;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    text = readFileSync(path, "utf8");
  } catch {
    throw new LiveReplayError("The expectations file does not exist or cannot be read (default: local/p5-live-acceptance.json, git-ignored).");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new LiveReplayError("The expectations file is not valid JSON."); }
  if (!isPlainObject(doc) || !isPlainObject(doc.scenarios) || Object.keys(doc.scenarios).length === 0) {
    throw new LiveReplayError("The expectations file needs a non-empty `scenarios` object.");
  }
  const items = [];
  const refused = [];
  for (const [scenario, body] of Object.entries(doc.scenarios)) {
    if (!SCENARIO_ID.test(scenario) || !isPlainObject(body)) throw new LiveReplayError("Every scenario needs an id of letters, digits, _ or - (at most 32) and an object body.");
    const entries = [];
    if (body.runs !== undefined) {
      if (!Array.isArray(body.runs)) throw new LiveReplayError("`runs` must be an array.");
      body.runs.forEach((entry, i) => entries.push([`r${i + 1}`, entry]));
    }
    if (body.validate !== undefined) {
      if (!isPlainObject(body.validate)) throw new LiveReplayError("`validate` must be an object.");
      Object.values(body.validate).forEach((entry, i) => entries.push([`v${i + 1}`, entry]));
    }
    for (const [run, entry] of entries) {
      const valid = isPlainObject(entry) && typeof entry.command === "string"
        && Number.isInteger(entry.exit_code) && entry.exit_code >= 0 && entry.exit_code <= 255
        && (entry.status === undefined || entry.status === null || typeof entry.status === "string");
      if (!valid) {
        refused.push({ scenario, run, reason: "entry needs a string `command`, an integer `exit_code` (0-255) and an optional string `status`" });
        continue;
      }
      try {
        parseAllowedCommand(entry.command);
      } catch (error) {
        refused.push({ scenario, run, reason: error.message });
        continue;
      }
      items.push({ scenario, run, command: entry.command, exitCode: entry.exit_code, status: typeof entry.status === "string" ? entry.status : null });
    }
  }
  return { items, refused };
}

/** The stdout `status` of a JSON result, or null when stdout is not a JSON object with a string status. */
export function stdoutStatus(stdout) {
  try {
    const value = JSON.parse(stdout);
    return isPlainObject(value) && typeof value.status === "string" ? value.status : null;
  } catch {
    return null;
  }
}

/** Run one allow-listed command (no shell; cwd is the repository root) and return its exit code and stdout status. */
export function runCommand(command, { root = REPO_ROOT } = {}) {
  const { file, args } = parseAllowedCommand(command);
  const result = spawnSync(process.execPath, [join(root, file), ...args], {
    cwd: root, encoding: "utf8", timeout: RUN_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status === null) return { exitCode: null, status: null };
  return { exitCode: result.status, status: stdoutStatus(result.stdout) };
}

/**
 * Rerun every item and compare. `status` is compared only when the expectation has one.
 * @param {Array<{scenario: string, run: string, command: string, exitCode: number, status: string|null}>} items
 * @param {{root?: string, runner?: typeof runCommand}} [options]
 */
export function replay(items, { root = REPO_ROOT, runner = runCommand } = {}) {
  assertPackageScripts(root);
  return items.map((item) => {
    const { script, placeholder } = parseAllowedCommand(item.command);
    const base = { scenario: item.scenario, run: item.run, script, expectedExit: item.exitCode, expectedStatus: item.status };
    if (placeholder) return { ...base, actualExit: null, actualStatus: null, pass: null }; // unresolved placeholder: skipped, not run
    const actual = runner(item.command, { root });
    const exitOk = actual.exitCode === item.exitCode;
    const statusOk = item.status === null || actual.status === item.status;
    return {
      scenario: item.scenario,
      run: item.run,
      script,
      expectedExit: item.exitCode,
      actualExit: actual.exitCode,
      expectedStatus: item.status,
      actualStatus: actual.status,
      pass: exitOk && statusOk,
    };
  });
}

const show = (value) => (value === null || value === undefined ? "-" : String(value));

/** Payload-free table: ids, indexes, script names, expected versus actual exit and status, verdict. */
export function formatTable(rows) {
  const header = ["scenario", "run", "script", "exit (exp/act)", "status (exp/act)", "result"];
  const body = rows.map((row) => [
    row.scenario, row.run, row.script,
    `${show(row.expectedExit)}/${show(row.actualExit)}`,
    `${show(row.expectedStatus)}/${show(row.actualStatus)}`,
    row.pass === null ? "SKIP" : row.pass ? "PASS" : "MISMATCH",
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((line) => line[column].length)));
  const render = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  const passed = rows.filter((row) => row.pass === true).length;
  const failed = rows.filter((row) => row.pass === false).length;
  const skipped = rows.filter((row) => row.pass === null).length;
  const summary = `${passed}/${rows.length} passed${failed > 0 ? `, ${failed} MISMATCH` : ""}${skipped > 0 ? `, ${skipped} skipped (unresolved <placeholder> in the command: fix the expectations file)` : ""}`;
  return [render(header), render(widths.map((width) => "-".repeat(width))), ...body.map(render), "", summary].join("\n");
}
