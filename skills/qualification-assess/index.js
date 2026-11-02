import { validate } from "../../schemas/index.js";
import {
  CLASSIFICATION_RANK,
  failedSkill,
  resolveClaimIds,
  skillResult,
  startedAt,
  visibleClaims,
} from "../account-intelligence/common.js";

export const SKILL_NAME = "qualification.assess";
export const SKILL_VERSION = "0.1.0";

export const EVENT_FIELDS = Object.freeze([
  "event",
  "deadline",
  "consequence",
  "accountable_owner",
  "relevantz_service_need",
  "next_customer_decision",
]);

const CLAIM_ID_PATTERN = /^clm_[A-Za-z0-9_-]+$/;
const FIELD_QUESTIONS = Object.freeze({
  event: "What changed, and how can the customer confirm that trigger?",
  deadline: "When must the customer act, and who can confirm that date?",
  consequence: "What happens if the customer does not act by that date?",
  accountable_owner: "Who is accountable for the outcome and can confirm ownership?",
  relevantz_service_need: "What customer-described need would require Relevantz support?",
  next_customer_decision: "What decision should the customer make next, and who will participate?",
});

function failed(start, code, message) {
  return failedSkill(SKILL_NAME, start, code, message);
}

function resolveReferences(ids, visibility) {
  if (ids.length === 0) return { ok: true, ids: [] };
  return resolveClaimIds(ids, visibility.byId, visibility.withheldIds);
}

function hasDuplicateNormalizedClaimIds(claims) {
  const seen = new Set();
  for (const claim of claims) {
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) continue;
    const claimId = claim.claim_id;
    if (typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId)) continue;
    if (seen.has(claimId)) return true;
    seen.add(claimId);
  }
  return false;
}

function classifyVisibleClaims(accountId, claims, ceiling) {
  const ceilingRank = CLASSIFICATION_RANK[ceiling];
  if (!Array.isArray(claims) || ceilingRank === undefined) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Normalized claims and a valid classification ceiling are required.",
    };
  }
  if (hasDuplicateNormalizedClaimIds(claims)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Normalized claim identifiers must be unique.",
    };
  }

  const visibleCandidates = [];
  const withheldIds = new Set();
  for (const claim of claims) {
    const rank = typeof claim === "object" && claim !== null
      ? CLASSIFICATION_RANK[claim.access_classification]
      : undefined;
    if (rank !== undefined && rank > ceilingRank) {
      if (typeof claim.claim_id === "string" && CLAIM_ID_PATTERN.test(claim.claim_id)) {
        withheldIds.add(claim.claim_id);
      }
      continue;
    }
    visibleCandidates.push(claim);
  }

  const visibility = visibleClaims(accountId, visibleCandidates, ceiling);
  if (!visibility.ok) return visibility;
  for (const claimId of visibility.byId.keys()) withheldIds.delete(claimId);
  return {
    ...visibility,
    claims: visibleCandidates,
    withheldIds,
  };
}

function visibleConflictCandidates(conflicts, withheldIds) {
  return (conflicts ?? []).filter((conflict) => {
    const claimIds = Array.isArray(conflict?.claim_ids) ? conflict.claim_ids : [];
    return !claimIds.some((claimId) => withheldIds.has(claimId));
  });
}

function visibleConflictClaims(conflicts, visibility) {
  const conflictGroups = [];
  for (const conflict of conflicts ?? []) {
    const ids = conflict.claim_ids;
    if (!Array.isArray(ids)) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "A conflict must contain normalized claim references.",
      };
    }
    if (ids.some((id) => visibility.withheldIds.has(id))) continue;
    if (ids.some((id) => !visibility.byId.has(id))) {
      return {
        ok: false,
        code: "EVIDENCE_REFERENCE_UNAVAILABLE",
        message: "A conflict references evidence unavailable in this account and classification scope.",
      };
    }
    conflictGroups.push([...new Set(ids)].sort());
  }
  return {
    ok: true,
    ids: new Set(conflictGroups.flat()),
    groups: conflictGroups,
  };
}

function expandConflictReferences(ids, conflictGroups) {
  const expanded = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of conflictGroups) {
      if (!group.some((id) => expanded.has(id))) continue;
      for (const id of group) {
        if (expanded.has(id)) continue;
        expanded.add(id);
        changed = true;
      }
    }
  }
  return [...expanded].sort();
}

function evidenceFor(ids, claimIndex) {
  return [...ids].sort().map((claimId) => ({
    claim_id: claimId,
    excerpt: claimIndex.get(claimId).excerpt,
  }));
}

function evidenceState(ids, claimIndex, conflictedClaimIds) {
  if (ids.length === 0) return "missing";
  if (ids.some((id) => conflictedClaimIds.has(id))) return "conflicting_evidence";
  if (ids.some((id) => {
    const claim = claimIndex.get(id);
    return claim.verification_status === "inferred" || claim.confidence === "low";
  })) {
    return "uncertain_evidence";
  }
  return "evidence_linked";
}

