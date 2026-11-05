import { PROVIDER } from "./constants.js";
import { fieldClaim, fieldLine } from "./format.js";

const fail = (message) => ({ ok: false, error: { code: "EXTRACTOR_MALFORMED_RESPONSE", message, retryable: false } });
const nonEmpty = (value) => typeof value === "string" && value !== "";

/**
 * Deterministic claim extractor for SharePoint document records: structured metadata only
 * (Location, File type, Last modified). It reads only `metadata` and the shared formatters, never
 * `content` or the search snippet, so a snippet can never become a claim.
 */
export function createM365StructuredClaimExtractor() {
  return {
    name: "m365-structured-claim-extractor",
    extract(record) {
      const metadata = record?.metadata;
      if (typeof metadata !== "object" || metadata === null || metadata.provider !== PROVIDER) {
        return { ok: true, candidates: [] };
      }
      const { m365_file_name: name, m365_location: location, m365_last_modified: lastModified, m365_file_type: fileType } = metadata;
      if (!nonEmpty(name) || !nonEmpty(location) || !nonEmpty(lastModified)) return fail("SharePoint record metadata is incomplete.");
      if (fileType !== undefined && !nonEmpty(fileType)) return fail("SharePoint record metadata is incomplete.");
      if (metadata.m365_claim_excluded === true) return { ok: true, candidates: [] };
      const facts = [
        ["Location", location],
        ...(fileType !== undefined ? [["File type", fileType]] : []),
        ["Last modified", lastModified],
      ];
      return {
        ok: true,
        candidates: facts.map(([label, value]) => ({
          claim: fieldClaim(name, label, value),
          excerpt: fieldLine(name, label, value),
          completeness: "complete",
        })),
      };
    },
  };
}
