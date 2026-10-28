import { createHash } from "node:crypto";
import { normalizeText } from "./text.js";

/** Restrictiveness ranking. A claim may only keep or raise the record's level. */
const CLASSIFICATION_RANK = Object.freeze({ public: 0, internal: 1, confidential: 2 });

/**
 * Deterministic claim ID, documented and stable:
 *   "clm_" + first 16 hex characters of
 *   SHA-256("<account_id>|<source_record_id>|<normalized claim text>")
 * The same input always yields the same ID; equivalent claims from the same
 * record collapse to one ID, which is also the duplicate key.
 */
export function deriveClaimId(accountId, sourceRecordId, claimText) {
  const material = accountId + "|" + sourceRecordId + "|" + normalizeText(claimText);
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return "clm_" + digest;
}

/** Duplicate key: exact normalized claim text within the same source record. */
export function duplicateKey(accountId, sourceRecordId, claimText) {
  return deriveClaimId(accountId, sourceRecordId, claimText);
}

/**
 * Candidate classification may equal or exceed the record's classification.
 * Returns true when the candidate attempts a downgrade.
 */
export function isClassificationDowngrade(recordClassification, candidateClassification) {
  return CLASSIFICATION_RANK[candidateClassification] < CLASSIFICATION_RANK[recordClassification];
}

/**
 * Deterministic confidence policy from SKILL.md. "low" is never emitted:
 * weak candidates are rejected instead.
 */
export function confidenceFor(completeness) {
  return completeness === "complete" ? "high" : "medium";
}

/**
 * Group accepted claims that declared a conflict_key. A group containing at
 * least two distinct normalized claim texts is a conflict: every claim in it
 * is marked "conflicting" and listed together. No winner is selected and the
 * claims are never merged.
 *
 * @param {object[]} claims accepted claims (verification_status mutated in place)
 * @returns {object[]} conflicts, deterministically ordered
 */
export function detectConflicts(claims) {
  const groups = new Map();
  for (const claim of claims) {
    if (!claim.conflict_key) continue;
    const group = groups.get(claim.conflict_key) ?? [];
    group.push(claim);
    groups.set(claim.conflict_key, group);
  }

  const conflicts = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const distinctTexts = new Set(group.map((claim) => normalizeText(claim.claim)));
    if (distinctTexts.size < 2) continue;

    for (const claim of group) claim.verification_status = "conflicting";

    const claimIds = group.map((claim) => claim.claim_id).sort();
    const material = claimIds.join(",");
    const conflictId = "cfl_" + createHash("sha256").update(material).digest("hex").slice(0, 16);
    conflicts.push({
      conflict_id: conflictId,
      conflict_key: key,
      claim_ids: claimIds,
      description:
        'Directly supported claims disagree on "' + key + '". Both are retained; neither is selected as correct.',
    });
  }
  return conflicts.sort((a, b) => a.conflict_id.localeCompare(b.conflict_id));
}

/** Deterministic claim order: source record, then claim ID. */
export function compareClaims(a, b) {
  return (
    a.source_record_id.localeCompare(b.source_record_id) || a.claim_id.localeCompare(b.claim_id)
  );
}

/** Deterministic rejection order: record, then reason, then candidate index. */
export function compareRejections(a, b) {
  return (
    a.source_record_id.localeCompare(b.source_record_id) ||
    a.reason.localeCompare(b.reason) ||
    (a.candidate_index ?? -1) - (b.candidate_index ?? -1)
  );
}