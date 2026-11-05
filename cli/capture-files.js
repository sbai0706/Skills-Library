import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_LIMITS, CaptureError, canonicalize, loadCapture } from "../adapters/mcp/index.js";

/** Shared by the capture-plan CLIs: repository paths, the `.captures/`-only skeleton writer and the append command. */

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CAPTURES_DIR = resolve(REPO_ROOT, ".captures");

export class CaptureFileUsageError extends Error {}

const underCaptures = (target) => {
  const rel = relative(CAPTURES_DIR, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * Write an empty valid `mcp-capture/1` skeleton. Writes only inside `<repo root>/.captures/`
 * (git-ignored); there is deliberately no override; an existing file is never overwritten
 * (the write error has code EEXIST).
 * @param {string} path
 * @param {{sourceSystem: string, connector: string}} options
 * @throws {CaptureFileUsageError} for a refused target
 */
export function initCaptureFile(path, { sourceSystem, connector }) {
  const target = resolve(path);
  const isDirectory = /[\\/]$/.test(path) || target === CAPTURES_DIR || (() => {
    try { return statSync(target).isDirectory(); } catch { return false; }
  })();
  if (isDirectory) throw new CaptureFileUsageError("--init-capture needs a file path such as .captures/<slug>.json, not a directory.");
  if (!underCaptures(target)) {
    throw new CaptureFileUsageError("--init-capture refuses any target outside the repository's .captures/ directory.");
  }
  const doc = {
    format_version: "mcp-capture/1",
    capture: { created_at: new Date().toISOString(), source_system: sourceSystem, connector },
    entries: [],
  };
  mkdirSync(dirname(target), { recursive: true });
  const realRel = relative(realpathSync(CAPTURES_DIR), realpathSync(dirname(target)));
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new CaptureFileUsageError("--init-capture refuses any target outside the repository's .captures/ directory.");
  }
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx" });
  return { initialized: target, entries: 0, note: "Append one entry per recorded call, in call order, with --append, then run --validate." };
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Validate an RFC 3339 date-time with an explicit offset (the capture schema's `date-time`). */
export function assertRfc3339(value, flag) {
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CaptureFileUsageError(`${flag} must be an RFC 3339 date-time with an explicit offset, for example 2026-11-05T10:00:00Z.`);
  }
  return value;
}

/**
 * Pick a printed plan step by its `step` name (for example `search`, `Opportunity`, `search_2`) or
 * by its 1-based position in the printed `calls` list.
 * @param {Array<{step: string, args: object}>} calls
 * @param {string} step
 */
export function selectPlanStep(calls, step) {
  const wanted = String(step).trim();
  const call = /^\d+$/.test(wanted) ? calls[Number(wanted) - 1] : calls.find((candidate) => candidate.step === wanted);
  if (!call) {
    const known = calls.length === 0 ? "the plan has no calls" : `valid steps: ${calls.map((candidate) => candidate.step).join(", ")}`;
    throw new CaptureFileUsageError(`--step does not name a step of this plan (${known}).`);
  }
  return call;
}

/** Existing regular file whose real path (symlinks and junctions resolved) is under `.captures/`. */
function realCapturesFile(path, flag) {
  const refuse = (detail) => new CaptureFileUsageError(`${flag} ${detail}`);
  const target = resolve(path);
  if (!underCaptures(target)) throw refuse("must be a file under the repository's .captures/ directory.");
  let real;
  let realRoot;
  try {
    real = realpathSync.native(target);
    realRoot = realpathSync.native(CAPTURES_DIR);
  } catch {
    throw refuse("must be an existing file under the repository's .captures/ directory.");
  }
  const rel = relative(realRoot, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refuse("must be a file under the repository's .captures/ directory.");
  let stats;
  try { stats = statSync(real); } catch { stats = null; }
  if (!stats?.isFile()) throw refuse("must be an existing file under the repository's .captures/ directory.");
  return { real, bytes: stats.size };
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Read and parse a JSON file; messages are fixed text so no file content can reach the output. */
function readJsonFile(real, bytes, flag) {
  if (bytes > CAPTURE_LIMITS.maxFileBytes) throw new CaptureFileUsageError(`${flag} file exceeds the ${CAPTURE_LIMITS.maxFileBytes}-byte capture file limit.`);
  let text;
  try { text = readFileSync(real, "utf8"); } catch { throw new CaptureFileUsageError(`${flag} file cannot be read.`); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch { throw new CaptureFileUsageError(`${flag} file is not valid JSON.`); }
}

/**
 * Append one entry to an existing capture file, atomically (temp file plus rename).
 *
 * The caller supplies the tool and args from a printed plan step, never host-typed JSON. The
 * payload is read from a JSON file under `.captures/` and stored exactly as parsed: no
 * normalisation and no redaction (the loader redacts at read time). Existing entries are never
 * modified or reordered; the file is left untouched on any refusal. Refusal messages are fixed
 * text: no payload content is ever included. The returned `value` is the stored payload, for the
 * caller to derive counts only.
 * @param {object} options
 * @param {string} options.capturePath existing capture file under `.captures/`
 * @param {string} options.sourceSystem must equal `capture.source_system`
 * @param {string} options.tool
 * @param {object} options.args exact args from the plan
 * @param {string} [options.resultFile] JSON file holding the raw connector result
 * @param {string} [options.errorFile] JSON object file holding the raw connector error
 * @param {boolean} [options.replaceLast] replace the last entry (must be the same tool and args)
 * @param {string} [options.capturedAt] RFC 3339; default is the current time
 * @param {(remainingEntries: object[]) => void} [options.checkPriorEntries] throw CaptureFileUsageError to refuse
 * @returns {{entryIndex: number, entries: number, replaced: boolean, outcome: "result"|"error", capturedAt: string, value: unknown}}
 * @throws {CaptureFileUsageError}
 */
export function appendCaptureEntry({
  capturePath, sourceSystem, tool, args, resultFile, errorFile, replaceLast = false, capturedAt, checkPriorEntries,
}) {
  if ((resultFile === undefined) === (errorFile === undefined)) {
    throw new CaptureFileUsageError("Give exactly one of --result-file and --error-file.");
  }
  const timestamp = capturedAt === undefined ? new Date().toISOString() : assertRfc3339(capturedAt, "--captured-at");
  const capture = realCapturesFile(capturePath, "--append");
  const outcome = resultFile !== undefined ? "result" : "error";
  const payloadFlag = outcome === "result" ? "--result-file" : "--error-file";
  const payload = realCapturesFile(resultFile ?? errorFile, payloadFlag);
  if (payload.real === capture.real) throw new CaptureFileUsageError(`${payloadFlag} must not be the capture file itself.`);
  return withCaptureLock(capture.real, () => {
    const value = readJsonFile(payload.real, payload.bytes, payloadFlag);
    if (outcome === "error" && !isPlainObject(value)) throw new CaptureFileUsageError("--error-file must contain a JSON object.");

    const doc = readJsonFile(capture.real, capture.bytes, "--append");
    if (!isPlainObject(doc) || !isPlainObject(doc.capture) || !Array.isArray(doc.entries)) {
      throw new CaptureFileUsageError("--append: the capture file is not a valid mcp-capture/1 document.");
    }
    if (doc.capture.source_system !== sourceSystem) {
      throw new CaptureFileUsageError(`--append: this CLI appends only to captures with source_system ${sourceSystem}.`);
    }
    try { loadCapture(doc); } catch { throw new CaptureFileUsageError("--append: the existing capture file is not valid; run --validate."); }

    const last = doc.entries.at(-1);
    const sameCall = last !== undefined && last.tool === tool && canonicalize(last.args) === canonicalize(args);
    if (replaceLast && !sameCall) {
      throw new CaptureFileUsageError("--replace-last needs the last entry to be the same call (same tool and args); nothing was changed.");
    }
    if (!replaceLast && sameCall) {
      throw new CaptureFileUsageError("The last entry is already this call. To keep only the final attempt of a retry, append again with --replace-last.");
    }
    const remaining = replaceLast ? doc.entries.slice(0, -1) : doc.entries;
    if (remaining.some((entry) => entry.tool === tool && canonicalize(entry.args) === canonicalize(args))) {
      throw new CaptureFileUsageError("This call is already recorded in the capture; only the last entry can be replaced, with --replace-last.");
    }
    checkPriorEntries?.(remaining);

    const entry = { tool, args, [outcome]: value, captured_at: timestamp };
    const next = { ...doc, entries: [...remaining, entry] };
    try {
      loadCapture(next);
    } catch (cause) {
      throw new CaptureFileUsageError(cause instanceof CaptureError && cause.code === "CAPTURE_TOO_LARGE"
        ? `The entry would exceed a capture limit (${cause.message}); nothing was changed.`
        : "The entry would make the capture invalid; nothing was changed.");
    }
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const size = Buffer.byteLength(text, "utf8");
    if (size > CAPTURE_LIMITS.maxFileBytes) {
      throw new CaptureFileUsageError(`The capture file would exceed ${CAPTURE_LIMITS.maxFileBytes} bytes (${size}); nothing was changed.`);
    }
    const temp = join(dirname(capture.real), `.${basename(capture.real)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(temp, text, { flag: "wx" });
      renameWithRetry(temp, capture.real);
    } catch {
      try { unlinkSync(temp); } catch { /* temp file may not exist */ }
      throw new CaptureFileUsageError("The capture file could not be written; it was not changed.");
    }
    return { entryIndex: remaining.length, entries: remaining.length + 1, replaced: replaceLast, outcome, capturedAt: timestamp, value };
  });
}

/**
 * Exclusive lock for one append: `<capture>.lock` is created with `wx` and removed in a `finally`
 * (only if this call created it). Appends must run sequentially; a concurrent one is refused.
 */
function withCaptureLock(capturePath, action) {
  const lock = `${capturePath}.lock`;
  try {
    writeFileSync(lock, "", { flag: "wx" });
  } catch (error) {
    throw new CaptureFileUsageError(error?.code === "EEXIST"
      ? "The capture is busy (another append is in progress, or a stale .lock file remains after a crash: remove it only if no append is running); nothing was changed."
      : "The capture could not be locked; nothing was changed.");
  }
  try {
    return action();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** `renameSync` with up to 3 attempts and a short pause on transient Windows errors. */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 3 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}
