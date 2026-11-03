import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { resolveAccount as resolveAccountSkill } from "../../skills/account-resolve/index.js";
import { renderQualificationBrief } from "../../skills/artifact-render/qualification-brief.js";
import { normalizeEvidence as normalizeEvidenceSkill } from "../../skills/evidence-normalize/index.js";
import { retrieveEvidence as retrieveEvidenceSkill } from "../../skills/evidence-retrieve/index.js";
import { assessQualification } from "../../skills/qualification-assess/index.js";
import { validateInput as validateFirstMeetingInput } from "../prepare-first-meeting/validate-input.js";

export const WORKFLOW_NAME = "qualification";
export const WORKFLOW_VERSION = "0.1.0";

function nowIso(deps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

function diagnostic(step, skill, code, message) {
  return { step, skill, code, message, retryable: false };
}

function stepSummary(step, skill, status) {
  return { step, skill, status };
}

async function runSkill(fn, input, deps) {
  try {
    const result = await fn(input, deps);
    return validate("skillResult", result).valid ? result : null;
  } catch {
    return null;
  }
}

/**
 * Compose shared account resolution, evidence retrieval, and normalization
 * with an explicit qualification evidence assessment. No gap result or v1
 * first-meeting artifact is used to derive this assessment.
 */
export async function runQualification(input, deps = {}) {
  const started = nowIso(deps);
  const traceId = deps.traceId ?? `trace_${randomUUID()}`;
  const steps = [];
  const warnings = [];
  const errors = [];
  let account = null;
  let assessment = null;
  let artifact = null;
  let evidenceIds = [];

  const finish = (status) => {
    const result = {
      workflow: WORKFLOW_NAME,
      workflow_version: WORKFLOW_VERSION,
      status,
      account,
      assessment,
      artifact,
      evidence_ids: evidenceIds,
      warnings,
      errors,
      steps,
      trace_id: traceId,
      started_at: started,
      finished_at: nowIso(deps),
    };
    const validation = validate("qualificationWorkflowResult", result);
    if (!validation.valid) {
      throw new Error(`qualification workflow produced an invalid result: ${JSON.stringify(validation.errors)}`);
    }
    return result;
  };

  const stop = (status, step, skill, code, message) => {
    steps.push(stepSummary(step, skill, status));
    errors.push(diagnostic(step, skill, code, message));
    return finish(status);
  };

  if (!validate("qualificationWorkflowInput", input).valid) {
    return stop(
      "failed",
      "workflow.input",
      WORKFLOW_NAME,
      "INVALID_INPUT",
      "Qualification workflow input could not be accepted.",
    );
  }

  const workflowValidation = validateFirstMeetingInput(input.workflow_input);
  if (!workflowValidation.ok) {
    return stop(
      "failed",
      "workflow.input",
      WORKFLOW_NAME,
      "INVALID_INPUT",
      "Qualification workflow input could not be accepted.",
    );
  }

  const resolved = await runSkill(
    deps.resolveAccount ?? resolveAccountSkill,
    { account_reference: workflowValidation.value.account_reference },
    { adapter: deps.accountAdapter, now: deps.now },
  );
  if (!resolved) {
    return stop(
      "failed",
      "account.resolve",
      "account.resolve",
      "WORKFLOW_INTERNAL_ERROR",
      "Account resolution did not return a usable result.",
    );
  }
  if (resolved.status !== "success" || resolved.data?.outcome !== "resolved") {
    return stop(
      resolved.status === "failed" ? "failed" : "blocked",
      "account.resolve",
      "account.resolve",
      resolved.status === "failed" ? "ACCOUNT_RESOLUTION_FAILED" : "ACCOUNT_RESOLUTION_REQUIRED",
      resolved.status === "failed"
        ? "Account resolution failed; qualification evidence was not assessed."
        : "Account resolution must be completed before qualification evidence can be assessed.",
    );
  }

  const resolvedAccount = resolved.data.account;
  if (typeof resolvedAccount?.account_id !== "string" ||
      typeof resolvedAccount?.name !== "string" ||
      resolvedAccount.account_id === "" || resolvedAccount.name === "") {
    return stop(
      "failed",
      "account.resolve",
      "account.resolve",
      "WORKFLOW_INTERNAL_ERROR",
      "Account resolution did not return a canonical account identity.",
    );
  }
  account = {
    account_id: resolvedAccount.account_id,
    canonical_name: resolvedAccount.name,
    ...(typeof resolvedAccount.domain === "string" && resolvedAccount.domain !== ""
      ? { identifiers: { domain: resolvedAccount.domain } }
      : {}),
  };
  steps.push(stepSummary("account.resolve", "account.resolve", "success"));

  const retrieved = await runSkill(
    deps.retrieveEvidence ?? retrieveEvidenceSkill,
    {
      account_id: account.account_id,
      questions: workflowValidation.value.questions.map((question) => ({
        id: question.id,
        text: question.text,
      })),
      requested_sources: workflowValidation.value.requested_sources,
      context: workflowValidation.value.context,
    },
    { adapter: deps.evidenceAdapter, now: deps.now },
  );
  if (!retrieved || !["success", "partial"].includes(retrieved.status) ||
      !Array.isArray(retrieved.data?.records)) {
    const blocked = retrieved?.status === "blocked";
    return stop(
      blocked ? "blocked" : "failed",
      "evidence.retrieve",
      "evidence.retrieve",
      blocked ? "EVIDENCE_RETRIEVAL_BLOCKED" : "EVIDENCE_RETRIEVAL_FAILED",
      blocked
        ? "Evidence retrieval was blocked; qualification evidence was not assessed."
        : "Evidence retrieval did not return a usable record list.",
    );
  }

  const records = retrieved.data.records.filter((record) =>
    record?.account_id === account.account_id);
  const normalized = await runSkill(
    deps.normalizeEvidence ?? normalizeEvidenceSkill,
    { account_id: account.account_id, records },
    { extractor: deps.claimExtractor, now: deps.now },
  );
  if (!normalized || !["success", "partial"].includes(normalized.status) ||
      normalized.data?.account_id !== account.account_id ||
      !Array.isArray(normalized.data?.claims) ||
      !Array.isArray(normalized.data?.conflicts)) {
    return stop(
      "failed",
      "evidence.normalize",
      "evidence.normalize",
      "EVIDENCE_NORMALIZATION_FAILED",
      "Normalized qualification evidence was unavailable.",
    );
  }
  steps.push(stepSummary("evidence.acquire", "evidence.normalize", "success"));

  const ceiling = workflowValidation.value.classification_ceiling;
  const skillResult = await runSkill(
    assessQualification,
    {
      account_id: account.account_id,
      claims: normalized.data.claims,
      conflicts: normalized.data.conflicts,
      classification_ceiling: ceiling,
      ...(input.criteria_set ? { criteria_set: input.criteria_set } : {}),
      ...(input.event_evidence ? { event_evidence: input.event_evidence } : {}),
    },
    { now: deps.now },
  );
  if (!skillResult || !validate("qualificationAssessment", skillResult.data).valid ||
      !["success", "partial"].includes(skillResult.status)) {
    const code = skillResult?.errors?.[0]?.code ?? "WORKFLOW_INTERNAL_ERROR";
    return stop(
      "failed",
      "qualification.assess",
      "qualification.assess",
      code,
      "Qualification evidence assessment could not be completed.",
    );
  }

  assessment = skillResult.data;
  for (const warning of skillResult.warnings) {
    warnings.push(diagnostic(
      "qualification.assess",
      "qualification.assess",
      warning.code,
      warning.message,
    ));
  }
  steps.push(stepSummary("qualification.assess", "qualification.assess", skillResult.status));

  let rendered;
  try {
    rendered = renderQualificationBrief(account, assessment);
  } catch {
    return stop(
      "failed",
      "artifact.render",
      "artifact.render",
      "RENDER_FAILED",
      "Qualification brief could not be rendered.",
    );
  }
  if (JSON.stringify(rendered.evidenceIds) !== JSON.stringify(skillResult.evidence_ids)) {
    return stop(
      "failed",
      "artifact.render",
      "artifact.render",
      "PROVENANCE_INVARIANT_FAILED",
      "Qualification brief citations did not match the assessed evidence.",
    );
  }

  artifact = {
    format: "markdown",
    template_id: "qualification-evidence-v1",
    classification: ceiling,
    markdown: rendered.markdown,
  };
  evidenceIds = rendered.evidenceIds;
  steps.push(stepSummary("artifact.render", "artifact.render", "success"));

  return finish(skillResult.status);
}

export default runQualification;
