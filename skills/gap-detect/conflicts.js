import { createHash } from "node:crypto";

const CLAIM_ID_PATTERN = /^clm_[A-Za-z0-9_-]+$/;
const CONFLICT_ID_PATTERN = /^cfl_[A-Za-z0-9_-]+$/;

export function deriveConflictId(claimIds) {
  const material = [...claimIds].sort().join(",");
  return "cfl_" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function evaluateConflicts(rawConflicts, { accepted, acceptedIds }) {
  const conflicts = [];
  const rejections = [];
  const seenConflictIds = new Set();

  rawConflicts.forEach((rawConflict, index) => {
    const conflict = Array.isArray(rawConflict) ? { claim_ids: rawConflict } : rawConflict;
    const reject = (reason, message, details = {}) =>
      rejections.push({ reason, message, details: { conflict_index: index, ...details } });

    if (typeof conflict !== "object" || conflict === null || Array.isArray(conflict)) {
      reject("malformed_conflict", "A conflict entry was not an object and was not used.");
      return;
    }

    if (
      !Array.isArray(conflict.claim_ids) ||
      conflict.claim_ids.length === 0 ||
      conflict.claim_ids.some(
        (claimId) => typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId),
      )
    ) {
      reject(
        "malformed_conflict",
        "A conflict entry did not contain a non-empty list of evidence IDs and was not used.",
      );
      return;
    }

    const claimIds = [...new Set(conflict.claim_ids)].sort();
    const missingClaimIds = claimIds.filter((claimId) => !acceptedIds.has(claimId));
    if (missingClaimIds.length > 0) {
      reject(
        "unknown_claim_reference",
        "A conflict referenced evidence IDs that were not accepted and was not used.",
        { missing_claim_ids: missingClaimIds },
      );
      return;
    }

    const candidateConflictId = conflict.conflict_id ?? conflict.id;
    const conflictId =
      candidateConflictId === undefined ? deriveConflictId(claimIds) : candidateConflictId;

    if (typeof conflictId !== "string" || !CONFLICT_ID_PATTERN.test(conflictId)) {
      reject(
        "malformed_conflict",
        "A conflict entry did not contain a valid conflict ID and was not used.",
      );
      return;
    }
    if (seenConflictIds.has(conflictId)) {
      reject("duplicate_conflict_id", "A duplicate conflict ID was not used.", {
        conflict_id: conflictId,
      });
      return;
    }

    seenConflictIds.add(conflictId);
    conflicts.push({ conflict_id: conflictId, claim_ids: claimIds });
  });

  const referencedClaimIds = new Set(conflicts.flatMap((conflict) => conflict.claim_ids));
  let derivedCount = 0;

  for (const claim of accepted.values()) {
    if (claim.verification_status !== "conflicting") continue;
    if (referencedClaimIds.has(claim.claim_id)) continue;

    const conflictId = deriveConflictId([claim.claim_id]);
    if (seenConflictIds.has(conflictId)) continue;

    seenConflictIds.add(conflictId);
    referencedClaimIds.add(claim.claim_id);
    conflicts.push({ conflict_id: conflictId, claim_ids: [claim.claim_id] });
    derivedCount += 1;
  }

  conflicts.sort((a, b) => a.conflict_id.localeCompare(b.conflict_id));

  return { conflicts, rejections, derivedCount };
}
