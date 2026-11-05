export { createM365SharePointEvidenceAdapter } from "./evidence-adapter.js";
export { createM365StructuredClaimExtractor } from "./claim-extractor.js";
export {
  M365MappingError, findAccountMapping, isPersonalUrl, isValidAccountId, loadM365AccountMapping, matchPrefix, normalizePrefix,
  validateM365AccountMapping,
} from "./mapping.js";
export { searchArgs, searchFolderNames, sharepointSearchPlan } from "./capture-plan.js";
export { parseSearchResult } from "./search-result.js";
export { classifyM365Error, toM365AdapterError } from "./errors.js";
export { mapHit, recordIdOf } from "./record-mapper.js";
export { parseWebUrl } from "./format.js";
export {
  DEFAULT_MAPPING_PATH, M365_DIAGNOSTIC_TEXT, M365_REDACT, M365_TOOL, MAX_OFFSET, MAX_PAGES_PER_SEARCH, PAGE_LIMIT, PROVIDER,
  SEARCH_QUERY,
} from "./constants.js";
