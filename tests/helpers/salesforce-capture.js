import { ReplayMcpClient } from "../../adapters/mcp/index.js";
import { nextPageArgs, queryArgs } from "../../adapters/salesforce/capture-plan.js";

/** Synthetic 18-character Salesforce ID, e.g. sid("001", 1) -> 001SYN0000000001AA. */
export const sid = (prefix, n) => `${prefix}SYN${String(n).padStart(10, "0")}AA`;

const QUERY_URL = "/services/data/v66.0/query";

/** Successful connector envelope for a query. Rows get `attributes.type` added. */
export function sfOk(object, rows, { done = true, nextRecordsUrl, totalSize } = {}) {
  return {
    status_code: 200,
    body: {
      totalSize: totalSize ?? rows.length,
      done,
      ...(nextRecordsUrl ? { nextRecordsUrl } : {}),
      records: rows.map((row) => ({ attributes: { type: object, url: `/services/data/v66.0/sobjects/${object}/${row.Id}` }, ...row })),
    },
    url: QUERY_URL,
  };
}

/** Connector error payload; the Salesforce error body is a JSON string. */
export function sfError(status, errorCode, message = "synthetic") {
  return { error_code: "API_ERROR", status_code: status, body: JSON.stringify([{ message, errorCode }]) };
}

/** Wrap a payload the way MCP text content does. */
export const textEnvelope = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

/** Capture entry for a first-page query call. `outcome` = {result} | {error}. */
export const queryEntry = (soql, outcome, apiVersion = "v66.0") => ({
  tool: "dispatch_readonly",
  args: queryArgs(apiVersion, soql),
  ...outcome,
  captured_at: "2026-11-04T10:00:00Z",
});

/** Capture entry for a pagination call. */
export const pageEntry = (url, outcome) => ({
  tool: "dispatch_readonly",
  args: nextPageArgs(url),
  ...outcome,
  captured_at: "2026-11-04T10:00:01Z",
});

export const replay = (entries, options) => new ReplayMcpClient({ entries, ...options });
