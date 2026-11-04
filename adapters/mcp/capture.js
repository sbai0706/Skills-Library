import { readFileSync, statSync } from "node:fs";
import { validate } from "../../schemas/index.js";
import { ReplayMcpClient } from "./replay-client.js";
import { isErrorResult } from "./errors.js";

/**
 * Capture loader. Raw captures may contain real customer data: keep them under
 * the git-ignored .captures/ directory and never commit them. The capture file on
 * disk stays raw; redaction applies in memory only.
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

function bytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch {
    throw new CaptureError("CAPTURE_INVALID", "Capture is not JSON-serializable (circular reference or unsupported value)");
  }
}

function matches(pattern, key, trail) {
  if (!pattern.includes(".")) return pattern === key;
  const parts = pattern.split(".");
  return parts.length === trail.length && parts.every((p, i) => p === "*" || p === trail[i]);
}

/**
 * Redact patterns and (when `messages`) `message` fields. Strings under ANY key that look like
 * JSON ('{' or '[' after trim) are parsed, redacted from their own root, and re-serialized.
 */
function redactValue(value, patterns, messages, trail = []) {
  if (Array.isArray(value)) return value.map((v, i) => redactValue(v, patterns, messages, [...trail, String(i)]));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const here = [...trail, key];
      const hit = patterns.some((p) => matches(p, key, here)) || (messages && key === "message");
      out[key] = hit ? REDACTION_MARKER : redactValue(v, patterns, messages, here);
    }
    return out;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { return JSON.stringify(redactValue(JSON.parse(t), patterns, messages, [])); } catch { /* not JSON */ }
    }
  }
  return value;
}

/**
 * Replace values of matching keys with REDACTION_MARKER in each entry's result and
 * error (args are left intact so call matching is unaffected). A pattern without
 * "." matches that key at any depth; a dotted pattern is a path from the result/error
 * root where "*" matches any key or array index (e.g. "structuredContent.records.*.Email").
 * JSON-string values under any key (MCP text blocks, double-encoded connector bodies) are
 * parsed, redacted (patterns apply from their root) and re-serialized.
 * With `redactErrorMessages` (default true) every `message` field inside `error` entries and
 * error-shaped results (isError / connector error bodies) is replaced too.
 * @param {object[]} entries
 * @param {string[]} [paths]
 * @param {{redactErrorMessages?: boolean}} [options]
 */
export function redactEntries(entries, paths, { redactErrorMessages = true } = {}) {
  const patterns = (paths ?? []).filter((p) => typeof p === "string" && p !== "");
  if (patterns.length === 0 && !redactErrorMessages) return entries;
  return entries.map((e) => {
    const out = { ...e };
    if (e.result !== undefined) {
      const errorLike = redactErrorMessages && isErrorResult(e.result);
      out.result = redactValue(e.result, patterns, errorLike);
      if (errorLike && e.result?.isError === true && Array.isArray(out.result.content)) {
        // plain-text (non-JSON) isError messages are replaced wholesale
        out.result.content = out.result.content.map((c) =>
          (c?.type === "text" && typeof c.text === "string" && !/^\s*[{[]/.test(c.text) ? { ...c, text: REDACTION_MARKER } : c));
      }
    }
    if (e.error !== undefined) out.error = redactValue(e.error, patterns, redactErrorMessages);
    return out;
  });
}

function resolveLimits(requested) {
  const limits = { ...CAPTURE_LIMITS };
  if (requested === undefined) return limits;
  if (typeof requested !== "object" || requested === null) throw new CaptureError("CAPTURE_INVALID", "limits must be an object");
  for (const [k, v] of Object.entries(requested)) {
    if (!(k in CAPTURE_LIMITS)) throw new CaptureError("CAPTURE_INVALID", `Unknown limit: ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new CaptureError("CAPTURE_INVALID", `limit ${k} must be a positive finite number`);
    limits[k] = Math.min(v, CAPTURE_LIMITS[k]);
  }
  return limits;
}

/**
 * Load, validate (schema + limits), optionally redact, and return a replay client.
 * @param {string|object} source  Path to a capture JSON file, or an already parsed document.
 * @param {{redact?: string[], redactErrorMessages?: boolean, limits?: Partial<typeof CAPTURE_LIMITS>, reuseLast?: boolean}} [options]
 *   `limits` may only tighten the defaults and must be positive finite numbers.
 *   `redactErrorMessages` defaults to true. `reuseLast` is passed to the replay client.
 * @returns {ReplayMcpClient}  with `.capture` (metadata) attached.
 * @throws {CaptureError}
 */
export function loadCapture(source, options = {}) {
  const limits = resolveLimits(options.limits);
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
  const entries = redactEntries(doc.entries, options.redact, { redactErrorMessages: options.redactErrorMessages ?? true });
  const client = new ReplayMcpClient({ entries, reuseLast: options.reuseLast === true });
  client.capture = { ...doc.capture };
  return client;
}
