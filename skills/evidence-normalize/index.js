import { randomUUID } from "node:crypto";
import { resultProblems as extractorResultProblems } from "../../adapters/claim-extractor.js";
import { validate } from "../../schemas/index.js";
import { candidateRejection, buildClaim, reasonForProblems, recordProblems } from "./records.js";
import { compareClaims, compareRejections, detectConflicts, deriveClaimId, duplicateKey } from "./claims.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "evidence.normalize";
export const SKILL_VERSION = "0.1.0";

/** Rejection reason codes, mirrored in SKILL.md and skill.yaml. */
export const REJECTION_REASONS = Object.freeze([
  "malformed_source_record",
  "foreign_account",
  "unsupported_claim",
  "excerpt_not_found",
  "classification_violation",
  "duplicate_claim",
  "extractor_failure",
]);

const trace = () => "trace_" + randomUUID();

function envelope({ status, data, startedAt, errors = [], warnings = [], evidenceIds = [] }) {
  const result = {
    skill: SKILL_NAME,
    skill_version: SKILL_VERSION,
    status,
    data,
    evidence_ids: evidenceIds,
    warnings,
    errors,
    trace_id: trace(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  const { valid, errors: schemaErrors } = validate("skillResult", result);
  if (!valid) {
    throw new Error("evidence.normalize produced an invalid envelope: " + JSON.stringify(schemaErrors));
  }
  return result;
}

/**
 * Sanitize free text out of rejection explanations so confidential content
 * cannot leak through the diagnostics channel.
 */
function safeExplanation(reason, context) {
  const explanations = {
    malformed_source_record: "The source record failed validation and was not processed.",
    foreign_account: "The source record belongs to a different account and was not processed.",
    unsupported_claim: "The candidate claim introduces information that is not present in its excerpt.",
    excerpt_not_found: "The candidate excerpt does not appear verbatim in the source record content.",
    classification_violation: "The candidate attempted to lower the source record's access classification.",
    duplicate_claim: "An equivalent claim from the same source record was already accepted.",
    extractor_failure: "The claim extractor failed for this record; no claims were taken from it.",
  };
  const suffix = context === "record" ? " (entire record)" : " (one candidate claim)";
  return explanations[reason] + suffix;
}

/**
 * Normalize retrieved raw source records into claim-level evidence records.
 *
 * The extractor proposes candidates; this skill owns validation, direct
 * support checking, provenance, classification policy, deduplication,
 * conflict detection, rejection, and output construction. It never retrieves,
 * never answers questions, and never resolves contradictions.
 *
 * @param {{account_id: string, records: object[]}} input
 * @param {{extractor?: object, now?: () => Date}} deps
 * @returns {Promise<object>} skill result envelope
 */
export async function normalizeEvidence(input, deps) {
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const inputResult = validateInput(input);

  if (!inputResult.ok) {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: inputResult.errors,
    });
  }

  const { account_id: accountId, records } = inputResult.value;
  const extractor = deps.extractor;
  if (!extractor || typeof extractor.extract !== "function") {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: [{
        code: "EXTRACTOR_MALFORMED_RESPONSE",
        message: "Claim extractor does not implement extract().",
        retryable: false,
      }],
    });
  }

  const claims = [];
  const rejectedRecords = [];
  const conflicts = [];
  const errors = [];
  const warnings = [];
  const seenClaimIds = new Set();
  const allAccepted = [];
  const pendingClaims = [];

  for (const record of records) {
    const problems = recordProblems(record, accountId);
    if (problems.length > 0) {
      const reason = reasonForProblems(problems);
      rejectedRecords.push({
        source_record_id: typeof record?.record_id === "string" ? record.record_id : null,
        reason,
        explanation: safeExplanation(reason, "record"),
        scope: "record",
      });
      continue;
    }

    let extraction;
    try {
      extraction = await extractor.extract(record);
    } catch (error) {
      const reason = "extractor_failure";
      rejectedRecords.push({
        source_record_id: record.record_id,
        reason,
        explanation: safeExplanation(reason, "record"),
        scope: "record",
      });
      errors.push({
        code: "EXTRACTOR_UNAVAILABLE",
        message: "Claim extractor threw for one record: " + (error instanceof Error ? error.message : "unknown error"),
        retryable: false,
        details: { source_record_id: record.record_id, thrown: true },
      });
      continue;
    }

    const envelopeProblem = extractorResultProblems(extraction);
    if (envelopeProblem || extraction.ok === false) {
      const reason = "extractor_failure";
      rejectedRecords.push({
        source_record_id: record.record_id,
        reason,
        explanation: safeExplanation(reason, "record"),
        scope: "record",
      });
      const code = envelopeProblem ? envelopeProblem.code : extraction.error.code;
      const message = envelopeProblem ? envelopeProblem.message : extraction.error.message;
      errors.push({
        code,
        message,
        retryable: false,
        details: { source_record_id: record.record_id },
      });
      continue;
    }

    let duplicatesThisRecord = 0;
    for (const [index, candidate] of extraction.candidates.entries()) {
      const { reason, unsupported } = candidateRejection(candidate, record);
      if (reason !== null) {
        rejectedRecords.push({
          source_record_id: record.record_id,
          reason,
          explanation: safeExplanation(reason, "candidate"),
          scope: "candidate",
          candidate_index: index,
        });
        continue;
      }

      const claimId = deriveClaimId(accountId, record.record_id, candidate.claim);
      if (seenClaimIds.has(claimId)) {
        duplicatesThisRecord += 1;
        rejectedRecords.push({
          source_record_id: record.record_id,
          reason: "duplicate_claim",
          explanation: safeExplanation("duplicate_claim", "candidate"),
          scope: "candidate",
          candidate_index: index,
        });
        continue;
      }

      const claim = { ...buildClaim(candidate, record), claim_id: claimId };
      const conflictKey = candidate.conflict_key ?? null;
      seenClaimIds.add(claimId);
      pendingClaims.push({ claim, conflictKey });
    }

    if (duplicatesThisRecord > 0) {
      warnings.push({
        code: "DUPLICATE_CLAIMS_REMOVED",
        message: duplicatesThisRecord + " duplicate candidate(s) were removed from record " + record.record_id + ".",
      });
    }
  }

  // Deduplicate equivalent claims across records: identical normalized claim
  // text is NOT a duplicate across records — independent provenance must be
  // kept. The seenClaimIds key already includes the record ID, so claims from
  // different records never collide; identical claims from different records
  // are kept as separate claims.
  for (const { claim, conflictKey } of pendingClaims) {
    const claimWithKey = { ...claim, conflict_key: conflictKey };
    allAccepted.push(claimWithKey);
  }

  const detected = detectConflicts(allAccepted);
  conflicts.push(...detected);

  // Strip the internal conflict_key and sort deterministically.
  const finalClaims = allAccepted
    .map(({ conflict_key, ...claim }) => claim)
    .sort(compareClaims);

  for (const claim of finalClaims) {
    const { valid, errors: schemaErrors } = validate("evidence", claim);
    if (!valid) {
      throw new Error(
        "evidence.normalize produced an invalid claim: " + JSON.stringify(schemaErrors),
      );
    }
  }

  const claimIds = finalClaims.map((claim) => claim.claim_id);
  const rejectedCount = rejectedRecords.length;
  const status = rejectedCount > 0 ? (claimIds.length > 0 ? "partial" : "partial") : "success";

  if (rejectedCount > 0) {
    warnings.push({
      code: "RECORDS_OR_CANDIDATES_REJECTED",
      message: rejectedCount + " record(s)/candidate(s) were rejected; see rejected_records for reasons.",
    });
  }

  return envelope({
    status,
    data: {
      account_id: accountId,
      claims: finalClaims,
      rejected_records: rejectedRecords.sort(compareRejections),
      conflicts,
      source_record_count: records.length,
      claim_count: finalClaims.length,
    },
    startedAt,
    errors,
    warnings,
    evidenceIds: claimIds,
  });
}

export default normalizeEvidence;