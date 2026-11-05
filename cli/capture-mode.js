import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadCapture } from "../adapters/mcp/index.js";
import {
  createCompositeClaimExtractor,
  createSalesforceAccountAdapter,
  createSalesforceEvidenceAdapter,
  createSalesforceStructuredClaimExtractor,
} from "../adapters/salesforce/index.js";
import {
  DEFAULT_MAPPING_PATH, M365_DIAGNOSTIC_TEXT, M365_REDACT, M365_TOOL, M365MappingError,
  createM365SharePointEvidenceAdapter, createM365StructuredClaimExtractor, loadM365AccountMapping,
} from "../adapters/m365/index.js";
import { createSourceRouterEvidenceAdapter } from "../adapters/source-router-evidence-adapter.js";
import { REPO_ROOT } from "./capture-files.js";

/**
 * Shared CLI wiring for `--source fixture|capture` and the capture flags (Mode A).
 * Capture mode replays host-recorded captures (Salesforce `--capture`, optional M365
 * `--capture-m365` with `--m365-mapping`); it never falls back to fixtures. Each capture is
 * loaded into its own strict replay client, so the two sources cannot consume each other's entries.
 */

export const SOURCE_FLAGS = Object.freeze(["--source", "--capture", "--capture-m365", "--m365-mapping"]);

/** Sources a capture can serve: `crm` (Salesforce capture) and `internal_document` (M365 capture). */
export const CAPTURE_SOURCES = Object.freeze(["crm", "internal_document"]);

export const DEFAULT_M365_MAPPING_FILE = resolve(REPO_ROOT, DEFAULT_MAPPING_PATH);

const isFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};

/**
 * Validate the source options of an already tokenized argument map.
 * @param {Record<string, string>} parsed option -> value
 * @param {{incompatible?: Array<[string, string]>, salesforceOptional?: boolean}} [rules]
 *   `incompatible`: `[flag, reason]` pairs rejected in capture mode. `salesforceOptional`: the
 *   Salesforce `--capture` may be omitted when `--capture-m365` is given (source-rank only);
 *   workflow CLIs always need `--capture` because account resolution uses Salesforce.
 * @returns {{source: "fixture"|"capture", capturePath?: string, m365CapturePath?: string, m365MappingPath?: string}}
 * @throws {Error} invalid usage (callers exit 1)
 */
export function resolveSourceOptions(parsed, { incompatible = [], salesforceOptional = false } = {}) {
  const source = parsed["--source"] ?? "fixture";
  if (source !== "fixture" && source !== "capture") throw new Error("--source must be fixture or capture.");
  const has = (flag) => Object.hasOwn(parsed, flag);
  if (source === "fixture") {
    for (const flag of ["--capture", "--capture-m365", "--m365-mapping"]) {
      if (has(flag)) throw new Error(`${flag} requires --source capture.`);
    }
    return { source };
  }
  for (const flag of ["--capture", "--capture-m365", "--m365-mapping"]) {
    if (has(flag) && parsed[flag].trim() === "") throw new Error(`${flag} must not be empty.`);
  }
  if (!has("--capture") && !(salesforceOptional && has("--capture-m365"))) {
    throw new Error(salesforceOptional
      ? "--source capture requires --capture PATH and/or --capture-m365 PATH."
      : "--source capture requires --capture PATH.");
  }
  if (has("--m365-mapping") && !has("--capture-m365")) throw new Error("--m365-mapping requires --capture-m365.");
  for (const [flag, reason] of incompatible) {
    if (has(flag)) throw new Error(`${flag} cannot be used with --source capture: ${reason}`);
  }
  const result = { source };
  if (has("--capture")) {
    result.capturePath = resolve(parsed["--capture"]);
    if (!isFile(result.capturePath)) throw new Error("--capture must be the path of an existing capture file.");
  }
  if (has("--capture-m365")) {
    result.m365CapturePath = resolve(parsed["--capture-m365"]);
    if (!isFile(result.m365CapturePath)) throw new Error("--capture-m365 must be the path of an existing capture file.");
    result.m365MappingPath = has("--m365-mapping") ? resolve(parsed["--m365-mapping"]) : DEFAULT_M365_MAPPING_FILE;
    if (!isFile(result.m365MappingPath)) {
      throw new Error(`--m365-mapping must be the path of an existing mapping file (default ${DEFAULT_MAPPING_PATH}).`);
    }
  }
  return result;
}

