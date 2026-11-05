import { mapMcpError, unwrapToolResult } from "../mcp/index.js";

/**
 * M365 (Microsoft Graph via the connector) error classification. Reuses the shared ADAPTER_*
 * codes (no new codes). Payload: `{code, message, details: {graphErrorCode, graphStatusCode,
 * graphRequestId, graphRetryAfterSeconds, driveId, itemId, uriPath, ...}}`; the same keys are
 * also accepted at the top level.
 *
 * | Condition (in order)                   | code                | retryable | details.reason          |
 * | graphStatusCode 401                    | ADAPTER_UNAUTHORIZED| false     | unauthenticated         |
 * | graphStatusCode 403                    | ADAPTER_UNAUTHORIZED| false     | forbidden               |
 * | 429, or graphRetryAfterSeconds number  | ADAPTER_UNAVAILABLE | true      | rate_limited            |
 * | 408 or >= 500                          | ADAPTER_UNAVAILABLE | true      | transient               |
 * | 400 / 404                              | ADAPTER_UNAVAILABLE | false     | request_rejected / not_found |
 * | other status >= 400                    | ADAPTER_UNAVAILABLE | false     | graph_error             |
 * | no usable status                       | per T1 mapMcpError  |           |                         |
 *
 * Messages are fixed strings. Graph `message`, `driveId`, `itemId`, `uriPath` and
 * `graphRequestId` are never echoed; `details` keeps only reason, status_code, graph_error_code
 * (identifier-shaped only) and retry_after_seconds.
 */

const GRAPH_CODE = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;

function adapterError(code, message, retryable, details) {
  return { code, message, retryable, details };
}

function pick(payload, key) {
  const nested = payload?.details;
  if (typeof nested === "object" && nested !== null && nested[key] !== undefined) return nested[key];
  return payload?.[key];
}

/**
 * Classify a raw M365 connector error payload. Returns an AdapterError, or null when the payload
 * carries no usable status or retry-after hint (the caller falls back to T1).
 * @param {unknown} payload
 */
export function classifyM365Error(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const rawStatus = pick(payload, "graphStatusCode");
  const status = Number.isInteger(rawStatus) ? rawStatus : null;
  const retryAfter = pick(payload, "graphRetryAfterSeconds");
  const hasRetryAfter = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0;
  const graphCode = pick(payload, "graphErrorCode");
  const base = {
    ...(status !== null ? { status_code: status } : {}),
    ...(typeof graphCode === "string" && GRAPH_CODE.test(graphCode) ? { graph_error_code: graphCode } : {}),
  };
  const out = (code, message, retryable, reason, extra = {}) => adapterError(code, message, retryable, { reason, ...base, ...extra });

  if (status === 401) return out("ADAPTER_UNAUTHORIZED", "Microsoft 365 rejected the credentials.", false, "unauthenticated");
  if (status === 403) return out("ADAPTER_UNAUTHORIZED", "Microsoft 365 denied access.", false, "forbidden");
  if (status === 429 || hasRetryAfter) {
    return out("ADAPTER_UNAVAILABLE", "Microsoft 365 rate limit reached.", true, "rate_limited", hasRetryAfter ? { retry_after_seconds: retryAfter } : {});
  }
  if (status !== null && (status === 408 || status >= 500)) return out("ADAPTER_UNAVAILABLE", "Microsoft 365 temporarily unavailable.", true, "transient");
  if (status === 400) return out("ADAPTER_UNAVAILABLE", "Microsoft 365 rejected the request.", false, "request_rejected");
  if (status === 404) return out("ADAPTER_UNAVAILABLE", "Microsoft 365 item or drive not found.", false, "not_found");
  if (status !== null && status >= 400) return out("ADAPTER_UNAVAILABLE", "Microsoft 365 returned an error.", false, "graph_error");
  return null;
}

/**
 * Convert a thrown value from `client.callTool` into an AdapterError: recorded connector errors
 * (`TOOL_ERROR` with `payload`) are classified M365-specifically; everything else (replay misses,
 * tool not found, transport) goes through T1 `mapMcpError`.
 */
export function toM365AdapterError(thrown) {
  if (thrown?.code === "TOOL_ERROR" && thrown.payload !== undefined) {
    return classifyM365Error(thrown.payload) ?? mapMcpError(thrown);
  }
  return mapMcpError(thrown);
}

/** AdapterError for a resolved `isError: true` tool result. */
export function classifyIsErrorResult(result) {
  const texts = Array.isArray(result?.content)
    ? result.content.filter((block) => block?.type === "text" && typeof block.text === "string")
    : [];
  if (texts.length === 1) {
    try {
      const classified = classifyM365Error(JSON.parse(texts[0].text));
      if (classified) return classified;
    } catch { /* not JSON: fall through */ }
  }
  const structured = classifyM365Error(result?.structuredContent);
  if (structured) return structured;
  return unwrapToolResult(result).error;
}
