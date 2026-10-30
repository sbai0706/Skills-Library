import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { renderTemplate } from "./templates.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "artifact.render";
export const SKILL_VERSION = "0.1.0";
export const ARTIFACT_FORMAT = "markdown";

function envelope({ status, data, startedAt, errors = [], warnings = [], evidenceIds = [] }) {
  const result = {
    skill: SKILL_NAME,
    skill_version: SKILL_VERSION,
    status,
    data,
    evidence_ids: evidenceIds,
    warnings,
    errors,
    trace_id: `trace_${randomUUID()}`,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };

  const { valid, errors: schemaErrors } = validate("skillResult", result);
  if (!valid) {
    throw new Error(`artifact.render produced an invalid envelope: ${JSON.stringify(schemaErrors)}`);
  }

  return result;
}

function toEnvelopeWarnings(warnings) {
  return warnings.map((warning) => ({
    code: warning.code.toUpperCase(),
    message: warning.message,
  }));
}

/**
 * Render a validated structured first-meeting brief.
 *
 * @param {object} input first-meeting-brief-input.schema.json object
 * @param {{now?: () => Date}} [deps]
 * @returns {Promise<object>} skill result envelope
 */
export async function renderArtifact(input, deps = {}) {
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const inputResult = validateInput(input);

  if (!inputResult.ok) {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: inputResult.errors,
    });
  }

  const templateResult = renderTemplate(
    inputResult.value.output_template_id,
    inputResult.value,
    {
      omittedEvidenceIds: inputResult.omittedEvidenceIds,
      inputClaimCount: inputResult.inputClaimCount,
    },
  );

  if (!templateResult.ok) {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: [templateResult.error],
    });
  }

  const rendered = templateResult.value;
  const data = {
    account_id: inputResult.value.account.account_id,
    template_id: inputResult.value.output_template_id,
    audience: inputResult.value.audience,
    classification: inputResult.value.classification_ceiling,
    artifact_format: ARTIFACT_FORMAT,
    rendered_artifact: rendered.markdown,
    cited_evidence_ids: rendered.citedEvidenceIds,
    omitted_evidence_ids: rendered.omittedEvidenceIds,
    warnings: rendered.warnings,
  };

  return envelope({
    status: rendered.status,
    data,
    startedAt,
    warnings: toEnvelopeWarnings(rendered.warnings),
    evidenceIds: rendered.citedEvidenceIds,
  });
}

export default renderArtifact;
