/**
 * MCP/connector failure -> shared adapter error mapping. Reuses the existing
 * ADAPTER_* codes (no new codes).
 *
 * | Condition                                                         | code                       | retryable |
 * | tool not found / unmatched or exhausted replay call               | ADAPTER_UNAVAILABLE        | false     |
 * | HTTP 401 INVALID_AUTH_HEADER / message has INVALID_SCOPES (transient) | ADAPTER_UNAUTHORIZED    | true      |
 * | HTTP 401/403, auth error code, "UNAUTHORIZED"                     | ADAPTER_UNAUTHORIZED       | false     |
 * | HTTP 400 (e.g. INVALID_TYPE), 404                                 | ADAPTER_UNAVAILABLE        | false     |
 * | HTTP 408/429/5xx, other transport errors, "UNAVAILABLE"           | ADAPTER_UNAVAILABLE        | true      |
 * | isError tool result without recognizable status                   | ADAPTER_UNAVAILABLE        | false     |
 * | malformed payload / unparseable result                            | ADAPTER_MALFORMED_RESPONSE | false     |
 *
 * `retryable` is advisory: the library never retries; Mode A retry is the host's job at capture time.
 * Only `status_code >= 400` or a non-empty string `error_code` marks an error; a 2xx connector
 * envelope ({status_code, body, url}) is a success. `details.reason` is a short machine label;
 * details never include bodies.
 */

const AUTH_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "INVALID_SESSION_ID", "INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS_OR_READONLY", "INVALID_AUTH_HEADER"]);

function err(code, message, retryable, details) {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

function isTransientAuth(shape) {
  return shape.status === 401 && (shape.bodyCode === "INVALID_AUTH_HEADER" || shape.code === "INVALID_AUTH_HEADER" ||
    /INVALID_SCOPES/.test(`${shape.message ?? ""}`));
}

function fromStatus(status, label) {
  const details = { reason: label ?? `http_${status}`, status_code: status };
  if (status === 401 || status === 403) return err("ADAPTER_UNAUTHORIZED", "MCP connector denied access.", false, details);
  if (status === 408 || status === 429 || status >= 500) return err("ADAPTER_UNAVAILABLE", "MCP connector temporarily unavailable.", true, details);
  if (status === 400 || status === 404) return err("ADAPTER_UNAVAILABLE", "MCP connector rejected the request.", false, details);
  return err("ADAPTER_UNAVAILABLE", "MCP connector returned an error.", false, details);
}

function parseJsonString(value) {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try { return JSON.parse(t); } catch { return value; }
}

/** Connector error shape: only status_code >= 400 or a non-empty string error_code. */
function connectorErrorShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const status = Number.isInteger(value.status_code) ? value.status_code : null;
  const code = typeof value.error_code === "string" && value.error_code !== "" ? value.error_code : null;
  if (!(status !== null && status >= 400) && code === null) return null;
  const body = parseJsonString(value.body);
  const first = Array.isArray(body) ? body[0] : body;
  return {
    status: status !== null && status >= 400 ? status : null,
    code,
    bodyCode: typeof first?.errorCode === "string" ? first.errorCode : null,
    message: typeof first?.message === "string" ? first.message : null,
  };
}

function isSuccessEnvelope(value) {
  return Number.isInteger(value?.status_code) && value.status_code >= 200 && value.status_code < 400 && ("body" in value || "url" in value);
}

function mapShape(shape) {
  const label = shape.bodyCode ?? shape.code ?? undefined;
  if (isTransientAuth(shape)) {
    return err("ADAPTER_UNAUTHORIZED", "MCP connector authorization failed transiently.", true,
      { reason: shape.bodyCode ?? shape.code ?? "INVALID_SCOPES", status_code: shape.status, transient: true });
  }
  const auth = AUTH_CODES.has(shape.bodyCode) || AUTH_CODES.has(shape.code);
  if (shape.status !== null) {
    const mapped = fromStatus(shape.status, label);
    return auth ? err("ADAPTER_UNAUTHORIZED", "MCP connector denied access.", false, mapped.details) : mapped;
  }
  if (auth) return err("ADAPTER_UNAUTHORIZED", "MCP connector denied access.", false, { reason: label });
  return err("ADAPTER_UNAVAILABLE", "MCP connector returned an error.", false, { reason: label });
}

/**
 * Map a thrown value (McpClientError, {code: "UNAUTHORIZED"|"UNAVAILABLE"},
 * connector error object, or any Error) to an AdapterError.
 * @param {unknown} cause
 */
