/** Frozen constants shared by the M365 SharePoint adapter and the capture-plan builders. */

/** The only MCP tool the M365 adapter ever calls (read-only). */
export const M365_TOOL = "sharepoint_search";
export const SEARCH_QUERY = "*";
export const PAGE_LIMIT = 50;
export const MAX_PAGES_PER_SEARCH = 4;
export const MAX_OFFSET = 1000;
export const MAX_LOCATIONS_PER_ACCOUNT = 10;
export const DEFAULT_M365_LIMITS = Object.freeze({ maxRecords: 50, maxClaimRecords: 10 });
export const SNIPPET_MAX = 300;
export const NAME_MAX = 300;
export const LOCATION_MAX = 1000;
export const PREFIX_MAX = 1000;
export const FOLDER_NAME_MAX = 200;
export const PROVIDER = "m365_sharepoint";

/** Volatile or path-bearing error fields redacted when an M365 capture is loaded. */
export const M365_REDACT = Object.freeze(["details.graphRequestId", "details.uriPath"]);

/** Repository-relative default location of the user-maintained mapping (git-ignored). */
export const DEFAULT_MAPPING_PATH = "local/m365-account-mapping.yaml";

/** Classifications the M365 adapter may produce (never public). */
export const M365_CLASSIFICATIONS = Object.freeze(["internal", "confidential"]);

/** Fixed diagnostic texts (stderr only, counts only; never names, paths, URLs or snippets). */
export const M365_DIAGNOSTIC_TEXT = Object.freeze({
  M365_NOT_MAPPED: "the account has no SharePoint mapping; no M365 call was made and internal_document returned no records.",
  M365_PERSONAL_EXCLUDED: "hit(s) in personal OneDrive were excluded (user decision 2026-11-05).",
  M365_OUTSIDE_MAPPING_EXCLUDED: "hit(s) outside the mapped locations were excluded.",
  M365_UNSUPPORTED_ITEMS_SKIPPED: "item(s) that are not SharePoint files were skipped.",
  M365_COPIES_MERGED: "duplicate copy(ies) of the same document were merged.",
  M365_SEARCH_TRUNCATED: "search(es) reached the page cap and are truncated.",
  M365_RECORDS_TRUNCATED: "record(s) were found; the per-account record limit applied.",
});
