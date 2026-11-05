import { unwrapToolResult } from "../mcp/index.js";
import { MAX_PAGES_PER_QUERY, SF_TOOL } from "./constants.js";
import { classifySalesforceError, malformed, rawPayloadOf, toAdapterError } from "./errors.js";
import { nextPageArgs, queryArgs } from "./capture-plan.js";

const NEXT_URL = /^\/services\/data\/v\d+\.\d+\/query\/[A-Za-z0-9-]+$/;

/** One call; returns {ok:true, body} or {ok:false, error}. Never throws. */
async function callPage(client, args) {
  let result;
  try {
    result = await client.callTool(SF_TOOL, args);
  } catch (thrown) {
    return { ok: false, error: toAdapterError(thrown) };
  }
  const unwrapped = unwrapToolResult(result);
  if (!unwrapped.ok) {
    return { ok: false, error: classifySalesforceError(rawPayloadOf(result)) ?? unwrapped.error };
  }
  let body = unwrapped.payload;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return { ok: false, error: malformed("malformed_body") }; }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) ||
      !Array.isArray(body.records) || typeof body.done !== "boolean") {
    return { ok: false, error: malformed("malformed_body") };
  }
  return { ok: true, body };
}

/**
 * Run one logical SOQL query including pagination.
 * @returns {Promise<{ok: true, records: object[], truncated: boolean} | {ok: false, error: object}>}
 */
export async function runQuery(client, soql, { apiVersion, expectObject, idPrefix, maxRecords }) {
  let args = queryArgs(apiVersion, soql);
  const records = [];
  for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
    const response = await callPage(client, args);
    if (!response.ok) return response;
    const { body } = response;
    for (const row of body.records) {
      const type = row?.attributes?.type;
      const id = row?.Id;
      if (type !== expectObject || typeof id !== "string" || !new RegExp(`^${idPrefix}[A-Za-z0-9]{15}$`).test(id)) {
        return { ok: false, error: malformed("unexpected_record", { object: expectObject }) };
      }
      records.push(row);
    }
    if (records.length >= maxRecords) {
      return { ok: true, records: records.slice(0, maxRecords), truncated: records.length > maxRecords || body.done === false };
    }
    if (body.done) return { ok: true, records, truncated: false };
    if (typeof body.nextRecordsUrl !== "string" || !NEXT_URL.test(body.nextRecordsUrl)) {
      return { ok: false, error: malformed("invalid_next_records_url") };
    }
    args = nextPageArgs(body.nextRecordsUrl);
  }
  return { ok: true, records, truncated: true };
}
