import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { resolveAccount as resolveAccountSkill } from "../../skills/account-resolve/index.js";
import { retrieveEvidence as retrieveEvidenceSkill } from "../../skills/evidence-retrieve/index.js";
import { normalizeEvidence as normalizeEvidenceSkill } from "../../skills/evidence-normalize/index.js";
import { detectGaps as detectGapsSkill } from "../../skills/gap-detect/index.js";
import { renderArtifact as renderArtifactSkill } from "../../skills/artifact-render/index.js";
import { verifyProvenance } from "./provenance.js";
import { validateInput } from "./validate-input.js";

export const WORKFLOW_NAME = "prepare-first-meeting";
export const WORKFLOW_VERSION = "0.1.0";

const STATUSES = new Set(["success", "partial", "blocked", "failed"]);
const STEP_ORDER = Object.freeze([
  "workflow.input",
  "account.resolve",
  "evidence.retrieve",
  "evidence.normalize",
  "gap.detect",
  "artifact.render",
]);
const STEP_RANK = new Map(STEP_ORDER.map((step, index) => [step, index]));

const RENDERER_WARNING_MESSAGES = Object.freeze({
  gaps_present: "Some research questions remain unresolved.",
  conflicts_present: "Conflicting claims require human review.",
  partial_normalization: "Some normalization candidates were rejected.",
  no_claims: "No normalized claims were provided.",
});

function nowIso(deps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

function diagnostic(step, skill, { code, retryable }) {
  return {
    step,
    skill,
    code,
    message: step === "workflow.input"
      ? code === "UNSUPPORTED_SOURCE"
        ? "A requested source is not supported."
        : "Workflow input could not be accepted."
      : `${skill} reported ${code}.`,
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  };
}

function addDiagnostics(step, skill, result, warnings, errors) {
  for (const warning of result.warnings ?? []) {
    warnings.push(diagnostic(step, skill, warning));
  }
  for (const error of result.errors ?? []) {
    errors.push(diagnostic(step, skill, error));
  }
}

function stepSummary(step, skill, result, extra = {}) {
  const summary = {
    step,
    skill,
    status: result.status,
    warning_codes: [...new Set((result.warnings ?? []).map((warning) => warning.code))].sort(),
    error_codes: [...new Set((result.errors ?? []).map((error) => error.code))].sort(),
  };

  if (typeof result.data?.outcome === "string") summary.outcome = result.data.outcome;
  if (typeof result.data?.match?.method === "string") {
    summary.match_method = result.data.match.method;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) summary[key] = value;
  }

  return summary;
}

function compareDiagnostics(a, b) {
  return (
    (STEP_RANK.get(a.step) ?? Number.MAX_SAFE_INTEGER) -
      (STEP_RANK.get(b.step) ?? Number.MAX_SAFE_INTEGER) ||
    a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message) ||
    Number(Boolean(a.retryable)) - Number(Boolean(b.retryable))
  );
}

