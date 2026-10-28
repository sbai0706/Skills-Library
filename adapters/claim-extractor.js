/**
 * Claim extractor interface.
 *
 * A claim extractor PROPOSES candidate factual claims from one raw source
 * record. It is the only place where unrestricted prose may be interpreted,
 * because that genuinely requires reading comprehension. In this repository the
 * only implementation is a deterministic fixture extractor that reads explicit
 * candidate claims from record metadata; it does not parse prose.
 *
 * The extractor proposes; evidence.normalize decides. The skill owns:
 *   - record and candidate validation,
 *   - direct support checking against the record content,
 *   - provenance, classification, and confidence policy,
 *   - deduplication, conflict detection, rejection, and output construction.
 *
 * A future model-backed extractor must be replaceable here without changing
 * the evidence.normalize input or output contract.
 *
 * @typedef {Object} ClaimCandidate
 * @property {string} claim                          Proposed claim text. Required.
 * @property {string} excerpt                        Verbatim segment of the record content
 *                                                   that supposedly supports the claim. Required.
 * @property {"complete"|"partial"} [completeness]   Completeness hint. "complete" -> the claim
 *                                                   states the whole supported fact (confidence high);
 *                                                   "partial" or omitted -> conservative (confidence medium).
 * @property {string} [conflict_key]                 Optional. Candidates from different records
 *                                                   sharing a conflict key assert the same subject;
 *                                                   differing claim texts are reported as a conflict.
 * @property {"public"|"internal"|"confidential"} [access_classification]
 *                                                   Optional. May only be equal to or more restrictive
 *                                                   than the record's classification. A downgrade is rejected.
 *
 * @typedef {Object} ExtractorError
 * @property {"EXTRACTOR_UNAVAILABLE"|"EXTRACTOR_MALFORMED_RESPONSE"} code
 * @property {string} message
 * @property {boolean} retryable
 *
 * @typedef {Object} ExtractionResult
 * @property {true} ok
 * @property {ClaimCandidate[]} candidates   May be empty: a record with no claims is normal.
 *   OR
 * @property {false} ok
 * @property {ExtractorError} error
 *
 * @typedef {Object} ClaimExtractor
 * @property {string} name
 * @property {(record: object) => Promise<ExtractionResult> | ExtractionResult} extract
 */

/** Error codes an extractor may return. Anything else is a malformed response. */
export const EXTRACTOR_ERROR_CODES = Object.freeze([
  "EXTRACTOR_UNAVAILABLE",
  "EXTRACTOR_MALFORMED_RESPONSE",
]);

/** Completeness values the skill understands. */
export const COMPLETENESS_VALUES = Object.freeze(["complete", "partial"]);

/**
 * Validate one candidate's shape. Returns a list of problems; the skill treats
 * any problem as a malformed extractor response for the whole record, because
 * the candidate contract is explicit and violating it is an extractor defect.
 * @param {unknown} candidate
 * @returns {string[]}
 */
export function candidateProblems(candidate) {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return ["candidate is not an object"];
  }
  const problems = [];
  if (typeof candidate.claim !== "string" || candidate.claim.trim() === "") {
    problems.push("candidate.claim must be a non-empty string");
  }
  if (typeof candidate.excerpt !== "string" || candidate.excerpt.trim() === "") {
    problems.push("candidate.excerpt must be a non-empty string");
  }
  if (candidate.completeness !== undefined && !COMPLETENESS_VALUES.includes(candidate.completeness)) {
    problems.push(`candidate.completeness must be one of: ${COMPLETENESS_VALUES.join(", ")}`);
  }
  if (candidate.conflict_key !== undefined && (typeof candidate.conflict_key !== "string" || candidate.conflict_key.trim() === "")) {
    problems.push("candidate.conflict_key must be a non-empty string when provided");
  }
  if (
    candidate.access_classification !== undefined &&
    !["public", "internal", "confidential"].includes(candidate.access_classification)
  ) {
    problems.push("candidate.access_classification must be public, internal, or confidential when provided");
  }
  return problems;
}

/**
 * Validate an extraction result envelope. Returns a structured error when the
 * envelope itself is unusable, or null when it is well formed.
 * @param {unknown} result
 * @returns {ExtractorError|null}
 */
export function resultProblems(result) {
  const malformed = (message) => ({ code: "EXTRACTOR_MALFORMED_RESPONSE", message, retryable: false });
  if (typeof result !== "object" || result === null) return malformed("extractor returned a non-object result");
  if (result.ok === false) {
    const error = result.error;
    if (!error || typeof error !== "object") return malformed("extractor failure is missing a structured error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      return malformed("extractor failure must include string code and message");
    }
    if (!EXTRACTOR_ERROR_CODES.includes(error.code)) {
      return malformed(`extractor returned unrecognized error code "${error.code}"`);
    }
    return null;
  }
  if (result.ok !== true) return malformed("extractor result lacks a boolean 'ok' field");
  if (!Array.isArray(result.candidates)) return malformed("extractor result 'candidates' is not an array");
  if (result.candidates.length > 100) return malformed("extractor returned more candidates than the contract permits");
  const problems = result.candidates.flatMap((candidate, index) =>
    candidateProblems(candidate).map((problem) => `candidates[${index}]: ${problem}`),
  );
  return problems.length === 0 ? null : malformed(problems.join("; "));
}
