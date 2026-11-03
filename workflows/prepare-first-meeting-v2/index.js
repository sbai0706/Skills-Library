import { randomUUID } from "node:crypto";
import { validate, validateFirstMeetingBriefInputV2 } from "../../schemas/index.js";
import { loadAccountIntelligenceReferences } from "../../reference/account-intelligence.js";
import { renderFirstMeetingBriefV2 } from "../../skills/artifact-render/first-meeting-brief-v2.js";
import { extractSignals as extractSignalsSkill } from "../../skills/signal-extract/index.js";
import { mapStakeholders as mapStakeholdersSkill } from "../../skills/stakeholder-map/index.js";
import { matchOfferings as matchOfferingsSkill } from "../../skills/offering-match/index.js";
import { normalizeEvidence as normalizeEvidenceSkill } from "../../skills/evidence-normalize/index.js";
import { detectGaps as detectGapsSkill } from "../../skills/gap-detect/index.js";
import { prepareFirstMeeting } from "../prepare-first-meeting/index.js";
import { verifyProvenance } from "../prepare-first-meeting/provenance.js";
import { validateInput } from "./validate-input.js";
import { safeReferenceStatus, visibleClaims } from "../../skills/account-intelligence/common.js";

export const WORKFLOW_NAME = "prepare-first-meeting-v2";
export const WORKFLOW_VERSION = "0.1.0";

const SKILL_SCHEMA = Object.freeze({
  "signal.extract": ["signalResult", "signal-extract"],
  "stakeholder.map": ["stakeholderMap", "stakeholder-map"],
  "offering.match": ["offeringMatch", "offering-match"],
});