function dedupeDiagnostics(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const key = [
      value.step,
      value.skill,
      value.code,
      value.message,
      value.retryable === undefined ? "" : String(value.retryable),
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique.sort(compareDiagnostics);
}

function safeCandidate(candidate) {
  if (typeof candidate !== "object" || candidate === null) return null;
  if (typeof candidate.account_id !== "string" || candidate.account_id.trim() === "") return null;
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") return null;

  const safe = { account_id: candidate.account_id, name: candidate.name };
  if (typeof candidate.domain === "string" && candidate.domain !== "") {
    safe.domain = candidate.domain;
  }
  if (typeof candidate.match_type === "string" && candidate.match_type !== "") {
    safe.match_type = candidate.match_type;
  }
  if (typeof candidate.score === "number" && Number.isFinite(candidate.score)) {
    safe.score = candidate.score;
  }
  if (Array.isArray(candidate.matched_tokens)) {
    safe.matched_tokens = candidate.matched_tokens.filter((token) => typeof token === "string");
  }
  return safe;
}

function failedStep(skill) {
  return {
    skill,
    status: "failed",
    data: null,
    evidence_ids: [],
    warnings: [],
    errors: [
      {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: `${skill} did not return a usable result.`,
        retryable: false,
      },
    ],
  };
}

async function runSkill(skill, fn, input, deps) {
  try {
    const result = await fn(input, deps);
    const validDiagnostic = (entry) =>
      typeof entry === "object" && entry !== null &&
      typeof entry.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(entry.code) &&
      (entry.retryable === undefined || typeof entry.retryable === "boolean");
    if (
      typeof result !== "object" ||
      result === null ||
      !STATUSES.has(result.status) ||
      !Array.isArray(result.warnings) ||
      !Array.isArray(result.errors) ||
      !result.warnings.every(validDiagnostic) ||
      !result.errors.every(validDiagnostic)
    ) {
      return failedStep(skill);
    }
    return result;
  } catch {
    return failedStep(skill);
  }
}

function rendererWarnings(normalizeResult, gapResult, claims) {
  const warnings = [];

  if ((normalizeResult.data?.rejected_records ?? []).length > 0) {
    warnings.push({
      code: "partial_normalization",
      message: RENDERER_WARNING_MESSAGES.partial_normalization,
    });
  }
  if ((gapResult.warnings ?? []).some((warning) => warning.code === "GAPS_PRESENT")) {
    warnings.push({
      code: "gaps_present",
      message: RENDERER_WARNING_MESSAGES.gaps_present,
    });
  }
  if ((gapResult.warnings ?? []).some((warning) => warning.code === "CONFLICTS_PRESENT")) {
    warnings.push({
      code: "conflicts_present",
      message: RENDERER_WARNING_MESSAGES.conflicts_present,
    });
  }
  if (claims.length === 0) {
    warnings.push({ code: "no_claims", message: RENDERER_WARNING_MESSAGES.no_claims });
  }

  const byCode = new Map();
  for (const warning of warnings) {
    if (!byCode.has(warning.code)) byCode.set(warning.code, warning);
  }
  return [...byCode.values()];
}

/**
 * Execute the fixed prepare-first-meeting workflow.
 *
 * Dependencies are explicit and small. Fixture adapters and the fixture claim
 * extractor are supplied by the caller. Optional skill-function overrides exist
 * only so tests can observe that later skills are not invoked after a block or
 * failure; production callers normally omit them.
 *
 * @param {object} input workflow-input.schema.json object
 * @param {object} [deps]
 * @param {object} [deps.accountAdapter]
 * @param {object} [deps.evidenceAdapter]
 * @param {object} [deps.claimExtractor]
 * @param {() => Date} [deps.now]
 * @param {string} [deps.traceId]
 * @param {Function} [deps.resolveAccount]
 * @param {Function} [deps.retrieveEvidence]
 * @param {Function} [deps.normalizeEvidence]
 * @param {Function} [deps.detectGaps]
 * @param {Function} [deps.renderArtifact]
 * @returns {Promise<object>} workflow-result.schema.json object
 */
export async function prepareFirstMeeting(input, deps = {}) {
  const startedAt = nowIso(deps);
  const traceId = deps.traceId ?? `trace_${randomUUID()}`;
  const warnings = [];
  const errors = [];
  const steps = [];

  const finish = (status, extra = {}) => {
    if ((status === "failed" || status === "blocked") && errors.length === 0) {
      errors.push(
        diagnostic("workflow.input", WORKFLOW_NAME, {
          code: "WORKFLOW_INTERNAL_ERROR",
          message: `Workflow stopped with status ${status} without a structured cause.`,
          retryable: false,
        }),
      );
    }

    const result = {
      workflow: WORKFLOW_NAME,
      workflow_version: WORKFLOW_VERSION,
      status,
      account: extra.account ?? null,
      account_candidates: extra.accountCandidates ?? [],
      artifact: extra.artifact ?? null,
      evidence_ids: extra.evidenceIds ?? [],
      omitted_evidence_ids: extra.omittedIds ?? [],
      warnings: dedupeDiagnostics(warnings),
      errors: dedupeDiagnostics(errors),
      steps,
      trace_id: traceId,
      started_at: startedAt,
      finished_at: nowIso(deps),
    };

    const { valid, errors: schemaErrors } = validate("workflowResult", result);
    if (!valid) {
      throw new Error(
        `prepare-first-meeting produced an invalid workflow result: ${JSON.stringify(schemaErrors)}`,
      );
    }
    return result;
  };

  const inputResult = validateInput(input);
  if (!inputResult.ok) {
    for (const error of inputResult.errors) {
      errors.push(diagnostic("workflow.input", WORKFLOW_NAME, error));
    }
    return finish("failed");
  }

  const value = inputResult.value;
  const resolveAccount = deps.resolveAccount ?? resolveAccountSkill;
  const retrieveEvidence = deps.retrieveEvidence ?? retrieveEvidenceSkill;
  const normalizeEvidence = deps.normalizeEvidence ?? normalizeEvidenceSkill;
  const detectGaps = deps.detectGaps ?? detectGapsSkill;
  const renderArtifact = deps.renderArtifact ?? renderArtifactSkill;

  const accountResult = await runSkill(
    "account.resolve",
    resolveAccount,
    { account_reference: value.account_reference },
    { adapter: deps.accountAdapter, now: deps.now },
  );
  addDiagnostics("account.resolve", "account.resolve", accountResult, warnings, errors);
  steps.push(
    stepSummary("account.resolve", "account.resolve", accountResult, {
      candidate_count: Array.isArray(accountResult.data?.candidates)
        ? accountResult.data.candidates.length
        : undefined,
    }),
  );

  if (accountResult.status === "failed") return finish("failed");

  if (accountResult.status !== "success" || accountResult.data?.outcome !== "resolved") {
    const candidates = Array.isArray(accountResult.data?.candidates)
      ? accountResult.data.candidates.map(safeCandidate).filter(Boolean)
      : [];
    return finish("blocked", { accountCandidates: candidates });
  }

  const resolved = accountResult.data.account;
  if (
    typeof resolved?.account_id !== "string" ||
    typeof resolved?.name !== "string" ||
    resolved.account_id === "" ||
    resolved.name === ""
  ) {
    errors.push(
      diagnostic("account.resolve", "account.resolve", {
        code: "PROVENANCE_INVARIANT_FAILED",
        message: "Account resolution did not return a canonical account identity.",
        retryable: false,
      }),
    );
    return finish("failed");
  }

  const account = {
    account_id: resolved.account_id,
    canonical_name: resolved.name,
    ...(typeof resolved.domain === "string" && resolved.domain !== ""
      ? { identifiers: { domain: resolved.domain } }
      : {}),
  };

  const retrievalResult = await runSkill(
    "evidence.retrieve",
    retrieveEvidence,
    {
      account_id: account.account_id,
      questions: value.questions.map((question) => ({ id: question.id, text: question.text })),
      requested_sources: value.requested_sources,
      context: value.context,
    },
    { adapter: deps.evidenceAdapter, now: deps.now },
  );
  addDiagnostics("evidence.retrieve", "evidence.retrieve", retrievalResult, warnings, errors);
  steps.push(
    stepSummary("evidence.retrieve", "evidence.retrieve", retrievalResult, {
      record_count: Array.isArray(retrievalResult.data?.records)
        ? retrievalResult.data.records.length
        : undefined,
      source_count: value.requested_sources.length,
    }),
  );

  if (retrievalResult.status === "failed") return finish("failed", { account });
  if (retrievalResult.status === "blocked") return finish("blocked", { account });
  if (
    retrievalResult.status !== "success" &&
    retrievalResult.status !== "partial"
  ) {
    errors.push(
      diagnostic("evidence.retrieve", "evidence.retrieve", {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: "Evidence retrieval returned an unusable status.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }
  if (!Array.isArray(retrievalResult.data?.records)) {
    errors.push(
      diagnostic("evidence.retrieve", "evidence.retrieve", {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: "Evidence retrieval returned no usable record list.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }

  const recordsForAccount = retrievalResult.data.records.filter(
    (record) => record?.account_id === account.account_id,
  );

  const normalizationResult = await runSkill(
    "evidence.normalize",
    normalizeEvidence,
    { account_id: account.account_id, records: recordsForAccount },
    { extractor: deps.claimExtractor, now: deps.now },
  );
  addDiagnostics(
    "evidence.normalize",
    "evidence.normalize",
    normalizationResult,
    warnings,
    errors,
  );
  steps.push(
    stepSummary("evidence.normalize", "evidence.normalize", normalizationResult, {
      source_record_count: recordsForAccount.length,
      claim_count: Array.isArray(normalizationResult.data?.claims)
        ? normalizationResult.data.claims.length
        : undefined,
      rejected_count: Array.isArray(normalizationResult.data?.rejected_records)
        ? normalizationResult.data.rejected_records.length
        : undefined,
      conflict_count: Array.isArray(normalizationResult.data?.conflicts)
        ? normalizationResult.data.conflicts.length
        : undefined,
    }),
  );

  if (normalizationResult.status === "failed" || normalizationResult.status === "blocked") {
    return finish(normalizationResult.status, { account });
  }
  if (
    normalizationResult.status !== "success" &&
    normalizationResult.status !== "partial"
  ) {
    errors.push(
      diagnostic("evidence.normalize", "evidence.normalize", {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: "Evidence normalization returned an unusable status.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }
  if (!Array.isArray(normalizationResult.data?.claims)) {
    errors.push(
      diagnostic("evidence.normalize", "evidence.normalize", {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: "Evidence normalization returned no usable claim list.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }

  const claims = normalizationResult.data.claims;
  const conflicts = Array.isArray(normalizationResult.data.conflicts)
    ? normalizationResult.data.conflicts
    : [];

  const gapResult = await runSkill(
    "gap.detect",
    detectGaps,
    {
      account_id: account.account_id,
      questions: value.questions.map((question) => ({ id: question.id, text: question.text })),
      claims,
      conflicts,
    },
    { now: deps.now },
  );
  addDiagnostics("gap.detect", "gap.detect", gapResult, warnings, errors);

  const gapCounts = gapResult.data?.summary_counts;
  steps.push(
    stepSummary("gap.detect", "gap.detect", gapResult, {
      total_questions:
        typeof gapCounts?.total === "number" ? gapCounts.total : undefined,
      answered_count:
        typeof gapCounts?.answered === "number" ? gapCounts.answered : undefined,
      partial_count:
        typeof gapCounts?.partial === "number" ? gapCounts.partial : undefined,
      unanswered_count:
        typeof gapCounts?.unanswered === "number" ? gapCounts.unanswered : undefined,
      conflicted_count:
        typeof gapCounts?.conflicted === "number" ? gapCounts.conflicted : undefined,
    }),
  );

  if (gapResult.status === "failed" || gapResult.status === "blocked") {
    return finish(gapResult.status, { account });
  }
  if (gapResult.status !== "success" && gapResult.status !== "partial") {
    errors.push(
      diagnostic("gap.detect", "gap.detect", {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: "Gap detection returned an unusable status.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }

  const gapValidation = validate("gapResult", gapResult.data);
  if (!gapValidation.valid) {
    errors.push(
      diagnostic("gap.detect", "gap.detect", {
        code: "PROVENANCE_INVARIANT_FAILED",
        message: "Gap detection did not return a schema-valid gap result.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }

  const rendered = await runSkill(
    "artifact.render",
    renderArtifact,
    {
      account,
      claims,
      gap_result: gapResult.data,
      warnings: rendererWarnings(normalizationResult, gapResult, claims),
      output_template_id: value.template_id,
      audience: value.audience,
      classification_ceiling: value.classification_ceiling,
    },
    { now: deps.now },
  );
  addDiagnostics("artifact.render", "artifact.render", rendered, warnings, errors);
  steps.push(
    stepSummary("artifact.render", "artifact.render", rendered, {
      template_id:
        typeof rendered.data?.template_id === "string"
          ? rendered.data.template_id
          : value.template_id,
      cited_count: Array.isArray(rendered.data?.cited_evidence_ids)
        ? rendered.data.cited_evidence_ids.length
        : undefined,
      omitted_count: Array.isArray(rendered.data?.omitted_evidence_ids)
        ? rendered.data.omitted_evidence_ids.length
        : undefined,
    }),
  );

  if (rendered.status === "failed" || rendered.status === "blocked") {
    return finish(rendered.status, { account });
  }
  if (rendered.status !== "success" && rendered.status !== "partial") {
    errors.push(
      diagnostic("artifact.render", "artifact.render", {
        code: "WORKFLOW_INTERNAL_ERROR",
        message: "Artifact rendering returned an unusable status.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }

  const verification = verifyProvenance({
    claims,
    gapResult: gapResult.data,
    renderResult: rendered,
    classificationCeiling: value.classification_ceiling,
  });

  if (!verification.ok) {
    errors.push(
      diagnostic("artifact.render", "artifact.render", {
        code: "PROVENANCE_INVARIANT_FAILED",
        message: "Workflow provenance verification failed; no artifact was returned.",
        retryable: false,
      }),
    );
    return finish("failed", { account });
  }

  const artifact = {
    format: "markdown",
    template_id:
      typeof rendered.data.template_id === "string"
        ? rendered.data.template_id
        : value.template_id,
    classification:
      typeof rendered.data.classification === "string"
        ? rendered.data.classification
        : value.classification_ceiling,
    markdown: rendered.data.rendered_artifact,
  };

  const earlierStepPartial = steps.some(
    (step) => step.step !== "artifact.render" && step.status === "partial",
  );
  const status =
    earlierStepPartial || verification.omitted.length > 0 ? "partial" : "success";

  return finish(status, {
    account,
    artifact,
    evidenceIds: verification.cited,
    omittedIds: verification.omitted,
  });
}

export default prepareFirstMeeting;
