import { validate } from "../../schemas/index.js";

export const CLASSIFICATION_RANK = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
});

function failure(message, details) {
  return {
    ok: false,
    errors: [
      {
        code: "INVALID_INPUT",
        message,
        retryable: false,
        ...(details ? { details } : {}),
      },
    ],
  };
}

/**
 * Validate renderer input structurally, then apply the requested output
 * classification ceiling.
 *
 * The brief-input schema deliberately does not compare claim classifications
 * with the ceiling. Schema acceptance proves structure only; it does not
 * authorize rendering. This function owns the fail-closed visibility policy and
 * returns only the claims permitted at the requested ceiling.
 */
export function validateInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return failure("Input must be an object.");
  }

  const { valid, errors } = validate("firstMeetingBriefInput", input);
  if (!valid) {
    return failure(
      "Input does not validate against first-meeting-brief-input.schema.json.",
      { problems: errors },
    );
  }

  const ceilingRank = CLASSIFICATION_RANK[input.classification_ceiling];
  const omittedIds = new Set();

  for (const claim of input.claims) {
    if (CLASSIFICATION_RANK[claim.access_classification] > ceilingRank) {
      omittedIds.add(claim.claim_id);
    }
  }

  const seen = new Set();
  const permittedClaims = [];
  for (const claim of input.claims) {
    if (omittedIds.has(claim.claim_id) || seen.has(claim.claim_id)) continue;
    seen.add(claim.claim_id);
    permittedClaims.push(claim);
  }

  return {
    ok: true,
    value: { ...input, claims: permittedClaims },
    omittedEvidenceIds: [...omittedIds].sort(),
    inputClaimCount: input.claims.length,
  };
}
