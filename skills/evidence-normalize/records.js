import { isKnownClassification } from "../evidence-retrieve/records.js";
import { validate } from "../../schemas/index.js";
import { confidenceFor, isClassificationDowngrade } from "./claims.js";
import { claimTokensSupported, excerptOccursIn } from "./text.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Validate one input record against the shared source-record schema plus the
 * normalize-specific expectations. Returns a list of problems; the skill
 * rejects the whole record when the list is non-empty and never repairs
 * material fields.
 *
 * @param {unknown} record
 * @param {string} accountId the requested account ID
 * @returns {string[]}
 */
export function recordProblems(record, accountId) {
  if (typeof record !== "object" || record === null) return ["record is not an object"];

  const problems = [];
  if (!nonEmptyString(record.record_id)) {
    problems.push("record_id missing or empty");
  } else if (!isKnownClassification(record.access_classification)) {
    problems.push("access_classification is missing or not a permitted value");
  } else if (nonEmptyString(record.account_id) && record.account_id !== accountId) {
    // Checked last so the most specific reason wins: a foreign record is
    // reported as foreign, not as malformed.
    problems.push('account_id "' + record.account_id + '" does not match the requested account');
  }

  if (nonEmptyString(record.record_id) && nonEmptyString(record.account_id)) {
    if (record.account_id === accountId) {
      const { valid, errors } = validate("sourceRecord", record);
      if (!valid) {
        for (const error of errors) problems.push("schema: " + error.path + " " + error.message);
      }
    }
  }

  return [...new Set(problems)];
}

/**
 * Classify a record-level problem into a stable rejection reason code.
 *
 * @param {string[]} problems
 * @returns {"malformed_source_record"|"foreign_account"}
 */
export function reasonForProblems(problems) {
  if (problems.some((problem) => problem.includes("does not match the requested account"))) {
    return "foreign_account";
  }
  return "malformed_source_record";
}

/**
 * Candidate checks owned by the skill. The extractor proposes; these rules
 * decide. Each violation returns the first matching reason code:
 *   - excerpt_not_found: the excerpt is not a verbatim segment of the content;
 *   - unsupported_claim: a significant claim token is absent from the excerpt;
 *   - classification_violation: the candidate tries to lower the classification.
 *
 * @param {object} candidate
 * @param {object} record
 * @returns {{reason: string|null, unsupported: string[]}}
 */
export function candidateRejection(candidate, record) {
  if (!excerptOccursIn(candidate.excerpt, record.content)) {
    return { reason: "excerpt_not_found", unsupported: [] };
  }

  const { supported, unsupported } = claimTokensSupported(candidate.claim, candidate.excerpt);
  if (!supported) {
    return { reason: "unsupported_claim", unsupported };
  }

  if (
    candidate.access_classification !== undefined &&
    isClassificationDowngrade(record.access_classification, candidate.access_classification)
  ) {
    return { reason: "classification_violation", unsupported: [] };
  }

  return { reason: null, unsupported };
}

/** Build the evidence claim emitted for an accepted candidate. */
export function buildClaim(candidate, record) {
  return {
    claim_id: null, // assigned by the skill after dedup
    claim: candidate.claim,
    source_type: record.source_type,
    source_uri: record.source_uri ?? null,
    source_record_id: record.record_id,
    account_id: record.account_id,
    ...(record.published_at !== undefined && record.published_at !== null
      ? { published_at: record.published_at }
      : {}),
    ...(record.occurred_at !== undefined && record.occurred_at !== null
      ? { occurred_at: record.occurred_at }
      : {}),
    retrieved_at: record.retrieved_at,
    excerpt: candidate.excerpt,
    confidence: confidenceFor(candidate.completeness),
    verification_status: "direct",
    access_classification: candidate.access_classification ?? record.access_classification,
    question_ids: record.question_ids ?? [],
  };
}