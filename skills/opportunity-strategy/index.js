import { validate } from "../../schemas/index.js";
import { loadAccountIntelligenceReferences } from "../../reference/account-intelligence.js";
import {
  failedSkill,
  referenceEntries,
  resolveClaimIds,
  safeReferenceStatus,
  skillResult,
  startedAt,
  visibleClaims,
} from "../account-intelligence/common.js";
import { matchOfferings } from "../offering-match/index.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "opportunity.strategy";
export const SKILL_VERSION = "0.1.0";

const EVENT_FIELDS = Object.freeze([
  "event",
  "deadline",
  "consequence",
  "accountable_owner",
  "relevantz_service_need",
  "next_customer_decision",
]);

const DISCOVERY_QUESTIONS = Object.freeze({
  event: "What changed, and can the customer confirm the event is current?",
  deadline: "Is there a customer-owned deadline? If so, what must be decided by when?",
  consequence: "What consequence does the customer expect if the issue is not addressed?",
  accountable_owner: "Who is accountable for the outcome, and who participates in the decision?",
  relevantz_service_need: "What customer outcome or service need should be assessed against an approved catalogue?",
  next_customer_decision: "What customer decision would create a real opportunity rather than continued exploration?",
});

function fail(started, code, message) {
  return failedSkill(SKILL_NAME, started, code, message);
}

function validateQualificationResult(result, accountId, claimsById, withheldIds) {
  if (
    !validate("skillResult", result).valid ||
    result.skill !== "qualification.assess" ||
    !["success", "partial"].includes(result.status) ||
    !result.data ||
    !validate("qualificationAssessment", result.data).valid
  ) {
    return {
      ok: false,
      code: "QUALIFICATION_RESULT_INVALID",
      message: "A successful qualification assessment in the standard skill-result format is required.",
    };
  }

  if (result.data.account_id !== accountId) {
    return {
      ok: false,
      code: "ACCOUNT_SCOPE_MISMATCH",
      message: "The qualification assessment must belong to the requested account.",
    };
  }
  if (result.data.qualification_decision !== "not_determined") {
    return {
      ok: false,
      code: "QUALIFICATION_RESULT_INVALID",
      message: "Qualification decisions are not consumed as approved stage rules.",
    };
  }

  const referencedIds = new Set();
  const validateEvidence = (items) => {
    const ids = items.map((item) => item.claim_id);
    if (new Set(ids).size !== ids.length) {
      return {
        ok: false,
        code: "QUALIFICATION_RESULT_INVALID",
        message: "Qualification evidence must use unique normalized claim references.",
      };
    }
    const resolved = ids.length > 0
      ? resolveClaimIds(ids, claimsById, withheldIds)
      : { ok: true, ids: [] };
    if (!resolved.ok) return resolved;

    const evidence = resolved.ids.map((id) => {
      const sourceClaim = claimsById.get(id);
      const supplied = items.find((item) => item.claim_id === id);
      if (supplied.excerpt !== sourceClaim.excerpt) return null;
      referencedIds.add(id);
      return { claim_id: id, excerpt: sourceClaim.excerpt };
    });
    if (evidence.some((item) => item === null)) {
      return {
        ok: false,
        code: "QUALIFICATION_EVIDENCE_INVALID",
        message: "Qualification excerpts must exactly match visible normalized evidence.",
      };
    }
    return { ok: true, evidence };
  };

  for (const assessment of result.data.criteria_set.assessments) {
    const checked = validateEvidence(assessment.evidence);
    if (!checked.ok) return checked;
  }

  const normalizedFields = {};
  for (const fieldId of EVENT_FIELDS) {
    const field = result.data.event_assessment.fields[fieldId];
    const checked = validateEvidence(field.evidence);
    if (!checked.ok) return checked;
    if ((checked.evidence.length === 0) !== (field.evidence_state === "missing")) {
      return {
        ok: false,
        code: "QUALIFICATION_RESULT_INVALID",
        message: "Qualification evidence state does not match its linked evidence.",
      };
    }

    const ids = checked.evidence.map((item) => item.claim_id);
    const hasConflictingClaim = ids.some(
      (id) => claimsById.get(id).verification_status === "conflicting",
    );
    const evidenceState = ids.length === 0
      ? "missing"
      : hasConflictingClaim || field.evidence_state === "conflicting_evidence"
        ? "conflicting"
        : field.evidence_state === "uncertain_evidence" ||
            ids.some((id) => claimsById.get(id).verification_status === "inferred" ||
              claimsById.get(id).confidence === "low")
          ? "uncertain"
          : "linked";

    normalizedFields[fieldId] = { evidence_state: evidenceState, evidence: checked.evidence };
  }

  const declaredEvidence = result.evidence_ids.length > 0
    ? resolveClaimIds(result.evidence_ids, claimsById, withheldIds)
    : { ok: true, ids: [] };
  if (!declaredEvidence.ok) return declaredEvidence;
  const declaredIds = new Set(result.evidence_ids);
  if (
    declaredIds.size !== result.evidence_ids.length ||
    declaredIds.size !== referencedIds.size ||
    [...declaredIds].some((id) => !referencedIds.has(id))
  ) {
    return {
      ok: false,
      code: "QUALIFICATION_EVIDENCE_INVALID",
      message: "Qualification result evidence references are inconsistent.",
    };
  }

  return {
    ok: true,
    fields: normalizedFields,
    status: result.status,
    policyUnavailable: result.warnings.some((warning) => warning.code === "POLICY_UNAVAILABLE"),
  };
}

