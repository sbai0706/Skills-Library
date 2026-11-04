import { mapMcpError } from "../mcp/index.js";

/**
 * Salesforce-specific error classification. Reuses the shared ADAPTER_* codes (no new codes).
 *
 * | HTTP           | Salesforce errorCode                 | code                | retryable | details.reason        |
 * | 401            | INVALID_AUTH_HEADER / INVALID_SCOPES | ADAPTER_UNAUTHORIZED| true      | transient_auth (T1)   |
 * | 401            | other                                | ADAPTER_UNAUTHORIZED| false     | unauthenticated       |
 * | 403            | REQUEST_LIMIT_EXCEEDED               | ADAPTER_UNAVAILABLE | true      | rate_limited          |
 * | 403            | other                                | ADAPTER_UNAUTHORIZED| false     | forbidden             |
 * | 400            | INVALID_FIELD                        | ADAPTER_UNAUTHORIZED| false     | field_not_accessible  |
 * | 400            | INVALID_TYPE                         | ADAPTER_UNAUTHORIZED| false     | object_not_accessible |
 * | 400            | other                                | ADAPTER_UNAVAILABLE | false     | query_rejected        |
 * | 404            | any                                  | ADAPTER_UNAVAILABLE | false     | endpoint_not_found    |
 * | 408, 429, 5xx  | any                                  | ADAPTER_UNAVAILABLE | true      | transient             |
 * | other          | -                                    | per T1 mapMcpError  |           |                       |
 *
 * Messages are fixed strings: Salesforce `message` text (which contains the SOQL, i.e. the
 * searched account name) is never echoed. Only identifier-shaped field/object names are kept.
 */

/** Internal carrier so deep helpers can abort with a ready adapter error. */
export class SfAdapterError extends Error {
  constructor(adapterError) {
    super(adapterError.message);
    this.name = "SfAdapterError";
    this.adapterError = adapterError;
  }
}

export function adapterError(code, message, retryable, details) {
  return { code, message, retryable, ...(details ? { details } : {}) };
}

export const malformed = (reason, extra = {}) =>
  adapterError("ADAPTER_MALFORMED_RESPONSE", "Salesforce response is malformed.", false, { reason, ...extra });

const IDENT = /^[A-Za-z0-9_.]{1,80}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,80}$/;

function parseBody(body) {
  let value = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "object" || first === null) return {};
  return {
    errorCode: typeof first.errorCode === "string" ? first.errorCode : undefined,
    message: typeof first.message === "string" ? first.message : undefined,
  };
}

function fieldAndObject(message) {
  if (typeof message !== "string") return {};
  const match = /No such column '([^']+)' on (?:entity|sobject of type) '?([A-Za-z0-9_]+)'?/.exec(message);
  if (!match) return {};
  return {
    ...(IDENT.test(match[1]) ? { field: match[1] } : {}),
    ...(IDENT.test(match[2]) ? { object: match[2] } : {}),
  };
}

/**
 * Classify a raw Salesforce/connector error payload (`{error_code?, status_code, body}`).
 * Returns an AdapterError, or null when the payload carries no usable HTTP status
 * (the caller then falls back to the T1 mapping).
 * @param {unknown} payload
 */
export function classifySalesforceError(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const status = Number.isInteger(payload.status_code) ? payload.status_code : null;
  if (status === null || status < 400) return null;
  const parsed = parseBody(payload.body);
  const sfCode = parsed.errorCode ?? (typeof payload.error_code === "string" ? payload.error_code : undefined);
  const base = { status_code: status, ...(sfCode && ERROR_CODE.test(sfCode) ? { sf_error_code: sfCode } : {}) };
  const out = (code, message, retryable, reason, extra = {}) =>
    adapterError(code, message, retryable, { reason, ...base, ...extra });

  if (status === 401) {
    if (sfCode === "INVALID_AUTH_HEADER" || /INVALID_SCOPES/.test(parsed.message ?? "")) {
      return out("ADAPTER_UNAUTHORIZED", "Salesforce authorization failed transiently.", true, "transient_auth", { transient: true });
    }
    return out("ADAPTER_UNAUTHORIZED", "Salesforce rejected the credentials.", false, "unauthenticated");
  }
  if (status === 403) {
    if (sfCode === "REQUEST_LIMIT_EXCEEDED") return out("ADAPTER_UNAVAILABLE", "Salesforce request limit exceeded.", true, "rate_limited");
    return out("ADAPTER_UNAUTHORIZED", "Salesforce denied access.", false, "forbidden");
  }
  if (status === 400) {
    if (sfCode === "INVALID_FIELD") {
      return out("ADAPTER_UNAUTHORIZED", "A requested Salesforce field is not accessible.", false, "field_not_accessible", fieldAndObject(parsed.message));
    }
    if (sfCode === "INVALID_TYPE") return out("ADAPTER_UNAUTHORIZED", "A requested Salesforce object is not accessible.", false, "object_not_accessible");
    return out("ADAPTER_UNAVAILABLE", "Salesforce rejected the query.", false, "query_rejected");
  }
  if (status === 404) return out("ADAPTER_UNAVAILABLE", "Salesforce endpoint not found.", false, "endpoint_not_found");
  if (status === 408 || status === 429 || status >= 500) return out("ADAPTER_UNAVAILABLE", "Salesforce temporarily unavailable.", true, "transient");
  return null;
}

/**
 * Convert a thrown value from `client.callTool` into an AdapterError: recorded connector
 * errors (`TOOL_ERROR` with `payload`) are classified Salesforce-specifically; everything
 * else (replay misses, tool not found, transport) goes through T1 `mapMcpError`.
 */
export function toAdapterError(thrown) {
  if (thrown instanceof SfAdapterError) return thrown.adapterError;
  if (thrown?.code === "TOOL_ERROR" && thrown.payload !== undefined) {
    const classified = classifySalesforceError(thrown.payload);
    if (classified) return classified;
  }
  return mapMcpError(thrown);
}

/** Locate the raw error-bearing object inside a resolved tool result. */
export function rawPayloadOf(result) {
  if (typeof result !== "object" || result === null) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content) && result.content.length === 1 && typeof result.content[0]?.text === "string") {
    try { return JSON.parse(result.content[0].text); } catch { return result; }
  }
  return result;
}
