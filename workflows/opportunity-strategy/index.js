import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { normalizeEvidence as normalizeEvidenceSkill } from "../../skills/evidence-normalize/index.js";
import { assessOpportunityStrategy } from "../../skills/opportunity-strategy/index.js";
import { renderOpportunityStrategy } from "../../skills/opportunity-strategy/render.js";
import { assessQualification } from "../../skills/qualification-assess/index.js";
import { citationsInMarkdown } from "../prepare-first-meeting/provenance.js";
import { prepareFirstMeeting } from "../prepare-first-meeting/index.js";
import { validateInput } from "./validate-input.js";

export const WORKFLOW_NAME = "opportunity-strategy";
export const WORKFLOW_VERSION = "0.1.0";
export const ARTIFACT_TEMPLATE_ID = "opportunity-strategy-v1";

function nowIso(deps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

function diagnostic(step, skill, code, message) {
  return { step, skill, code, message, retryable: false };
}

function step(stepId, skill, status) {
  return { step: stepId, skill, status };
}

export async function runOpportunityStrategy(input, deps = {}) {
  const started = nowIso(deps);
  const traceId = deps.traceId ?? `trace_${randomUUID()}`;
  const warnings = [];
  const errors = [];
  const steps = [];
  let account = null;
  let strategy = null;
  let artifact = null;
  let evidenceIds = [];

  const finish = (status) => {
    if (["failed", "blocked"].includes(status) && errors.length === 0) {
      errors.push(diagnostic(
        "workflow.input",
        WORKFLOW_NAME,
        "WORKFLOW_INTERNAL_ERROR",
        "The workflow stopped without a structured result.",
      ));
    }
    const result = {
      workflow: WORKFLOW_NAME,
      workflow_version: WORKFLOW_VERSION,
      status,
      account,
      strategy,
      artifact,
      evidence_ids: evidenceIds,
      warnings,
      errors,
      steps,
      trace_id: traceId,
      started_at: started,
      finished_at: nowIso(deps),
    };
    const validation = validate("opportunityStrategyWorkflowResult", result);
    if (!validation.valid) {
      throw new Error(`opportunity-strategy produced invalid workflow data: ${JSON.stringify(validation.errors)}`);
    }
    return result;
  };

  const inputResult = validateInput(input);
  if (!inputResult.ok) {
    steps.push(step("workflow.input", WORKFLOW_NAME, "failed"));
    errors.push(diagnostic("workflow.input", WORKFLOW_NAME, inputResult.code, inputResult.message));
    return finish("failed");
  }

  const classificationCeiling =
    inputResult.value.workflow_input.classification_ceiling ?? "internal";
  let normalizedClaims = null;
  let normalizedConflicts = null;
  const normalizeEvidence = deps.normalizeEvidence ?? normalizeEvidenceSkill;

  let evidenceResult;
  try {
    evidenceResult = await prepareFirstMeeting(inputResult.value.workflow_input, {
      ...deps,
      traceId,
      normalizeEvidence: async (skillInput, skillDeps) => {
        const result = await normalizeEvidence(skillInput, skillDeps);
        normalizedClaims = result?.data?.claims;
        normalizedConflicts = result?.data?.conflicts;
        return result;
      },
    });
  } catch {
    steps.push(step("evidence.prepare", "prepare-first-meeting", "failed"));
    errors.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting",
      "WORKFLOW_INTERNAL_ERROR",
      "Evidence preparation failed; no opportunity-strategy artifact was produced.",
    ));
    return finish("failed");
  }

  account = evidenceResult.account;
  if (evidenceResult.status === "blocked" || evidenceResult.status === "failed") {
    steps.push(step("evidence.prepare", "prepare-first-meeting", evidenceResult.status));
    const blocked = evidenceResult.status === "blocked";
    errors.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting",
      blocked ? "EVIDENCE_PREPARATION_BLOCKED" : "EVIDENCE_PREPARATION_FAILED",
      blocked
        ? "Account or evidence preparation requires human resolution; no strategy artifact was produced."
        : "Account or evidence preparation failed; no strategy artifact was produced.",
    ));
    return finish(blocked ? "blocked" : "failed");
  }
  if (
    !["success", "partial"].includes(evidenceResult.status) ||
    !account ||
    !Array.isArray(normalizedClaims) ||
    !Array.isArray(normalizedConflicts)
  ) {
    steps.push(step("evidence.prepare", "prepare-first-meeting", "failed"));
    errors.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting",
      "PROVENANCE_INVARIANT_FAILED",
      "Evidence preparation returned no usable normalized claims; no strategy artifact was produced.",
    ));
    return finish("failed");
  }
  steps.push(step("evidence.prepare", "prepare-first-meeting", evidenceResult.status));

  let qualificationResult;
  try {
    qualificationResult = assessQualification({
      account_id: account.account_id,
      claims: normalizedClaims,
      conflicts: normalizedConflicts,
      classification_ceiling: classificationCeiling,
      ...(inputResult.value.qualification.criteria_set
        ? { criteria_set: inputResult.value.qualification.criteria_set }
        : {}),
      ...(inputResult.value.qualification.event_evidence
        ? { event_evidence: inputResult.value.qualification.event_evidence }
        : {}),
    }, { now: deps.now });
  } catch {
    steps.push(step("qualification.assess", "qualification.assess", "failed"));
    errors.push(diagnostic(
      "qualification.assess",
      "qualification.assess",
      "WORKFLOW_INTERNAL_ERROR",
      "Qualification evidence assessment failed; no artifact was produced.",
    ));
    return finish("failed");
  }
  if (!["success", "partial"].includes(qualificationResult.status)) {
    steps.push(step("qualification.assess", "qualification.assess", "failed"));
    const error = qualificationResult.errors[0];
    errors.push(diagnostic(
      "qualification.assess",
      "qualification.assess",
      error?.code ?? "QUALIFICATION_RESULT_INVALID",
      error?.message ?? "Qualification evidence assessment failed; no artifact was produced.",
    ));
    return finish("failed");
  }
  steps.push(step("qualification.assess", "qualification.assess", qualificationResult.status));

  let assessment;
  try {
    assessment = assessOpportunityStrategy({
      account_id: account.account_id,
      claims: normalizedClaims,
      classification_ceiling: classificationCeiling,
      qualification_result: qualificationResult,
      offering_annotations: inputResult.value.offering_annotations,
    }, {
      now: deps.now,
      referenceRegistry: deps.referenceRegistry,
    });
  } catch {
    steps.push(step("opportunity.strategy", "opportunity.strategy", "failed"));
    errors.push(diagnostic(
      "opportunity.strategy",
      "opportunity.strategy",
      "WORKFLOW_INTERNAL_ERROR",
      "Opportunity strategy analysis failed; no artifact was produced.",
    ));
    return finish("failed");
  }

  if (!["success", "partial"].includes(assessment.status)) {
    steps.push(step("opportunity.strategy", "opportunity.strategy", "failed"));
    const error = assessment.errors[0];
    errors.push(diagnostic(
      "opportunity.strategy",
      "opportunity.strategy",
      error?.code ?? "STRATEGY_ANALYSIS_FAILED",
      error?.message ?? "Opportunity strategy analysis failed; no artifact was produced.",
    ));
    return finish("failed");
  }
  strategy = assessment.data;
  steps.push(step("opportunity.strategy", "opportunity.strategy", assessment.status));
  for (const warning of assessment.warnings) {
    warnings.push(diagnostic(
      "opportunity.strategy",
      "opportunity.strategy",
      warning.code,
      warning.message,
    ));
  }

  let rendered;
  try {
    rendered = renderOpportunityStrategy(account, strategy);
  } catch {
    rendered = { ok: false };
  }
  if (!rendered.ok) {
    steps.push(step("artifact.render", "opportunity-strategy-renderer", "failed"));
    errors.push(diagnostic(
      "artifact.render",
      "opportunity-strategy-renderer",
      "RENDER_FAILED",
      "The strategy artifact could not be rendered.",
    ));
    strategy = null;
    return finish("failed");
  }
  steps.push(step("artifact.render", "opportunity-strategy-renderer", "success"));

  const cited = citationsInMarkdown(rendered.markdown);
  const expected = [...new Set(rendered.citedEvidenceIds)].sort();
  if (
    JSON.stringify(cited) !== JSON.stringify(expected) ||
    cited.some((id) => !assessment.evidence_ids.includes(id))
  ) {
    steps.push(step("provenance.check", WORKFLOW_NAME, "failed"));
    errors.push(diagnostic(
      "provenance.check",
      WORKFLOW_NAME,
      "PROVENANCE_INVARIANT_FAILED",
      "The rendered artifact citations did not match the strategy evidence.",
    ));
    strategy = null;
    return finish("failed");
  }
  steps.push(step("provenance.check", WORKFLOW_NAME, "success"));

  artifact = {
    format: "markdown",
    template_id: ARTIFACT_TEMPLATE_ID,
    classification: classificationCeiling,
    markdown: rendered.markdown,
  };
  evidenceIds = cited;
  const status =
    assessment.status === "partial" || evidenceResult.status === "partial"
      ? "partial"
      : "success";
  return finish(status);
}

export default runOpportunityStrategy;
