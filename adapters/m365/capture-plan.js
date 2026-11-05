import { M365_TOOL, MAX_PAGES_PER_SEARCH, PAGE_LIMIT, SEARCH_QUERY } from "./constants.js";
import { findAccountMapping } from "./mapping.js";

/**
 * Pure canonical-args builders. The adapter calls the connector with exactly these args and the
 * host must record captures for exactly these args (never added filters, never another query).
 */

/** Exact `sharepoint_search` args: no other keys (no fileType/author/date filters). */
export function searchArgs(folderName, offset = 0) {
  return { query: SEARCH_QUERY, folderName, limit: PAGE_LIMIT, offset };
}

/** Distinct search folder names of a mapped account, in order of first appearance. */
export function searchFolderNames(accountMapping) {
  const names = [];
  for (const location of accountMapping.locations) {
    if (!names.includes(location.folder_name)) names.push(location.folder_name);
  }
  return names;
}

export const PAGINATION_RULE =
  "After a page whose trailer has moreResults:true, also call the same search with offset = trailer.nextOffset exactly; "
  + `stop when the trailer has no moreResults, the result is empty, or ${MAX_PAGES_PER_SEARCH} pages of the search were read.`;

/**
 * Capture plan for one account: one search per distinct folder name (page 1, offset 0).
 * Unmapped accounts have no calls.
 * @param {string} accountId
 * @param {object} mapping result of loadM365AccountMapping / validateM365AccountMapping
 */
export function sharepointSearchPlan(accountId, mapping) {
  const entry = findAccountMapping(mapping, accountId);
  return {
    phase: "m365_search",
    tool: M365_TOOL,
    account_id: accountId,
    mapped: entry !== null,
    calls: entry === null
      ? []
      : searchFolderNames(entry).map((folderName, index) => ({ step: `search_${index + 1}`, args: searchArgs(folderName, 0) })),
    max_pages_per_search: MAX_PAGES_PER_SEARCH,
    pagination: PAGINATION_RULE,
  };
}
