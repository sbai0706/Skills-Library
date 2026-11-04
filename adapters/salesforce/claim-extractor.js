import { fieldClaim, fieldLine, headerLine } from "./format.js";

const MAX_CANDIDATES = 100;

/**
 * Fields kept in record content as raw CRM facts but never turned into claims (so they never
 * reach the brief under any question), pending approved B-FITT policy (user decision 2026-11-04).
 * Explicit list on purpose: no name-pattern filtering.
 */
export const CLAIM_EXCLUDED_FIELDS = Object.freeze([
  "Qualification_Score__c",
  "Budget_Status__c",
  "Primary_Buyer_Authority__c",
  "Awareness_of_Pain__c",
  "What_s_the_Trigger_and_why_now__c",
  "Cost_of_Inaction__c",
  "Buying_Path__c",
]);

const fail = (code, message) => ({ ok: false, error: { code, message, retryable: false } });
const malformed = (message) => fail("EXTRACTOR_MALFORMED_RESPONSE", message);

/**
 * Deterministic claim extractor for Salesforce source records: structured fields only, no
 * prose parsing, no model. Reads only `metadata` and the shared formatters, so every excerpt
 * occurs verbatim in the record content that the same formatters produced.
 */
export function createSalesforceStructuredClaimExtractor() {
  return {
    name: "salesforce-structured-claim-extractor",
    extract(record) {
      const metadata = record?.metadata;
      if (typeof metadata !== "object" || metadata === null || metadata.provider !== "salesforce") {
        return { ok: true, candidates: [] };
      }
      const objectName = metadata.object_name;
      const recordName = metadata.sf_record_name;
      if (typeof objectName !== "string" || typeof recordName !== "string" || typeof metadata.sf_fields_json !== "string") {
        return malformed("Salesforce record metadata is incomplete.");
      }
      let facts;
      try { facts = JSON.parse(metadata.sf_fields_json); } catch { return malformed("sf_fields_json is not valid JSON."); }
      if (!Array.isArray(facts) || !facts.every((fact) =>
        typeof fact === "object" && fact !== null &&
        ["api", "label", "value"].every((key) => typeof fact[key] === "string" && fact[key] !== ""))) {
        return malformed("sf_fields_json must be an array of {api, label, value} strings.");
      }
      const candidates = [];
      if (objectName !== "Account") {
        const header = headerLine(objectName, recordName);
        candidates.push({ claim: header, excerpt: header, completeness: "complete" });
      }
      for (const fact of facts) {
        if (CLAIM_EXCLUDED_FIELDS.includes(fact.api)) continue;
        candidates.push({
          claim: fieldClaim(objectName, recordName, fact),
          excerpt: fieldLine(objectName, recordName, fact),
          completeness: "complete",
        });
      }
      return { ok: true, candidates };
    },
  };
}

/**
 * Extension point: run several extractors in order and concatenate their candidates. Returns the
 * first `ok: false`; a thrown error becomes EXTRACTOR_UNAVAILABLE; more than 100 candidates in
 * total is EXTRACTOR_MALFORMED_RESPONSE. v1 wires `[structured]`; a later host-candidate extractor
 * is appended to the list without any contract change.
 * @param {Array<{name?: string, extract: Function}>} extractors
 */
export function createCompositeClaimExtractor(extractors) {
  if (!Array.isArray(extractors) || extractors.length === 0 || !extractors.every((e) => typeof e?.extract === "function")) {
    throw new TypeError("createCompositeClaimExtractor requires a non-empty array of extractors");
  }
  return {
    name: `composite-claim-extractor(${extractors.map((e) => e.name ?? "unnamed").join("+")})`,
    async extract(record) {
      const candidates = [];
      for (const extractor of extractors) {
        let result;
        try { result = await extractor.extract(record); } catch {
          return fail("EXTRACTOR_UNAVAILABLE", "A claim extractor failed.");
        }
        if (result?.ok !== true) return result?.ok === false ? result : malformed("A claim extractor returned an invalid result.");
        candidates.push(...result.candidates);
        if (candidates.length > MAX_CANDIDATES) return malformed("Too many claim candidates.");
      }
      return { ok: true, candidates };
    },
  };
}
