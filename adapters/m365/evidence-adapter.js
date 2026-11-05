import { assertMcpToolClient } from "../mcp/index.js";
import {
  DEFAULT_M365_LIMITS, M365_CLASSIFICATIONS, M365_TOOL, MAX_OFFSET, MAX_PAGES_PER_SEARCH,
} from "./constants.js";
import { searchArgs, searchFolderNames } from "./capture-plan.js";
import { internalM365Error, toM365AdapterError } from "./errors.js";
import { cleanText } from "./format.js";
import { findAccountMapping, isPersonalUrl, matchPrefix } from "./mapping.js";
import { mapHit } from "./record-mapper.js";
import { parseSearchResult } from "./search-result.js";

const RANK = Object.freeze({ public: 0, internal: 1, confidential: 2 });
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const adapterError = (code, message, retryable, details) => ({ code, message, retryable, ...(details ? { details } : {}) });
const malformed = (reason) => adapterError("ADAPTER_MALFORMED_RESPONSE", "Microsoft 365 search result is malformed.", false, { reason });

/** Internal carrier so deep helpers can abort with a ready adapter error. */
class M365AdapterAbort extends Error {
  constructor(error) {
    super(error.message);
    this.error = error;
  }
}
const abort = (error) => new M365AdapterAbort(error);

const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const maxClassification = (levels) => levels.reduce((best, level) => (RANK[level] > RANK[best] ? level : best));

function resolveLimits(limits) {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) throw new TypeError("limits must be an object");
  const effective = { ...DEFAULT_M365_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_M365_LIMITS)) throw new TypeError(`limits: unknown limit ${key}`);
    const min = key === "maxRecords" ? 1 : 0;
    if (!Number.isInteger(value) || value < min || value > DEFAULT_M365_LIMITS[key]) {
      throw new TypeError(`limits.${key} must be an integer between ${min} and ${DEFAULT_M365_LIMITS[key]}`);
    }
    effective[key] = value;
  }
  return effective;
}

/**
 * `YYYY-MM-DDTHH:MM:SS[.fff...]Z` that is a real calendar instant: the round trip through Date must
 * give the same text (milliseconds normalized), so `2026-02-31T...` or hour 25 never rolls over.
 */
function isValidTimestamp(stamp) {
  if (typeof stamp !== "string" || !TIMESTAMP.test(stamp)) return false;
  const time = new Date(stamp);
  if (Number.isNaN(time.getTime())) return false;
  const normalized = stamp.replace(/(\.(\d+))?Z$/, (_m, _f, digits) => `.${`${digits ?? ""}000`.slice(0, 3)}Z`);
  return time.toISOString() === normalized;
}

/** Strict check of a kept hit; throws an abort with ADAPTER_MALFORMED_RESPONSE. */
function assertStrictHit(hit) {
  if (!nonEmptyString(hit.driveId) || !nonEmptyString(hit.id) || !nonEmptyString(hit.name) || cleanText(hit.name) === "") {
    throw abort(malformed("hit_incomplete"));
  }
  if (hit.uri !== `file:///${hit.driveId}/${hit.id}`) throw abort(malformed("uri_mismatch"));
  if (!isValidTimestamp(hit.lastModifiedDateTime)) throw abort(malformed("invalid_last_modified"));
  for (const key of ["content", "summary"]) {
    // A missing key is the same as null; any other non-string is malformed.
    if (hit[key] !== undefined && hit[key] !== null && typeof hit[key] !== "string") throw abort(malformed("invalid_snippet_field"));
  }
  try { new URL(hit.webUrl); } catch { throw abort(malformed("invalid_web_url")); }
}

/**
 * One search including pagination. Returns {hits, truncated}; throws M365AdapterAbort on failure.
 */
async function runSearch(client, folderName) {
  const hits = [];
  let offset = 0;
  for (let page = 1; page <= MAX_PAGES_PER_SEARCH; page += 1) {
    let result;
    try {
      result = await client.callTool(M365_TOOL, searchArgs(folderName, offset));
    } catch (thrown) {
      throw abort(toM365AdapterError(thrown));
    }
    const parsed = parseSearchResult(result);
    if (!parsed.ok) throw abort(parsed.error);
    hits.push(...parsed.hits);
    const trailer = parsed.trailer;
    if (parsed.hits.length === 0 || trailer?.moreResults !== true) return { hits, truncated: false };
    const next = trailer.nextOffset;
    if (!Number.isInteger(next) || next <= offset || next > MAX_OFFSET) throw abort(malformed("invalid_next_offset"));
    if (page === MAX_PAGES_PER_SEARCH) return { hits, truncated: true };
    offset = next;
  }
  return { hits, truncated: true };
}

/**
 * EvidenceAdapter for source `internal_document` over SharePoint search (Mode A replay or a
 * future live client). Scoping is the human-maintained account -> location mapping only; it calls
 * exactly one tool, `sharepoint_search`; it never reads document bodies. Never throws after
 * construction.
 * @param {object} options see docs/design/P4_M365_SHAREPOINT_ADAPTER.md section 1
 */
