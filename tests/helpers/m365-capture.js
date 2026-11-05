import { ReplayMcpClient, loadCapture } from "../../adapters/mcp/index.js";
import { M365_REDACT, M365_TOOL, searchArgs } from "../../adapters/m365/index.js";

/** Synthetic builders for M365 SharePoint captures. Entirely fictional: tenant `contoso`, `SYN` ids. */

export const SALES_PREFIX = "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders";
export const DELIVERY_PREFIX = "https://contoso.sharepoint.com/sites/ExampleDelivery/Shared Documents/Clients/Northwind";

/** One search hit as the tool returns it (an object; `m365Page` serializes it into a text block). */
export function m365Hit({
  n = 1,
  driveId = "b!SYNdrive0001",
  id = `01SYNITEM${String(n).padStart(4, "0")}`,
  name = `Example Document ${n}.docx`,
  folder = SALES_PREFIX,
  webUrl,
  content = `<c0>Example</c0> outline ${n}<ddd/>`,
  summary = content,
  lastModified = "2026-09-03T15:28:28.000Z",
  ...overrides
} = {}) {
  return {
    uri: `file:///${driveId}/${id}`,
    driveId,
    id,
    name,
    content,
    summary,
    isPartialContent: true,
    webUrl: webUrl ?? `${folder}/${name}`,
    downloadUrl: null,
    size: null,
    lastModifiedDateTime: lastModified,
    offset: 0,
    ...overrides,
  };
}

/**
 * Raw `sharepoint_search` result: one text block per hit plus a trailer block.
 * `trailer`: undefined -> `{totalResultCount: n}`; null -> no trailer block; object -> used as is.
 * No hits and no trailer -> `{content: []}` (the observed shape for zero hits).
 */
export function m365Page(hits, trailer) {
  const blocks = hits.map((hit) => ({ type: "text", text: JSON.stringify(hit) }));
  const tail = trailer === null ? null : trailer ?? (hits.length === 0 ? null : { totalResultCount: hits.length });
  if (tail !== null) blocks.push({ type: "text", text: JSON.stringify(tail) });
  return { content: blocks };
}

/** Trailer for a page that has more results. */
export const moreTrailer = (nextOffset, total = 200) => ({ moreResults: true, nextOffset, totalResultCount: total, note: "synthetic" });

/** Recorded connector error payload (contains volatile / path-bearing fields on purpose). */
export function m365Error(status, { retryAfter, graphErrorCode = "synthetic_error" } = {}) {
  return {
    code: "INTERNAL_ERROR",
    message: "Synthetic Graph failure for /sites/ExampleSales/secret-file.docx",
    details: {
      graphErrorCode,
      graphStatusCode: status,
      graphRequestId: "req-synthetic-0001",
      ...(retryAfter !== undefined ? { graphRetryAfterSeconds: retryAfter } : {}),
      driveId: "b!SYNdrive0001",
      itemId: "01SYNITEM9999",
      uriPath: "/sites/ExampleSales/Shared Documents/Northwind Traders/secret-file.docx",
    },
  };
}

/** Capture entry for one search call; `outcome` = {result} | {error}. */
export const m365Entry = (folderName, offset, outcome, capturedAt = "2026-11-05T10:00:01Z") => ({
  tool: M365_TOOL,
  args: searchArgs(folderName, offset),
  ...outcome,
  captured_at: capturedAt,
});

export const m365CaptureDoc = (entries, note = "Entirely fictional M365 fixture.", createdAt = "2026-11-05T10:00:00Z") => ({
  format_version: "mcp-capture/1",
  capture: { created_at: createdAt, source_system: "m365", connector: "synthetic-m365-connector", note },
  entries,
});

/** Strict replay client over entries (no redaction). */
export const m365Replay = (entries, options) => new ReplayMcpClient({ entries, ...options });

/** Strict replay client loaded through `loadCapture` with the M365 redaction patterns. */
export const m365Loaded = (entries) => loadCapture(m365CaptureDoc(entries), { redact: [...M365_REDACT] });

/** Mapping document with one account (header fields as in the committed example). */
export function mappingDoc(accounts, overrides = {}) {
  return {
    version: "0.1.0",
    status: "provisional",
    business_owner: "TBD",
    approver: "TBD",
    approval_date: null,
    source_documents: [],
    effective_date: null,
    change_history: [{ version: "0.1.0", date: "2026-11-05", change: "synthetic" }],
    mapping_kind: "m365_sharepoint_account_locations",
    accounts,
    ...overrides,
  };
}

export const NORTHWIND_SF_ID = "sf_001SYN0000000001AA";
export const oneAccount = (locations, accountId = NORTHWIND_SF_ID) => mappingDoc([{ account_id: accountId, locations }]);