function nowIso(deps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

function diagnostic(step, skill, code) {
  const message = step === "workflow.input"
    ? "Workflow input could not be accepted."
    : step === "account-intelligence.validate"
      ? "The v2 brief failed semantic validation."
      : `${skill} reported ${code}.`;
  return { step, skill, code, message, retryable: false };
}

function stepSummary(step, skill, status, result) {
  return {
    step,
    skill,
    status,
    ...(result ? {
      warning_codes: [...new Set((result.warnings ?? []).map((item) => item.code))].sort(),
      error_codes: [...new Set((result.errors ?? []).map((item) => item.code))].sort(),
    } : {}),
  };
}

function addSkillDiagnostics(step, skill, result, warnings, errors) {
  for (const warning of result.warnings ?? []) {
    warnings.push(diagnostic(step, skill, warning.code));
  }
  for (const error of result.errors ?? []) {
    errors.push(diagnostic(step, skill, error.code));
  }
}

async function runAccountIntelligenceSkill(fn, input, deps) {
  try {
    const result = await fn(input, deps);
    if (!validate("skillResult", result).valid) {
      return { result: null, code: "WORKFLOW_INTERNAL_ERROR" };
    }
    const [dataSchema] = SKILL_SCHEMA[result.skill] ?? [];
    if (!dataSchema || !["success", "partial"].includes(result.status) ||
        !validate(dataSchema, result.data).valid) {
      return { result, code: result.errors?.[0]?.code ?? "WORKFLOW_INTERNAL_ERROR" };
    }
    return { result, code: null };
  } catch {
    return { result: null, code: "WORKFLOW_INTERNAL_ERROR" };
  }
}

function emptySkillStatus() {
  return { version: null, status: "unknown" };
}

function visibleConflictInputs(conflicts, visibleClaimIds, withheldClaimIds) {
  if (!Array.isArray(conflicts)) return [];

  return conflicts.flatMap((conflict) => {
    const claimIds = Array.isArray(conflict) ? conflict : conflict?.claim_ids;
    if (!Array.isArray(claimIds) || claimIds.length === 0) return [conflict];

    const visibleIds = [...new Set(claimIds.filter((id) => visibleClaimIds.has(id)))].sort();
    if (visibleIds.length === 0) {
      return claimIds.every((id) => withheldClaimIds.has(id)) ? [] : [conflict];
    }
    if (claimIds.some((id) => !visibleClaimIds.has(id) && !withheldClaimIds.has(id))) {
      return [conflict];
    }

    const sanitized = { claim_ids: visibleIds };
    if (
      !Array.isArray(conflict) &&
      claimIds.every((id) => visibleClaimIds.has(id)) &&
      typeof conflict.conflict_id === "string"
    ) {
      sanitized.conflict_id = conflict.conflict_id;
    }
    return [sanitized];
  });
}

function visibleBaseSteps(baseSteps, visibleClaimCount, visibleConflictCount) {
  return baseSteps.map((step) => {
    if (step.step !== "evidence.normalize") return step;
    return {
      ...step,
      ...(typeof step.claim_count === "number" ? { claim_count: visibleClaimCount } : {}),
      ...(typeof step.conflict_count === "number" ? { conflict_count: visibleConflictCount } : {}),
    };
  });
}

/**
 * Compose the existing first-meeting workflow with explicit Account Intelligence mappings.
 * The v1 workflow and its renderer remain unchanged.
 */
export async function prepareFirstMeetingV2(input, deps = {}) {
  const started = nowIso(deps);
  const traceId = deps.traceId ?? `trace_${randomUUID()}`;
  const warnings = [];
  const errors = [];
  const steps = [];
  let baseResult = null;
  let finalArtifact = null;
  let accountIntelligence = null;
  let finalEvidenceIds = [];
  let visibleClaimsForGaps = null;
  let visibleClaimCount = 0;
  let visibleConflictCount = 0;
  let withheldClaimIds = new Set();
  let classificationCeiling = "internal";

  const finish = (status) => {
    if ((status === "failed" || status === "blocked") && errors.length === 0) {
      errors.push(diagnostic("workflow.input", WORKFLOW_NAME, "WORKFLOW_INTERNAL_ERROR"));
    }
    const result = {
      workflow: WORKFLOW_NAME,
      workflow_version: WORKFLOW_VERSION,
      status,
      account: baseResult?.account ?? null,
      account_candidates: baseResult?.account_candidates ?? [],
      artifact: finalArtifact,
      account_intelligence: accountIntelligence,
      evidence_ids: finalEvidenceIds,
      warnings,
      errors,
      steps,
      trace_id: traceId,
      started_at: started,
      finished_at: nowIso(deps),
    };
    const validation = validate("prepareFirstMeetingV2Result", result);
    if (!validation.valid) {
      throw new Error(`prepare-first-meeting-v2 produced an invalid result: ${JSON.stringify(validation.errors)}`);
    }
    return result;
  };

  const inputResult = validateInput(input);
  if (!inputResult.ok) {
    steps.push(stepSummary("workflow.input", WORKFLOW_NAME, "failed"));
    errors.push(diagnostic("workflow.input", WORKFLOW_NAME, inputResult.errors[0]?.code ?? "INVALID_INPUT"));
    return finish("failed");
  }
  classificationCeiling =
    inputResult.value.workflow_input.classification_ceiling ?? "internal";

  let referenceRegistry;
  try {
    referenceRegistry = deps.referenceRegistry ?? loadAccountIntelligenceReferences();
  } catch {
    steps.push(stepSummary("account-intelligence.references", WORKFLOW_NAME, "failed"));
    errors.push(diagnostic("account-intelligence.references", WORKFLOW_NAME, "REFERENCE_UNAVAILABLE"));
    return finish("failed");
  }

  let normalizedClaims;
  let gapResult;
  const normalizeEvidence = deps.normalizeEvidence ?? normalizeEvidenceSkill;
  const detectGaps = deps.detectGaps ?? detectGapsSkill;

  try {
    baseResult = await prepareFirstMeeting(inputResult.value.workflow_input, {
      ...deps,
      traceId,
      normalizeEvidence: async (skillInput, skillDeps) => {
        const result = await normalizeEvidence(skillInput, skillDeps);
        normalizedClaims = result?.data?.claims;
        const visibility = visibleClaims(
          skillInput.account_id,
          normalizedClaims,
          classificationCeiling,
        );
        if (visibility.ok) {
          visibleClaimsForGaps = normalizedClaims.filter((claim) =>
            visibility.byId.has(claim.claim_id),
          );
          visibleClaimCount = visibleClaimsForGaps.length;
          withheldClaimIds = visibility.withheldIds;
        }
        return result;
      },
      detectGaps: async (skillInput, skillDeps) => {
        if (!Array.isArray(visibleClaimsForGaps)) {
          throw new Error("Visible evidence could not be scoped for gap detection.");
        }
        const visibleClaimIds = new Set(visibleClaimsForGaps.map((claim) => claim.claim_id));
        const safeConflicts = visibleConflictInputs(
          skillInput.conflicts,
          visibleClaimIds,
          withheldClaimIds,
        );
        const result = await detectGaps({
          ...skillInput,
          claims: visibleClaimsForGaps,
          conflicts: safeConflicts,
        }, skillDeps);
        gapResult = result?.data;
        const conflictIds = [
          ...safeConflicts.flatMap((conflict) => {
            const claimIds = Array.isArray(conflict) ? conflict : conflict?.claim_ids;
            return Array.isArray(claimIds) &&
              claimIds.every((id) => visibleClaimIds.has(id)) &&
              typeof conflict.conflict_id === "string"
              ? [conflict.conflict_id]
              : [];
          }),
          ...(gapResult?.questions ?? []).flatMap((question) => question.conflict_ids ?? []),
        ];
        visibleConflictCount = new Set(conflictIds).size;
        return result;
      },
    });
  } catch {
    errors.push(diagnostic("workflow.input", WORKFLOW_NAME, "WORKFLOW_INTERNAL_ERROR"));
    steps.push(stepSummary("workflow.input", WORKFLOW_NAME, "failed"));
    return finish("failed");
  }

  warnings.push(...baseResult.warnings);
  errors.push(...baseResult.errors);
  steps.push(...visibleBaseSteps(baseResult.steps, visibleClaimCount, visibleConflictCount));

  if (baseResult.status === "failed" || baseResult.status === "blocked") {
    return finish(baseResult.status);
  }
  if (!baseResult.artifact || !baseResult.account ||
      !Array.isArray(normalizedClaims) || !gapResult) {
    steps.push(stepSummary("account-intelligence.validate", WORKFLOW_NAME, "failed"));
    errors.push(diagnostic("account-intelligence.validate", WORKFLOW_NAME, "PROVENANCE_INVARIANT_FAILED"));
    return finish("failed");
  }

  const accountId = baseResult.account.account_id;
  const skillDeps = { now: deps.now, referenceRegistry };
  const signalsRun = await runAccountIntelligenceSkill(
    deps.extractSignals ?? extractSignalsSkill,
    {
      account_id: accountId,
      claims: normalizedClaims,
      annotations: inputResult.value.annotations.signals,
      classification_ceiling: classificationCeiling,
    },
    skillDeps,
  );
  const signals = signalsRun.result;
  steps.push(stepSummary("signal.extract", "signal.extract", signals?.status ?? "failed", signals));
  if (signalsRun.code) {
    addSkillDiagnostics("signal.extract", "signal.extract", signals ?? { errors: [{ code: signalsRun.code }] }, warnings, errors);
    return finish("failed");
  }
  addSkillDiagnostics("signal.extract", "signal.extract", signals, warnings, errors);

  const stakeholdersRun = await runAccountIntelligenceSkill(
    deps.mapStakeholders ?? mapStakeholdersSkill,
    {
      account_id: accountId,
      claims: normalizedClaims,
      annotations: inputResult.value.annotations.stakeholders,
      classification_ceiling: classificationCeiling,
    },
    skillDeps,
  );
  const stakeholders = stakeholdersRun.result;
  steps.push(stepSummary("stakeholder.map", "stakeholder.map", stakeholders?.status ?? "failed", stakeholders));
  if (stakeholdersRun.code) {
    addSkillDiagnostics("stakeholder.map", "stakeholder.map", stakeholders ?? { errors: [{ code: stakeholdersRun.code }] }, warnings, errors);
    return finish("failed");
  }
  addSkillDiagnostics("stakeholder.map", "stakeholder.map", stakeholders, warnings, errors);

  const offeringsRun = await runAccountIntelligenceSkill(
    deps.matchOfferings ?? matchOfferingsSkill,
    {
      account_id: accountId,
      claims: normalizedClaims,
      annotations: inputResult.value.annotations.offerings,
      signals: signals.data,
      classification_ceiling: classificationCeiling,
    },
    skillDeps,
  );
  const offerings = offeringsRun.result;
  steps.push(stepSummary("offering.match", "offering.match", offerings?.status ?? "failed", offerings));
  if (offeringsRun.code) {
    addSkillDiagnostics("offering.match", "offering.match", offerings ?? { errors: [{ code: offeringsRun.code }] }, warnings, errors);
    return finish("failed");
  }
  addSkillDiagnostics("offering.match", "offering.match", offerings, warnings, errors);

  const brief = {
    account: baseResult.account,
    claims: normalizedClaims,
    gap_result: gapResult,
    output_template_id: baseResult.artifact.template_id,
    audience: inputResult.value.workflow_input.audience ?? "internal_sales",
    classification_ceiling: baseResult.artifact.classification,
    signals: signals.data,
    stakeholder_map: stakeholders.data,
    offering_matches: offerings.data,
  };
  const semantic = validateFirstMeetingBriefInputV2(brief, { referenceRegistry });
  steps.push(stepSummary("account-intelligence.validate", WORKFLOW_NAME, semantic.valid ? "success" : "failed"));
  if (!semantic.valid) {
    errors.push(diagnostic("account-intelligence.validate", WORKFLOW_NAME, "V2_BRIEF_INVALID"));
    return finish("failed");
  }

  let rendered;
  try {
    rendered = renderFirstMeetingBriefV2(brief, {
      baseMarkdown: baseResult.artifact.markdown,
      referenceRegistry,
    });
  } catch {
    rendered = { ok: false };
  }
  steps.push(stepSummary("artifact.render-v2", "artifact.render-v2", rendered.ok ? "success" : "failed"));
  if (!rendered.ok) {
    errors.push(diagnostic("artifact.render-v2", "artifact.render-v2", "RENDER_FAILED"));
    return finish("failed");
  }

  const provenance = verifyProvenance({
    claims: normalizedClaims,
    gapResult,
    renderResult: {
      evidence_ids: baseResult.evidence_ids,
      data: {
        rendered_artifact: rendered.markdown,
        classification: baseResult.artifact.classification,
        cited_evidence_ids: baseResult.evidence_ids,
        omitted_evidence_ids: baseResult.omitted_evidence_ids,
      },
    },
    classificationCeiling,
  });
  steps.push(stepSummary("provenance.check-v2", "prepare-first-meeting-v2", provenance.ok ? "success" : "failed"));
  if (!provenance.ok) {
    errors.push(diagnostic("provenance.check-v2", WORKFLOW_NAME, "PROVENANCE_INVARIANT_FAILED"));
    return finish("failed");
  }

  finalArtifact = {
    format: "markdown",
    template_id: baseResult.artifact.template_id,
    classification: baseResult.artifact.classification,
    markdown: rendered.markdown,
  };
  finalEvidenceIds = provenance.cited;
  accountIntelligence = {
    signals: signals.data,
    stakeholder_map: stakeholders.data,
    offering_matches: offerings.data,
    reference_status: {
      signal_taxonomy: safeReferenceStatus(referenceRegistry.signalTaxonomy, "signals"),
      personas: safeReferenceStatus(referenceRegistry.personas, "personas"),
      offerings: safeReferenceStatus(referenceRegistry.offerings, "offerings"),
    },
  };

  const partial =
    baseResult.status === "partial" ||
    (baseResult.omitted_evidence_ids?.length ?? 0) > 0 ||
    [signals, stakeholders, offerings].some((skill) => skill.status === "partial");
  return finish(partial ? "partial" : "success");
}

export default prepareFirstMeetingV2;
