import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { citationsInMarkdown } from "../prepare-first-meeting/provenance.js";
import { visibleClaims } from "../../skills/account-intelligence/common.js";
import { normalizeEvidence as normalizeEvidenceSkill } from "../../skills/evidence-normalize/index.js";
import { retrieveEvidence as retrieveEvidenceSkill } from "../../skills/evidence-retrieve/index.js";
import { draftEngagement as draftEngagementSkill } from "../../skills/engagement/index.js";
import { prepareFirstMeetingV2 } from "../prepare-first-meeting-v2/index.js";

export const WORKFLOW_NAME = "prepare-engagement";
export const WORKFLOW_VERSION = "0.1.0";

function nowIso(deps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

function diagnostic(step, skill, code, message) {
  return { step, skill, code, message, retryable: false };
}

function stepSummary(step, skill, status, warnings = [], errors = []) {
  return {
    step,
    skill,
    status,
    warning_codes: [...new Set(warnings.map((item) => item.code))].sort(),
    error_codes: [...new Set(errors.map((item) => item.code))].sort(),
  };
}

function sameIds(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function validMode(mode) {
  return mode === "initial" || mode === "follow_up" ? mode : null;
}

/**
 * Compose Account Intelligence evidence preparation with a draft-only
 * Engagement skill. Gap status and metadata from the base brief are not copied:
 * draft-facing evidence references are resolved again against visible claims.
 */
export async function prepareEngagement(input, deps = {}) {
  const started = nowIso(deps);
  const traceId = deps.traceId ?? `trace_${randomUUID()}`;
  const warnings = [];
  const errors = [];
  const steps = [];
  const mode = validMode(input?.mode);
  let account = null;
  let artifact = null;
  let engagement = null;
  let evidenceIds = [];

  const finish = (status) => {
    if ((status === "failed" || status === "blocked") && errors.length === 0) {
      errors.push(diagnostic(
        "prepare-engagement",
        WORKFLOW_NAME,
        "WORKFLOW_INTERNAL_ERROR",
        "Engagement stopped without a structured cause.",
      ));
    }
    const result = {
      workflow: WORKFLOW_NAME,
      workflow_version: WORKFLOW_VERSION,
      mode,
      status,
      account,
      artifact,
      engagement,
      evidence_ids: evidenceIds,
      warnings,
      errors,
      steps,
      trace_id: traceId,
      started_at: started,
      finished_at: nowIso(deps),
    };
    const validation = validate("prepareEngagementResult", result);
    if (!validation.valid) {
      throw new Error(`prepare-engagement produced an invalid result: ${JSON.stringify(validation.errors)}`);
    }
    return result;
  };

  const inputValidation = validate("prepareEngagementInput", input);
  if (!inputValidation.valid) {
    steps.push(stepSummary("workflow.input", WORKFLOW_NAME, "failed"));
    errors.push(diagnostic(
      "workflow.input",
      WORKFLOW_NAME,
      "INVALID_INPUT",
      "Workflow input could not be accepted.",
    ));
    return finish("failed");
  }
  const value = input;
  const workflowInput = {
    workflow_input: value.workflow_input,
    annotations: value.annotations ?? {},
  };
  let normalizedClaims;
  let normalizationStatus;
  let retrievalStatus;

  let preparation;
  try {
    preparation = await prepareFirstMeetingV2(workflowInput, {
      ...deps,
      traceId,
      retrieveEvidence: async (skillInput, skillDeps) => {
        const retrieve = deps.retrieveEvidence ?? retrieveEvidenceSkill;
        const result = await retrieve(skillInput, skillDeps);
        retrievalStatus = result?.status;
        return result;
      },
      normalizeEvidence: async (skillInput, skillDeps) => {
        const normalize = deps.normalizeEvidence ?? normalizeEvidenceSkill;
        const result = await normalize(skillInput, skillDeps);
        normalizationStatus = result?.status;
        normalizedClaims = result?.data?.claims;
        return result;
      },
    });
  } catch {
    steps.push(stepSummary("evidence.prepare", "prepare-first-meeting-v2", "failed"));
    errors.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting-v2",
      "WORKFLOW_INTERNAL_ERROR",
      "Evidence preparation could not produce a trustworthy result.",
    ));
    return finish("failed");
  }

  if (preparation.status === "failed" || preparation.status === "blocked") {
    const status = preparation.status;
    steps.push(stepSummary("evidence.prepare", "prepare-first-meeting-v2", status));
    errors.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting-v2",
      status === "blocked" ? "ACCOUNT_RESOLUTION_BLOCKED" : "EVIDENCE_PREPARATION_FAILED",
      status === "blocked"
        ? "Account or evidence preparation requires human resolution."
        : "Account or evidence preparation could not produce a trustworthy result.",
    ));
    return finish(status);
  }

  if (!preparation.account || !preparation.artifact ||
      !preparation.account_intelligence?.stakeholder_map ||
      !Array.isArray(normalizedClaims)) {
    steps.push(stepSummary("evidence.prepare", "prepare-first-meeting-v2", "failed"));
    errors.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting-v2",
      "PROVENANCE_INVARIANT_FAILED",
      "Evidence preparation did not return the required account and normalized evidence.",
    ));
    return finish("failed");
  }
  account = preparation.account;
  const preparationWarnings = [];
  if (retrievalStatus === "partial") {
    preparationWarnings.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting-v2",
      "SOURCE_RETRIEVAL_PARTIAL",
      "Some requested sources could not be fully prepared; review the visible evidence before use.",
    ));
  }
  if (normalizationStatus === "partial") {
    preparationWarnings.push(diagnostic(
      "evidence.prepare",
      "prepare-first-meeting-v2",
      "SOURCE_NORMALIZATION_PARTIAL",
      "Some source records could not be fully normalized; review the visible evidence before use.",
    ));
  }
  warnings.push(...preparationWarnings);
  steps.push(stepSummary(
    "evidence.prepare",
    "prepare-first-meeting-v2",
    preparationWarnings.length > 0 ? "partial" : "success",
    preparationWarnings,
  ));

  const classificationCeiling = value.workflow_input.classification_ceiling ?? "internal";
  const claimCheck = visibleClaims(account.account_id, normalizedClaims, classificationCeiling);
  if (!claimCheck.ok) {
    steps.push(stepSummary("engagement.draft", "engagement.draft", "failed"));
    errors.push(diagnostic(
      "engagement.draft",
      "engagement.draft",
      claimCheck.code,
      claimCheck.message,
    ));
    return finish("failed");
  }

  const skillInput = {
    mode: value.mode,
    account,
    claims: normalizedClaims,
    classification_ceiling: classificationCeiling,
    stakeholder_map: preparation.account_intelligence.stakeholder_map,
    ...(value.outreach_claim_ids !== undefined ? { outreach_claim_ids: value.outreach_claim_ids } : {}),
    ...(value.meeting_claim_ids !== undefined ? { meeting_claim_ids: value.meeting_claim_ids } : {}),
    ...(value.follow_up_claim_ids !== undefined ? { follow_up_claim_ids: value.follow_up_claim_ids } : {}),
    ...(value.recipient_name !== undefined ? { recipient_name: value.recipient_name } : {}),
    ...(value.messaging_guidance !== undefined ? { messaging_guidance: value.messaging_guidance } : {}),
  };

  let skill;
  try {
    const draft = deps.draftEngagement ?? draftEngagementSkill;
    skill = await draft(skillInput, { now: deps.now });
  } catch {
    skill = null;
  }

  if (!skill || !validate("skillResult", skill).valid ||
      skill.skill !== "engagement.draft" ||
      !["success", "partial", "blocked", "failed"].includes(skill.status)) {
    steps.push(stepSummary("engagement.draft", "engagement.draft", "failed"));
    errors.push(diagnostic(
      "engagement.draft",
      "engagement.draft",
      "WORKFLOW_INTERNAL_ERROR",
      "Engagement drafting did not return a usable skill result.",
    ));
    return finish("failed");
  }
  if (skill.status === "failed" || skill.status === "blocked") {
    steps.push(stepSummary("engagement.draft", "engagement.draft", skill.status));
    const code = skill.errors[0]?.code ?? "WORKFLOW_INTERNAL_ERROR";
    errors.push(diagnostic(
      "engagement.draft",
      "engagement.draft",
      code,
      skill.errors[0]?.message ?? "Engagement drafting could not produce a trustworthy result.",
    ));
    return finish(skill.status);
  }
  if (!validate("engagementDraftData", skill.data).valid ||
      typeof skill.data.markdown !== "string" ||
      !sameIds(citationsInMarkdown(skill.data.markdown), skill.evidence_ids)) {
    steps.push(stepSummary("engagement.draft", "engagement.draft", "failed"));
    errors.push(diagnostic(
      "engagement.draft",
      "engagement.draft",
      "PROVENANCE_INVARIANT_FAILED",
      "Engagement draft citations did not match the skill evidence references.",
    ));
    return finish("failed");
  }

  const citations = citationsInMarkdown(skill.data.markdown);
  if (citations.some((id) => !claimCheck.byId.has(id))) {
    steps.push(stepSummary("engagement.draft", "engagement.draft", "failed"));
    errors.push(diagnostic(
      "engagement.draft",
      "engagement.draft",
      "PROVENANCE_INVARIANT_FAILED",
      "An Engagement draft citation was not visible normalized evidence for this account.",
    ));
    return finish("failed");
  }

  engagement = skill.data;
  artifact = {
    format: "markdown",
    template_id: "engagement-draft-v1",
    classification: classificationCeiling,
    markdown: skill.data.markdown,
  };
  evidenceIds = citations;
  for (const warning of skill.warnings) {
    warnings.push(diagnostic(
      "engagement.draft",
      "engagement.draft",
      warning.code,
      warning.message,
    ));
  }
  const status = skill.status === "partial" ||
      retrievalStatus === "partial" ||
      normalizationStatus === "partial"
    ? "partial"
    : "success";
  steps.push(stepSummary(
    "engagement.draft",
    "engagement.draft",
    status,
    warnings.filter((item) => item.step === "engagement.draft"),
  ));
  return finish(status);
}

export default prepareEngagement;
