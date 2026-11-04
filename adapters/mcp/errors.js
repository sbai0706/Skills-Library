/**
 * MCP/connector failure -> shared adapter error mapping. Reuses the existing
 * ADAPTER_* codes (no new codes).
 *
 * | Condition                                              | code                         | retryable |
 * | tool not found / unmatched replay call                 | ADAPTER_UNAVAILABLE          | false     |
 * | HTTP 401/403, auth error_code, "UNAUTHORIZED"          | ADAPTER_UNAUTHORIZED         | false     |
 * | HTTP 400 (e.g. INVALID_TYPE), 404                      | ADAPTER_UNAVAILABLE          | false     |
 * | HTTP 408/429/5xx, other transport errors, "UNAVAILABLE"| ADAPTER_UNAVAILABLE          | true      |
 * | isError tool result without recognizable status        | ADAPTER_UNAVAILABLE          | false     |
 * | malformed payload / unparseable result                 | ADAPTER_MALFORMED_RESPONSE   | false     |
 *
 * `details.reason` carries a short machine label; details never include bodies.
 */

const AUTH_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "INVALID_SESSION_ID", "INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS_OR_READONLY"]);

function err(code, message, retryable, details) {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

function fromStatus(status, label) {
  const details = { reason: label ?? `http_${status}`, status_code: status };
  if (status === 401 || status === 403) return err("ADAPTER_UNAUTHORIZED", "MCP connector denied access.", false, details);
  if (status === 408 || status === 429 || status >= 500) return err("ADAPTER_UNAVAILABLE", "MCP connector temporarily unavailable.", true, details);
  if (status === 400 || status === 404) return err("ADAPTER_UNAVAILABLE", "MCP connector rejected the request.", false, details);
  return err("ADAPTER_UNAVAILABLE", "MCP connector returned an error.", false, details);
}

/** Recognize connector error shapes: {error_code, status_code, body} or {status_code}. */
function connectorErrorShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const status = Number.isInteger(value.status_code) ? value.status_code : null;
  const code = typeof value.error_code === "string" ? value.error_code : null;
  let body = value.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep raw */ } }
  const first = Array.isArray(body) ? body[0] : body;
  const bodyCode = typeof first?.errorCode === "string" ? first.errorCode : null;
  if (status === null && code === null) return null;
  return { status, code, bodyCode };
}

function mapShape(shape) {
  const label = shape.bodyCode ?? shape.code ?? undefined;
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
  if (code === "REPLAY_UNMATCHED") return err("ADAPTER_UNAVAILABLE", "No captured response matches this call.", false, { reason: "replay_unmatched", tool: cause.tool });
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
  try { return { found: true, value: JSON.parse(texts[0].text) }; } catch { return { found: false }; }
}

/**
 * Inspect a resolved tool result. Returns {ok: true, payload} where payload is
 * structuredContent, else the single JSON text block, else the object itself;
 * or {ok: false, error} for isError results, connector error shapes, and
 * malformed (non-object / unparseable) results.
 * @param {unknown} result
 * @returns {{ok: true, payload: unknown} | {ok: false, error: object}}
 */
export function unwrapToolResult(result) {
  const malformed = (reason) => ({ ok: false, error: err("ADAPTER_MALFORMED_RESPONSE", "MCP tool result is malformed.", false, { reason }) });
  if (typeof result !== "object" || result === null || Array.isArray(result)) return malformed("not_an_object");
  const text = parseText(result);
  if (result.isError === true) {
    const shape = connectorErrorShape(text.found ? text.value : result.structuredContent);
    return { ok: false, error: shape ? mapShape(shape) : err("ADAPTER_UNAVAILABLE", "MCP tool reported an error.", false, { reason: "tool_is_error" }) };
  }
  const isEnvelope = "content" in result || "structuredContent" in result;
  const direct = connectorErrorShape(result);
  if (direct && !isEnvelope) return { ok: false, error: mapShape(direct) };
  if (result.structuredContent !== undefined) {
    if (typeof result.structuredContent !== "object" || result.structuredContent === null) return malformed("structured_content_invalid");
    return { ok: true, payload: result.structuredContent };
  }
  if ("content" in result) {
    if (!Array.isArray(result.content)) return malformed("content_invalid");
    if (!text.found) return malformed("content_not_json");
    const embedded = connectorErrorShape(text.value);
    if (embedded) return { ok: false, error: mapShape(embedded) };
    return { ok: true, payload: text.value };
  }
  return { ok: true, payload: result };
}
