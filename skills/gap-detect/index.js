import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { validateInput } from "./validate-input.js";
import { evaluateClaims } from "./claims.js";
import { evaluateConflicts } from "./conflicts.js";
import { classifyQuestions } from "./questions.js";

export const SKILL_NAME = "gap.detect";
export const SKILL_VERSION = "0.1.0";

const trace = () => "trace_" + randomUUID();

function envelope({ status, data, startedAt, errors = [], warnings = [], evidenceIds = [] }) {
  const result = {
    skill: SKILL_NAME,
    skill_version: SKILL_VERSION,
    status,
    data,
    evidence_ids: evidenceIds,
    warnings,
    errors,
    trace_id: trace(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  const { valid, errors: schemaErrors } = validate("skillResult", result);
  if (!valid) {
    throw new Error("gap.detect produced an invalid envelope: " + JSON.stringify(schemaErrors));
  }
  return result;
}

function rejectionError(rejection) {
  return {
    code: "INVALID_INPUT",
    message: rejection.message,
    retryable: false,
    details: { reason: rejection.reason, ...rejection.details },
  };
}

function summarize(questionResults) {
  return {
    total: questionResults.length,
    answered: questionResults.filter((question) => question.status === "answered").length,
    partial: questionResults.filter((question) => question.status === "partial").length,
    unanswered: questionResults.filter((question) => question.status === "unanswered").length,
    conflicted: questionResults.filter((question) => question.status === "conflicted").length,
  };
}

export function detectGaps(input, deps = {}) {
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

  const {
    account_id: accountId,
    questions,
    claims: rawClaims,
    conflicts: rawConflicts,
    question_set_version: questionSetVersion,
  } = inputResult.value;

  const questionIds = new Set(questions.map((question) => question.id));
  const claimEvaluation = evaluateClaims(rawClaims, { accountId, questionIds });
  const acceptedIds = new Set(claimEvaluation.accepted.keys());
  const conflictEvaluation = evaluateConflicts(rawConflicts, {
    accepted: claimEvaluation.accepted,
    acceptedIds,
  });

  const questionResults = classifyQuestions(
    questions,
    claimEvaluation.accepted,
    conflictEvaluation.conflicts,
  );
  const summaryCounts = summarize(questionResults);

  const data = {
    account_id: accountId,
    question_set_version: questionSetVersion,
    questions: questionResults,
    summary_counts: summaryCounts,
  };

  const { valid, errors: dataErrors } = validate("gapResult", data);
  if (!valid) {
    throw new Error("gap.detect produced an invalid gap result: " + JSON.stringify(dataErrors));
  }

  const rejections = [...claimEvaluation.rejections, ...conflictEvaluation.rejections];
  const errors = rejections.map(rejectionError);
  const warnings = [];

  if (rejections.length > 0) {
    warnings.push({
      code: "CLAIMS_OR_CONFLICTS_REJECTED",
      message:
        rejections.length + " claim(s) or conflict(s) were rejected; see errors for safe reasons.",
    });
  }
  if (summaryCounts.unanswered > 0 || summaryCounts.partial > 0) {
    warnings.push({
      code: "GAPS_PRESENT",
      message: "Some research questions remain unresolved.",
    });
  }
  if (summaryCounts.conflicted > 0) {
    warnings.push({
      code: "CONFLICTS_PRESENT",
      message: "Conflicting claims require human review.",
    });
  }
  if (conflictEvaluation.derivedCount > 0) {
    warnings.push({
      code: "CONFLICTS_DERIVED",
      message:
        "Some claims marked as conflicting had no conflict reference; derived conflict references were used.",
    });
  }

  const evidenceIds = [
    ...new Set(questionResults.flatMap((question) => question.supporting_evidence_ids)),
  ].sort();

  return envelope({
    status: errors.length > 0 ? "partial" : "success",
    data,
    startedAt,
    errors,
    warnings,
    evidenceIds,
  });
}

export default detectGaps;