function evidenceForFields(fields, fieldIds) {
  const byId = new Map();
  for (const fieldId of fieldIds) {
    for (const item of fields[fieldId].evidence) byId.set(item.claim_id, item);
  }
  return [...byId.values()].sort((left, right) => left.claim_id.localeCompare(right.claim_id));
}

function makeDiscoveryQuestions(fields) {
  return EVENT_FIELDS
    .map((fieldId) => ({
      id: fieldId,
      question: DISCOVERY_QUESTIONS[fieldId],
      evidence_state: fields[fieldId].evidence_state,
      evidence_ids: fields[fieldId].evidence.map((item) => item.claim_id),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function makeNextActions(fields, problemEvidence, offeringCandidates) {
  const allEventEvidence = evidenceForFields(fields, EVENT_FIELDS).map((item) => item.claim_id);
  const offeringEvidence = [...new Set(
    offeringCandidates.flatMap((candidate) => candidate.evidence_ids),
  )].sort();
  return [
    {
      id: "confirm_customer_need",
      text: "Confirm the current customer problem and desired outcome before treating it as an opportunity hypothesis.",
      provenance: {
        kind: problemEvidence.length > 0 ? "visible_evidence" : "open_evidence_gap",
        evidence_ids: problemEvidence.map((item) => item.claim_id),
      },
    },
    {
      id: "validate_event_and_decision",
      text: "Validate any event, deadline, consequence, accountable owner, and next customer decision with the customer.",
      provenance: {
        kind: allEventEvidence.length > 0 ? "visible_evidence" : "open_evidence_gap",
        evidence_ids: allEventEvidence,
      },
    },
    {
      id: "review_candidate_fit",
      text: "Review any caller-mapped offering candidate and its uncertainties with appropriate internal reviewers.",
      provenance: {
        kind: offeringCandidates.length > 0 ? "visible_evidence" : "open_evidence_gap",
        evidence_ids: offeringEvidence,
      },
    },
    {
      id: "no_stage_action",
      text: "Do not create or convert an opportunity or change a stage; approved stage rules and CRM actions are unavailable here.",
      provenance: { kind: "unapproved_stage_rules", evidence_ids: [] },
    },
  ];
}

function makeProblemHypothesis(problemEvidence, fields) {
  const claimIds = problemEvidence.map((item) => item.claim_id);
  const hasConflict = problemEvidence.some((item) =>
    item.verification_status === "conflicting",
  ) || ["event", "consequence", "relevantz_service_need"].some(
    (fieldId) => fields[fieldId].evidence_state === "conflicting",
  );
  const statement = problemEvidence.length === 0
    ? "No customer problem is established by the supplied assessment evidence."
    : "The linked evidence suggests a possible initiative or service need to validate with the customer; it does not establish a problem, outcome, urgency, or ownership.";
  return {
    status: problemEvidence.length === 0
      ? "needs_discovery"
      : hasConflict
        ? "conflicted_hypothesis"
        : "tentative",
    statement,
    claim_ids: claimIds,
    evidence_ids: claimIds,
  };
}

export function assessOpportunityStrategy(input, deps = {}) {
  const started = startedAt(deps);
  const inputResult = validateInput(input);
  if (!inputResult.ok) return fail(started, inputResult.code, inputResult.message);

  const value = inputResult.value;
  const visible = visibleClaims(value.account_id, value.claims, value.classification_ceiling);
  if (!visible.ok) return fail(started, visible.code, visible.message);

  const qualification = validateQualificationResult(
    value.qualification_result,
    value.account_id,
    visible.byId,
    visible.withheldIds,
  );
  if (!qualification.ok) return fail(started, qualification.code, qualification.message);

  let referenceRegistry;
  try {
    referenceRegistry = deps.referenceRegistry ?? loadAccountIntelligenceReferences();
  } catch {
    return fail(started, "REFERENCE_UNAVAILABLE", "The offering reference vocabulary could not be loaded.");
  }

  const offeringResult = matchOfferings({
    account_id: value.account_id,
    claims: value.claims,
    annotations: value.offering_annotations,
    classification_ceiling: value.classification_ceiling,
  }, { now: deps.now, referenceRegistry });
  if (offeringResult.status !== "success") {
    const error = offeringResult.errors[0];
    return fail(
      started,
      error?.code ?? "OFFERING_MAPPING_INVALID",
      error?.message ?? "The supplied offering mappings could not be validated.",
    );
  }

  const offeringRegistry = referenceEntries(referenceRegistry.offerings, "offerings");
  if (value.offering_annotations.length > 0 && !offeringRegistry.ok) {
    return fail(started, "REFERENCE_INVALID", "A valid versioned offering vocabulary is required for mapped offerings.");
  }

  const eventAssessment = {
    status: "unverified",
    fields: qualification.fields,
  };
  const problemEvidence = evidenceForFields(qualification.fields, [
    "event",
    "consequence",
    "relevantz_service_need",
  ]);
  const problemHypothesis = makeProblemHypothesis(
    problemEvidence.map((item) => ({
      ...item,
      verification_status: visible.byId.get(item.claim_id).verification_status,
    })),
    qualification.fields,
  );
  const problemIds = new Set(problemHypothesis.evidence_ids);

  const offeringCandidates = offeringResult.data.matches.map((match) => {
    const offering = offeringRegistry.entries.get(match.offering_id);
    const linkedToProblem = match.claim_ids.some((id) => problemIds.has(id));
    const catalogueStatus = referenceRegistry.offerings.status === "approved" ||
        referenceRegistry.offerings.status === "provisional"
      ? referenceRegistry.offerings.status
      : "unknown";
    return {
      offering_id: match.offering_id,
      label: offering?.label ?? match.offering_id,
      catalogue_status: catalogueStatus,
      fit_basis: linkedToProblem
        ? "caller_mapping_overlaps_problem_evidence"
        : "not_linked_to_problem_evidence",
      match_status: match.match_status,
      rationale: match.rationale,
      uncertainties: match.uncertainties,
      discovery_questions: match.discovery_questions,
      claim_ids: match.claim_ids,
      evidence_ids: match.evidence_ids,
    };
  });

  const valueHypotheses = offeringCandidates
    .filter((candidate) =>
      candidate.fit_basis === "caller_mapping_overlaps_problem_evidence" &&
      candidate.claim_ids.length > 0 &&
      problemIds.size > 0 &&
      !candidate.claim_ids.some((id) =>
        visible.byId.get(id).verification_status === "conflicting",
      ) &&
      !["event", "consequence", "relevantz_service_need"].some(
        (fieldId) => qualification.fields[fieldId].evidence_state === "conflicting",
      ),
    )
    .map((candidate) => {
      const evidenceIds = [...new Set([...candidate.claim_ids, ...problemIds])].sort();
      return {
        offering_id: candidate.offering_id,
        status: "tentative",
        statement: "If the cited initiative or service need is confirmed, evaluate whether this caller-mapped candidate could address it; no fit, outcome, or delivery capability is established.",
        claim_ids: evidenceIds,
        evidence_ids: evidenceIds,
      };
    });

  const evidenceIds = [...new Set([
    ...EVENT_FIELDS.flatMap((fieldId) =>
      qualification.fields[fieldId].evidence.map((item) => item.claim_id),
    ),
    ...offeringCandidates.flatMap((candidate) => candidate.evidence_ids),
  ])].sort();
  const warnings = [];
  if (qualification.policyUnavailable) {
    warnings.push({
      code: "POLICY_UNAVAILABLE",
      message: "Qualification decisions, compelling-event verification, and stage readiness remain advisory and unresolved.",
    });
  }
  if (Object.values(qualification.fields).some((field) => field.evidence_state !== "linked")) {
    warnings.push({
      code: "EVENT_FIELDS_INCOMPLETE",
      message: "One or more compelling-event fields require customer discovery or validation.",
    });
  }
  if (Object.values(qualification.fields).some((field) => field.evidence_state === "conflicting")) {
    warnings.push({
      code: "CONFLICTED_EVIDENCE",
      message: "Conflicting event evidence is retained for review; no winner is selected.",
    });
  }
  if (problemEvidence.length === 0) {
    warnings.push({
      code: "PROBLEM_EVIDENCE_MISSING",
      message: "No visible evidence supports a customer problem hypothesis.",
    });
  }
  if (offeringCandidates.length === 0) {
    warnings.push({
      code: "OFFERING_CANDIDATES_MISSING",
      message: "No caller-provided offering mappings were supplied.",
    });
  }
  if (offeringCandidates.some((candidate) => candidate.catalogue_status !== "approved")) {
    warnings.push({
      code: "CATALOGUE_NOT_APPROVED",
      message: "Offering candidates use a non-approved or unknown catalogue.",
    });
  }
  if (
    offeringResult.warnings.some((warning) => warning.code === "CONFLICTED_EVIDENCE") &&
    !warnings.some((warning) => warning.code === "CONFLICTED_EVIDENCE")
  ) {
    warnings.push({
      code: "CONFLICTED_EVIDENCE",
      message: "Conflicting offering evidence is retained for review; no winner is selected.",
    });
  }

  const data = {
    account_id: value.account_id,
    event_assessment: eventAssessment,
    customer_problem_hypothesis: problemHypothesis,
    offering_catalogue: safeReferenceStatus(referenceRegistry.offerings, "offerings"),
    offering_candidates: offeringCandidates,
    value_hypotheses: valueHypotheses,
    discovery_questions: makeDiscoveryQuestions(qualification.fields),
    proposed_next_actions: makeNextActions(
      qualification.fields,
      problemEvidence,
      offeringCandidates,
    ),
    stage_readiness: { status: "unavailable", reason: "NO_APPROVED_STAGE_RULES" },
  };
  const outputValidation = validate("opportunityStrategyResult", data);
  if (!outputValidation.valid) {
    throw new Error(`opportunity.strategy produced invalid data: ${JSON.stringify(outputValidation.errors)}`);
  }

  const partial =
    qualification.status === "partial" ||
    Object.values(qualification.fields).some((field) => field.evidence_state !== "linked") ||
    problemEvidence.length === 0 ||
    offeringCandidates.length === 0 ||
    offeringCandidates.some((candidate) => candidate.catalogue_status !== "approved") ||
    offeringResult.warnings.length > 0;
  return skillResult({
    skill: SKILL_NAME,
    status: partial ? "partial" : "success",
    data,
    started,
    evidenceIds,
    warnings,
  });
}

export default assessOpportunityStrategy;