export function createM365SharePointEvidenceAdapter({
  client,
  mapping,
  now = () => new Date(),
  limits = {},
  classification = "internal",
  onDiagnostic = () => {},
} = {}) {
  assertMcpToolClient(client);
  if (typeof mapping !== "object" || mapping === null || !Array.isArray(mapping.accounts)) {
    throw new TypeError("mapping must be the result of loadM365AccountMapping");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof onDiagnostic !== "function") throw new TypeError("onDiagnostic must be a function");
  if (!M365_CLASSIFICATIONS.includes(classification)) {
    throw new TypeError(`classification must be one of: ${M365_CLASSIFICATIONS.join(", ")}`);
  }
  const effectiveLimits = resolveLimits(limits);
  const diagnose = (diagnostic) => { try { onDiagnostic(diagnostic); } catch { /* diagnostics never fail a retrieval */ } };

  return {
    name: "m365-sharepoint-evidence-adapter",
    supportedSources: ["internal_document"],
    async retrieve(request) {
      try {
        if (request?.source_type !== "internal_document") {
          return { ok: false, error: adapterError("UNSUPPORTED_SOURCE", "This adapter only serves the internal_document source.", false) };
        }
        if (typeof request.account_id !== "string" || request.account_id === "") {
          return { ok: false, error: adapterError("ADAPTER_UNAVAILABLE", "Account ID is missing.", false, { reason: "invalid_account_id" }) };
        }
        const entry = findAccountMapping(mapping, request.account_id);
        if (entry === null) {
          diagnose({ code: "M365_NOT_MAPPED" });
          return { ok: true, records: [] };
        }
        const retrievedAt = now().toISOString();

        let truncatedSearches = 0;
        const rawHits = [];
        for (const folderName of searchFolderNames(entry)) {
          const search = await runSearch(client, folderName);
          if (search.truncated) truncatedSearches += 1;
          rawHits.push(...search.hits);
        }

        // Filter (design section 4): each hit identity counts once per retrieve.
        const seen = new Set();
        const counts = { personal: 0, outside: 0, unsupported: 0 };
        const kept = [];
        for (const hit of rawHits) {
          if (!nonEmptyString(hit.webUrl)) throw abort(malformed("hit_without_web_url"));
          const identity = nonEmptyString(hit.driveId) && nonEmptyString(hit.id) ? `${hit.driveId}/${hit.id}` : hit.webUrl;
          if (seen.has(identity)) continue;
          seen.add(identity);
          if (isPersonalUrl(hit.webUrl)) { counts.personal += 1; continue; }
          const matched = matchPrefix(hit.webUrl, entry.locations);
          if (matched.length === 0) { counts.outside += 1; continue; }
          if (typeof hit.uri !== "string" || !hit.uri.startsWith("file:///")) { counts.unsupported += 1; continue; }
          assertStrictHit(hit);
          const level = maxClassification([classification, ...matched.map((location) => location.classification).filter(Boolean)]);
          kept.push({ hit, level });
        }

        // Map, then merge copies (same cleaned name + same timestamp).
        const mapped = kept.map(({ hit, level }) => ({
          record: mapHit(hit, { accountId: request.account_id, retrievedAt, classification: level }),
          webUrl: hit.webUrl.toLowerCase(),
          copyKey: `${cleanText(hit.name).toLowerCase()}\u0000${new Date(hit.lastModifiedDateTime).toISOString()}`,
        }));
        const groups = new Map();
        for (const item of mapped) {
          if (!groups.has(item.copyKey)) groups.set(item.copyKey, []);
          groups.get(item.copyKey).push(item);
        }
        let copiesMerged = 0;
        const survivors = [];
        for (const group of groups.values()) {
          group.sort((a, b) => (a.webUrl < b.webUrl ? -1 : a.webUrl > b.webUrl ? 1 : a.record.record_id < b.record.record_id ? -1 : a.record.record_id > b.record.record_id ? 1 : 0));
          const [survivor] = group;
          if (group.length > 1) {
            survivor.record.metadata.m365_copy_count = group.length;
            survivor.record.access_classification = maxClassification(group.map((item) => item.record.access_classification));
            copiesMerged += group.length - 1;
          }
          survivors.push(survivor.record);
        }

        // Order (newest first, then record_id) and limits.
        survivors.sort((a, b) => (a.occurred_at === b.occurred_at ? 0 : a.occurred_at > b.occurred_at ? -1 : 1)
          || (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
        const total = survivors.length;
        const records = survivors.slice(0, effectiveLimits.maxRecords);
        const recordsTruncated = total > records.length;
        for (const [index, record] of records.entries()) {
          if (recordsTruncated || truncatedSearches > 0) record.metadata.m365_truncated = true;
          if (index >= effectiveLimits.maxClaimRecords) record.metadata.m365_claim_excluded = true;
        }

        for (const [code, count] of [
          ["M365_PERSONAL_EXCLUDED", counts.personal],
          ["M365_OUTSIDE_MAPPING_EXCLUDED", counts.outside],
          ["M365_UNSUPPORTED_ITEMS_SKIPPED", counts.unsupported],
          ["M365_COPIES_MERGED", copiesMerged],
          ["M365_SEARCH_TRUNCATED", truncatedSearches],
        ]) {
          if (count > 0) diagnose({ code, count });
        }
        if (recordsTruncated) diagnose({ code: "M365_RECORDS_TRUNCATED", count: total, kept: records.length });
        return { ok: true, records };
      } catch (thrown) {
        if (thrown instanceof M365AdapterAbort) return { ok: false, error: thrown.error };
        // Anything else is an unexpected internal exception (a defect), not a transport failure.
        return { ok: false, error: internalM365Error() };
      }
    },
  };
}
