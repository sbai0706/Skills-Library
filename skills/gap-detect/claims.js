import { validate } from "../../schemas/index.js";

const CLAIM_ID_PATTERN = /^clm_[A-Za-z0-9_-]+$/;

function safeClaimId(claim) {
  return typeof claim?.claim_id === "string" && CLAIM_ID_PATTERN.test(claim.claim_id)
    ? claim.claim_id
    : undefined;
}

export function evaluateClaims(rawClaims, { accountId, questionIds }) {
  const accepted = new Map();
  const rejections = [];

  rawClaims.forEach((claim, index) => {
    const reject = (reason, message, details = {}) =>
      rejections.push({ reason, message, details: { claim_index: index, ...details } });

    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
      reject("malformed_claim", "A claim entry was not an object and was not used.");
      return;
    }

    const claimId = safeClaimId(claim);

    if (claim.account_id !== accountId) {
      reject("foreign_account", "A claim belongs to a different account and was not used.", {
        ...(claimId ? { claim_id: claimId } : {}),
      });
      return;
    }

    const { valid, errors } = validate("evidence", claim);
    if (!valid) {
      reject("malformed_claim", "A claim failed evidence schema validation and was not used.", {
        ...(claimId ? { claim_id: claimId } : {}),
        problems: errors.map((error) => `${error.path} ${error.message}`),
      });
      return;
    }

    if (accepted.has(claim.claim_id)) {
      reject("duplicate_claim_id", "A duplicate evidence ID was not used.", {
        claim_id: claim.claim_id,
      });
      return;
    }

    const unknownQuestionIds = (claim.question_ids ?? []).filter(
      (questionId) => !questionIds.has(questionId),
    );
    if (unknownQuestionIds.length > 0) {
      reject(
        "unknown_question_reference",
        "A claim referenced question IDs outside the question set and was not used.",
        { claim_id: claim.claim_id, unknown_question_ids: unknownQuestionIds },
      );
      return;
    }

    accepted.set(claim.claim_id, claim);
  });

  return { accepted, rejections };
}