/**
 * In capture mode only `crm` (Salesforce capture) and, with an M365 capture, `internal_document`
 * can be served; anything else is invalid usage, not a silent fallback.
 * @param {string[]|undefined} sources
 * @param {{m365?: boolean}} [options] `m365`: an M365 capture was given
 */
export function assertCaptureSources(sources, { m365 = false } = {}) {
  if (sources === undefined) return;
  const unsupported = sources.filter((source) => !CAPTURE_SOURCES.includes(source));
  if (unsupported.length > 0) {
    throw new Error(`--sources ${unsupported.join(",")} is not available with --source capture: only crm (Salesforce capture) and internal_document (--capture-m365) are served.`);
  }
  if (!m365 && sources.includes("internal_document")) {
    throw new Error("--sources internal_document requires --capture-m365 PATH (and --m365-mapping): no M365 capture was given.");
  }
  if (m365 && !sources.includes("internal_document")) {
    process.stderr.write("capture: WARNING: --capture-m365 is given but --sources excludes internal_document; the M365 capture will not be used.\n");
  }
}

/**
 * Warn (stderr, no payload content) when a capture or mapping file is not git-ignored. Never
 * changes the exit code; skipped silently when git is unavailable or the file is outside any
 * repository.
 * @param {string} path
 * @param {"capture"|"mapping"} [kind]
 * @returns {boolean} true when a warning was written
 */
export function warnIfNotGitIgnored(path, kind = "capture") {
  let status;
  try {
    const checked = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: dirname(path), stdio: "ignore" });
    if (checked.error) return false;
    status = checked.status;
  } catch {
    return false;
  }
  if (status !== 1) return false; // 0 = ignored; anything else (e.g. 128 = not a repository) = skip silently
  process.stderr.write(kind === "mapping"
    ? "capture: WARNING: the M365 mapping file is not git-ignored. It may contain customer names: "
      + "keep it under the repository's local/ directory and never commit it.\n"
    : "capture: WARNING: the capture file is not git-ignored. Raw captures may contain real customer data: "
      + "keep them under the repository's .captures/ directory and never commit them.\n");
  return true;
}

function loadOrThrow(path, options) {
  try {
    return loadCapture(path, options);
  } catch (cause) {
    throw new Error(`The capture could not be loaded (${cause?.code ?? "CAPTURE_UNREADABLE"}): ${cause?.message ?? "unknown error"}`);
  }
}

/** Wrap a replay client so every unmatched/exhausted call is recorded in `misses` (tool only). */
function trackMisses(client, misses) {
  return {
    listTools: () => client.listTools(),
    async callTool(name, args) {
      try {
        return await client.callTool(name, args);
      } catch (error) {
        if (error?.code === "REPLAY_UNMATCHED") misses.push({ tool: error.tool ?? name, reason: error.reason ?? "replay_unmatched" });
        throw error;
      }
    },
  };
}

/**
 * Load capture(s) (strict replay, default redaction) and build the adapter set.
 * A string argument is a Salesforce capture path (unchanged behaviour). The object form may add
 * an M365 capture + mapping; `capturePath` may then be omitted (source-rank only).
 * @param {string|{capturePath?: string, m365CapturePath?: string, m365MappingPath?: string}} source
 * @returns {{deps: object, misses: Array<{tool: string, reason: string}>, diagnostics: object[],
 *   defaultSources: string[], latestCreatedAt: string}}
 * @throws {Error} with a safe message when a capture or the mapping cannot be loaded
 */
