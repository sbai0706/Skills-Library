import { readFileSync, statSync } from "node:fs";
import { validate } from "../../schemas/index.js";
import { ReplayMcpClient } from "./replay-client.js";

/**
 * Capture loader. Raw captures may contain real customer data: keep them under
 * the git-ignored .captures/ directory and never commit them.
 */
export const CAPTURE_LIMITS = Object.freeze({
  maxEntries: 1000,
  maxEntryBytes: 2 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
});
export const REDACTION_MARKER = "[REDACTED]";

export class CaptureError extends Error {
  /** @param {"CAPTURE_UNREADABLE"|"CAPTURE_INVALID"|"CAPTURE_TOO_LARGE"} code */
  constructor(code, message, details) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    if (details) this.details = details;
  }
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function matches(pattern, key, trail) {
  if (!pattern.includes(".")) return pattern === key;
  const parts = pattern.split(".");
  return parts.length === trail.length && parts.every((p, i) => p === "*" || p === trail[i]);
}

function redactValue(value, patterns, trail = []) {
  if (Array.isArray(value)) return value.map((v, i) => redactValue(v, patterns, [...trail, String(i)]));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const here = [...trail, key];
      out[key] = patterns.some((p) => matches(p, key, here)) ? REDACTION_MARKER : redactValue(v, patterns, here);
    }
    return out;
  }
  if (typeof value === "string" && trail.at(-1) === "text") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { return JSON.stringify(redactValue(JSON.parse(t), patterns, [])); } catch { /* not JSON */ }
    }
  }
  return value;
}

/**
 * Replace values of matching keys with REDACTION_MARKER in each entry's result and
 * error (args are left intact so call matching is unaffected). A pattern without
 * "." matches that key at any depth; a dotted pattern is a path from the result/error
 * root where "*" matches any key or array index (e.g. "structuredContent.records.*.Email").
 * JSON embedded in MCP text content blocks is redacted too (patterns apply from its root).
 */
export function redactEntries(entries, paths) {
  const patterns = (paths ?? []).filter((p) => typeof p === "string" && p !== "");
  if (patterns.length === 0) return entries;
  return entries.map((e) => ({
    ...e,
    ...(e.result !== undefined ? { result: redactValue(e.result, patterns) } : {}),
    ...(e.error !== undefined ? { error: redactValue(e.error, patterns) } : {}),
  }));
}

/**
 * Load, validate (schema + limits), optionally redact, and return a replay client.
 * @param {string|object} source  Path to a capture JSON file, or an already parsed document.
 * @param {{redact?: string[], limits?: Partial<typeof CAPTURE_LIMITS>}} [options]
 *   `limits` may only tighten the defaults.
 * @returns {ReplayMcpClient}  with `.capture` (metadata) attached.
 * @throws {CaptureError}
 */
export function loadCapture(source, options = {}) {
  const limits = {};
  for (const k of Object.keys(CAPTURE_LIMITS)) limits[k] = Math.min(options.limits?.[k] ?? CAPTURE_LIMITS[k], CAPTURE_LIMITS[k]);
  let doc = source;
  if (typeof source === "string") {
    try {
      const size = statSync(source).size;
      if (size > limits.maxFileBytes) throw new CaptureError("CAPTURE_TOO_LARGE", `Capture file exceeds ${limits.maxFileBytes} bytes`, { bytes: size });
      doc = JSON.parse(readFileSync(source, "utf8"));
    } catch (cause) {
      if (cause instanceof CaptureError) throw cause;
      throw new CaptureError("CAPTURE_UNREADABLE", cause instanceof SyntaxError ? "Capture file is not valid JSON" : "Capture file cannot be read");
    }
  } else if (typeof doc === "object" && doc !== null) {
    const size = bytes(doc);
    if (size > limits.maxFileBytes) throw new CaptureError("CAPTURE_TOO_LARGE", `Capture exceeds ${limits.maxFileBytes} bytes`, { bytes: size });
  }
  if (Array.isArray(doc?.entries) && doc.entries.length > limits.maxEntries) {
    throw new CaptureError("CAPTURE_TOO_LARGE", `Capture has more than ${limits.maxEntries} entries`, { entries: doc.entries.length });
  }
  const { valid, errors } = validate("mcpCapture", doc);
  if (!valid) {
    throw new CaptureError("CAPTURE_INVALID", `Capture does not match schema: ${errors.map((e) => `${e.path} ${e.message}`).slice(0, 5).join("; ")}`, { errors });
  }
  doc.entries.forEach((entry, index) => {
    const size = bytes(entry);
    if (size > limits.maxEntryBytes) throw new CaptureError("CAPTURE_TOO_LARGE", `Entry ${index} exceeds ${limits.maxEntryBytes} bytes`, { index, bytes: size });
  });
  const client = new ReplayMcpClient({ entries: redactEntries(doc.entries, options.redact) });
  client.capture = { ...doc.capture };
  return client;
}
