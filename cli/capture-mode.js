import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadCapture } from "../adapters/mcp/index.js";
import {
  createCompositeClaimExtractor,
  createSalesforceAccountAdapter,
  createSalesforceEvidenceAdapter,
  createSalesforceStructuredClaimExtractor,
} from "../adapters/salesforce/index.js";

/**
 * Shared CLI wiring for `--source fixture|capture` and `--capture <path>` (Mode A).
 * Capture mode replays a host-recorded Salesforce capture; it never falls back to fixtures.
 */

export const SOURCE_FLAGS = Object.freeze(["--source", "--capture"]);

/** Only the CRM source is served by the Salesforce adapters. */
export const CAPTURE_SOURCES = Object.freeze(["crm"]);

/**
 * Validate the source options of an already tokenized argument map.
 * @param {Record<string, string>} parsed option -> value
 * @param {{incompatible?: Array<[string, string]>}} [rules] `[flag, reason]` pairs rejected in capture mode
 * @returns {{source: "fixture"|"capture", capturePath?: string}}
 * @throws {Error} invalid usage (callers exit 1)
 */
export function resolveSourceOptions(parsed, { incompatible = [] } = {}) {
  const source = parsed["--source"] ?? "fixture";
  if (source !== "fixture" && source !== "capture") throw new Error("--source must be fixture or capture.");
  const hasCapture = Object.hasOwn(parsed, "--capture");
  if (source === "fixture") {
    if (hasCapture) throw new Error("--capture requires --source capture.");
    return { source };
  }
  if (!hasCapture || parsed["--capture"].trim() === "") throw new Error("--source capture requires --capture PATH.");
  for (const [flag, reason] of incompatible) {
    if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} cannot be used with --source capture: ${reason}`);
  }
  const capturePath = resolve(parsed["--capture"]);
  let isFile = false;
  try { isFile = statSync(capturePath).isFile(); } catch { isFile = false; }
  if (!isFile) throw new Error("--capture must be the path of an existing capture file.");
  return { source, capturePath };
}

/** In capture mode only `crm` can be served; anything else is invalid usage, not a silent fallback. */
export function assertCaptureSources(sources) {
  if (sources === undefined) return;
  const unsupported = sources.filter((source) => !CAPTURE_SOURCES.includes(source));
  if (unsupported.length > 0) {
    throw new Error(`--sources ${unsupported.join(",")} is not available with --source capture: only crm is served by the Salesforce capture.`);
  }
}

/**
 * Load a capture (strict replay, default redaction) and build the Salesforce adapter set.
 * @returns {{deps: object, misses: Array<{tool: string, reason: string}>}}
 * @throws {Error} with a safe message when the capture cannot be loaded
 */
export function createCaptureSession(capturePath) {
  let client;
  try {
    client = loadCapture(capturePath);
  } catch (cause) {
    throw new Error(`The capture could not be loaded (${cause?.code ?? "CAPTURE_UNREADABLE"}): ${cause?.message ?? "unknown error"}`);
  }
  const misses = [];
  const tracked = {
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
  return {
    deps: {
      accountAdapter: createSalesforceAccountAdapter({ client: tracked }),
      evidenceAdapter: createSalesforceEvidenceAdapter({ client: tracked }),
      claimExtractor: createCompositeClaimExtractor([createSalesforceStructuredClaimExtractor()]),
    },
    misses,
  };
}

/**
 * Apply the capture-specific outcome to a workflow exit code. A replay miss means the capture
 * does not cover what the workflow asked for: always a failure (exit 1) that tells the host to
 * re-capture, whatever status the workflow derived from it.
 */
export function captureExitCode(code, session) {
  if (!session || session.misses.length === 0) return code;
  process.stderr.write(
    "capture: REPLAY_INCOMPLETE: the capture has no (or no further) recorded response for a call the workflow made. "
    + "Re-capture: run `npm run salesforce-capture-plan` for the account (Phase 1) and its Salesforce Id (Phase 2), "
    + "record every printed call including pagination, then re-run with --source capture.\n",
  );
  return 1;
}