export function createCaptureSession(source) {
  const { capturePath, m365CapturePath, m365MappingPath } = typeof source === "string" ? { capturePath: source } : source;
  const misses = [];
  const diagnostics = [];
  const createdAt = [];
  const deps = {};
  const evidenceAdapters = {};
  const extractors = [];
  const defaultSources = [];

  if (capturePath !== undefined) {
    const client = loadOrThrow(capturePath, undefined);
    if (client.capture?.source_system !== "salesforce") {
      throw new Error("The capture is not a Salesforce capture (capture.source_system must be salesforce).");
    }
    warnIfNotGitIgnored(capturePath);
    createdAt.push(client.capture.created_at);
    const tracked = trackMisses(client, misses);
    deps.accountAdapter = createSalesforceAccountAdapter({ client: tracked });
    evidenceAdapters.crm = createSalesforceEvidenceAdapter({ client: tracked });
    extractors.push(createSalesforceStructuredClaimExtractor());
    defaultSources.push("crm");
  }

  if (m365CapturePath !== undefined) {
    const client = loadOrThrow(m365CapturePath, { redact: [...M365_REDACT] });
    if (client.capture?.source_system !== "m365") {
      throw new Error("The capture is not an M365 capture (capture.source_system must be m365).");
    }
    // An M365 capture is by definition a sharepoint_search capture: an empty skeleton must make a
    // mapped account's call a replay miss (REPLAY_INCOMPLETE), not an unknown tool.
    client.tools = [{ name: M365_TOOL }];
    warnIfNotGitIgnored(m365CapturePath);
    let mapping;
    try {
      mapping = loadM365AccountMapping(m365MappingPath);
    } catch (cause) {
      const detail = cause instanceof M365MappingError && cause.problems.length > 0 ? ` ${cause.problems.join("; ")}` : "";
      throw new Error(`${cause instanceof M365MappingError ? cause.message : "The M365 account mapping could not be loaded."}${detail}`);
    }
    warnIfNotGitIgnored(m365MappingPath, "mapping");
    createdAt.push(client.capture.created_at);
    const captureTime = new Date(client.capture.created_at);
    evidenceAdapters.internal_document = createM365SharePointEvidenceAdapter({
      client: trackMisses(client, misses),
      mapping,
      now: () => captureTime,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    extractors.push(createM365StructuredClaimExtractor());
    defaultSources.push("internal_document");
  }

  deps.evidenceAdapter = m365CapturePath === undefined ? evidenceAdapters.crm : createSourceRouterEvidenceAdapter(evidenceAdapters);
  deps.claimExtractor = createCompositeClaimExtractor(extractors);
  return {
    deps,
    misses,
    diagnostics,
    defaultSources,
    latestCreatedAt: createdAt.reduce((latest, stamp) => (Date.parse(stamp) > Date.parse(latest) ? stamp : latest)),
  };
}

/** `capture: <CODE>: <fixed text with count>`; never names, paths, URLs or snippets. */
export function formatDiagnostic({ code, count, kept }) {
  const text = M365_DIAGNOSTIC_TEXT[code] ?? "diagnostic.";
  if (code === "M365_RECORDS_TRUNCATED") return `capture: ${code}: kept ${kept} of ${count} ${text}`;
  return `capture: ${code}: ${count === undefined ? "" : `${count} `}${text}`;
}

/** Print the session's M365 diagnostics (counts only) to stderr. */
export function emitCaptureDiagnostics(session) {
  for (const diagnostic of session?.diagnostics ?? []) process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
}

/** The re-capture instruction for a REPLAY_INCOMPLETE failure, naming the plan CLI(s) of the missed tool(s). */
export function replayIncompleteMessage(misses) {
  const m365 = misses.some((miss) => miss.tool === M365_TOOL);
  const salesforce = misses.some((miss) => miss.tool !== M365_TOOL);
  const hints = [];
  if (salesforce) {
    hints.push("run `npm run salesforce-capture-plan` for the account (Phase 1) and its Salesforce Id (Phase 2)");
  }
  if (m365) {
    hints.push("run `npm run m365-capture-plan -- --account-id sf_<Id>` for the M365 search calls");
  }
  return "capture: REPLAY_INCOMPLETE: failed: incomplete capture. The capture has no (or no further) recorded response for a call the workflow made; "
    + `ignore the status and artifact in the JSON result. Re-capture: ${hints.join("; and ")}, `
    + "record every printed call including pagination, then re-run with --source capture.\n";
}

/**
 * Apply the capture-specific outcome to a workflow exit code. M365 diagnostics are printed first
 * (stderr, counts only). A replay miss means the capture does not cover what the workflow asked
 * for: always a failure (exit 1) that tells the host to re-capture, whatever status the workflow
 * derived from it.
 */
export function captureExitCode(code, session) {
  if (!session) return code;
  emitCaptureDiagnostics(session);
  if (session.misses.length === 0) return code;
  process.stderr.write(replayIncompleteMessage(session.misses));
  return 1;
}