function discoveryQuestions(criteria, fields) {
  const questions = [];
  if (criteria.length === 0) {
    questions.push({
      target: "criteria_definition",
      question: "Which versioned qualification criteria, definitions, and evidence rules are authorized?",
    });
  } else {
    for (const criterion of criteria) {
      questions.push({
        target: "criterion",
        criterion_id: criterion.id,
        question: "What evidence and human confirmation are required to assess this caller-supplied criterion?",
      });
    }
  }

  for (const field of EVENT_FIELDS) {
    const state = fields[field].evidence_state;
    const question = state === "conflicting_evidence"
      ? `Which customer or source-owner clarification can address the conflicting ${field.replaceAll("_", " ")} evidence?`
      : state === "uncertain_evidence"
        ? `Who can confirm whether the linked ${field.replaceAll("_", " ")} evidence is accurate and current?`
        : state === "missing"
          ? FIELD_QUESTIONS[field]
          : `Can the customer confirm that the linked ${field.replaceAll("_", " ")} evidence is accurate and current?`;
    questions.push({ target: field, question });
  }

  questions.push({
    target: "stage_readiness",
    question: "What approved lifecycle mapping, QL/SAL order, and advancement gates should govern any stage recommendation?",
  });
  return questions;
}

/**
 * Inventory caller-mapped, same-account evidence without interpreting it as
 * qualification, event verification, urgency, or stage readiness.
 */
export function assessQualification(input, deps = {}) {
  const started = startedAt(deps);
  const isObject = typeof input === "object" && input !== null && !Array.isArray(input);
  const hasConflicts = isObject && Object.hasOwn(input, "conflicts");
  const inputWithoutConflicts = isObject ? { ...input } : input;
  if (hasConflicts) delete inputWithoutConflicts.conflicts;
  const inputValidation = validate("qualificationAssessInput", inputWithoutConflicts);
  if (!inputValidation.valid || (hasConflicts && !Array.isArray(input.conflicts))) {
    return failed(
      started,
      "INVALID_INPUT",
      "Qualification assessment input does not match its contract.",
    );
  }

  const visibility = classifyVisibleClaims(
    input.account_id,
    input.claims,
    input.classification_ceiling,
  );
  if (!visibility.ok) {
    return failed(started, visibility.code, visibility.message);
  }

  const conflictCandidates = visibleConflictCandidates(input.conflicts, visibility.withheldIds);
  const visibleInput = {
    ...input,
    claims: visibility.claims,
    ...(input.conflicts === undefined ? {} : { conflicts: conflictCandidates }),
  };
  if (!validate("qualificationAssessInput", visibleInput).valid) {
    return failed(started, "INVALID_INPUT", "Qualification assessment input does not match its contract.");
  }

  const conflicts = visibleConflictClaims(conflictCandidates, visibility);
  if (!conflicts.ok) return failed(started, conflicts.code, conflicts.message);

  const criteria = input.criteria_set?.criteria ?? [];
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    return failed(started, "INVALID_INPUT", "Caller-supplied criteria identifiers must be unique.");
  }

  const criterionEvidence = [];
  for (const criterion of criteria) {
    const resolved = resolveReferences(criterion.evidence_ids ?? [], visibility);
    if (!resolved.ok) return failed(started, resolved.code, resolved.message);
    const displayedIds = expandConflictReferences(resolved.ids, conflicts.groups);
    criterionEvidence.push({
      id: criterion.id,
      label: criterion.label,
      definition: criterion.definition,
      evidence_state: evidenceState(displayedIds, visibility.byId, conflicts.ids),
      evidence: evidenceFor(displayedIds, visibility.byId),
    });
  }

  const fields = {};
  for (const field of EVENT_FIELDS) {
    const resolved = resolveReferences(input.event_evidence?.[field] ?? [], visibility);
    if (!resolved.ok) return failed(started, resolved.code, resolved.message);
    const displayedIds = expandConflictReferences(resolved.ids, conflicts.groups);
    fields[field] = {
      evidence_state: evidenceState(displayedIds, visibility.byId, conflicts.ids),
      evidence: evidenceFor(displayedIds, visibility.byId),
    };
  }

  const data = {
    account_id: input.account_id,
    criteria_set: {
      status: input.criteria_set?.approval_status ?? "unprovided",
      version: input.criteria_set?.version ?? null,
      assessments: criterionEvidence,
    },
    qualification_decision: "not_determined",
    event_assessment: {
      status: "unverified",
      fields,
    },
    stage_readiness: {
      status: "unavailable",
      reason: "NO_APPROVED_STAGE_RULES",
    },
    discovery_questions: discoveryQuestions(criteria, fields),
  };

  const dataValidation = validate("qualificationAssessment", data);
  if (!dataValidation.valid) {
    return failed(started, "INTERNAL_ERROR", "Qualification assessment output failed validation.");
  }

  const evidenceIds = [
    ...new Set([
      ...criterionEvidence.flatMap((criterion) => criterion.evidence.map((item) => item.claim_id)),
      ...Object.values(fields).flatMap((field) => field.evidence.map((item) => item.claim_id)),
    ]),
  ].sort();
  const unresolved = criteria.length === 0 ||
    criterionEvidence.some((item) => item.evidence_state !== "evidence_linked") ||
    Object.values(fields).some((item) => item.evidence_state !== "evidence_linked");
  return skillResult({
    skill: SKILL_NAME,
    status: unresolved ? "partial" : "success",
    data,
    started,
    evidenceIds,
    warnings: [{
      code: "POLICY_UNAVAILABLE",
      message: "Qualification decisions, compelling-event verification, and stage readiness remain advisory and unresolved.",
    }],
  });
}

export default assessQualification;