export function mapMcpError(cause) {
  const code = cause?.code;
  if (code === "TOOL_NOT_FOUND") return err("ADAPTER_UNAVAILABLE", "MCP tool not found.", false, { reason: "tool_not_found", tool: cause.tool });
  if (code === "REPLAY_UNMATCHED") return err("ADAPTER_UNAVAILABLE", "No captured response matches this call.", false, { reason: cause.reason ?? "replay_unmatched", tool: cause.tool });
  if (code === "UNAUTHORIZED") return err("ADAPTER_UNAUTHORIZED", "MCP connector denied access.", false, { reason: "unauthorized" });
  if (code === "UNAVAILABLE") return err("ADAPTER_UNAVAILABLE", "MCP connector unavailable.", true, { reason: "unavailable" });
  const shape = connectorErrorShape(cause?.payload) ?? connectorErrorShape(cause);
  if (shape) return mapShape(shape);
  if (code === "TOOL_ERROR") return err("ADAPTER_UNAVAILABLE", "MCP tool reported an error.", false, { reason: "tool_error" });
  return err("ADAPTER_UNAVAILABLE", "MCP call failed.", true, { reason: "transport_error" });
}

function parseText(result) {
  const texts = Array.isArray(result.content) ? result.content.filter((c) => c?.type === "text" && typeof c.text === "string") : [];
  if (texts.length !== 1) return { found: false };
  try { return { found: true, text: texts[0].text, value: JSON.parse(texts[0].text) }; } catch { return { found: false, text: texts[0].text }; }
}

/** Classify a parsed value: connector error, success envelope (unwrapped), or plain payload. */
function classify(value) {
  const shape = connectorErrorShape(value);
  if (shape) return { ok: false, error: mapShape(shape) };
  if (isSuccessEnvelope(value)) {
    const body = parseJsonString(value.body);
    return { ok: true, payload: body === undefined ? null : body, meta: { status_code: value.status_code, ...(typeof value.url === "string" ? { url: value.url } : {}) } };
  }
  return { ok: true, payload: value };
}

/** Fallback for plain-text isError content, e.g. "API call failed with status 401". */
function shapeFromPlainText(text) {
  if (typeof text !== "string") return null;
  const status = /\b([45]\d\d)\b/.exec(text);
  const scopes = /INVALID_SCOPES/.test(text);
  const authHeader = /INVALID_AUTH_HEADER/.test(text);
  if (!status && !scopes && !authHeader) return null;
  return { status: status ? Number(status[1]) : scopes || authHeader ? 401 : null, code: authHeader ? "INVALID_AUTH_HEADER" : null, bodyCode: null, message: text };
}

/**
 * Inspect a resolved tool result. Returns {ok: true, payload, meta?} where payload is
 * (a 2xx connector envelope's body, else) structuredContent, else the single JSON text
 * block, else the object itself; `meta` = {status_code, url?} for connector envelopes.
 * Returns {ok: false, error} for isError results, connector error shapes (status_code >= 400
 * or non-empty error_code, also inside structuredContent or JSON text), and malformed results.
 * @param {unknown} result
 * @returns {{ok: true, payload: unknown, meta?: object} | {ok: false, error: object}}
 */
export function unwrapToolResult(result) {
  const malformed = (reason) => ({ ok: false, error: err("ADAPTER_MALFORMED_RESPONSE", "MCP tool result is malformed.", false, { reason }) });
  if (typeof result !== "object" || result === null || Array.isArray(result)) return malformed("not_an_object");
  const text = parseText(result);
  const structured = result.structuredContent;
  if (result.isError === true) {
    const shape = connectorErrorShape(text.found ? text.value : structured) ?? shapeFromPlainText(text.text);
    return { ok: false, error: shape ? mapShape(shape) : err("ADAPTER_UNAVAILABLE", "MCP tool reported an error.", false, { reason: "tool_is_error" }) };
  }
  if (structured !== undefined) {
    if (typeof structured !== "object" || structured === null) return malformed("structured_content_invalid");
    return classify(structured);
  }
  if ("content" in result) {
    if (!Array.isArray(result.content)) return malformed("content_invalid");
    if (!text.found) return malformed("content_not_json");
    return classify(text.value);
  }
  return classify(result);
}

/** True when a captured result represents an error (used by redaction; malformed does not count). */
export function isErrorResult(result) {
  const u = unwrapToolResult(result);
  return u.ok === false && u.error.code !== "ADAPTER_MALFORMED_RESPONSE";
}
