import {
  categoryForQuestion,
  compareQuestionIds,
  questionText,
} from "./reference.js";

const CLAIM_SECTIONS = Object.freeze([
  { id: "company_context", title: "Known company context" },
  { id: "recent_developments", title: "Recent developments or initiatives" },
  { id: "prior_relationship", title: "Existing relationship or prior activity" },
  { id: "stakeholders", title: "Known stakeholders" },
  { id: "service_alignment", title: "Possible service alignment" },
]);

const AUDIENCE_LABELS = Object.freeze({
  internal_sales: "Internal sales",
  executive: "Executive",
  customer: "Customer",
});

const WARNING_MESSAGES = Object.freeze({
  gaps_present: "Some research questions remain unresolved.",
  conflicts_present: "Conflicting claims require human review.",
  claims_withheld: "Some claims were withheld by the classification ceiling.",
  partial_normalization: "Some normalization candidates were rejected.",
  no_claims: "No normalized claims were provided.",
});

const WARNING_ORDER = Object.freeze([
  "gaps_present",
  "conflicts_present",
  "claims_withheld",
  "partial_normalization",
  "no_claims",
]);

const WARNING_RANK = new Map(WARNING_ORDER.map((code, index) => [code, index]));

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function citation(claimId) {
  return `\`[${claimId}]\``;
}

function claimBullet(claim) {
  return `- ${oneLine(claim.claim)} ${citation(claim.claim_id)}`;
}

function sortClaims(claims) {
  return [...claims].sort((a, b) => a.claim_id.localeCompare(b.claim_id));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function tableCell(value) {
  return oneLine(value).replace(/\|/g, "\\|") || "—";
}

function compareWarnings(a, b) {
  const left = WARNING_RANK.get(a.code) ?? Number.MAX_SAFE_INTEGER;
  const right = WARNING_RANK.get(b.code) ?? Number.MAX_SAFE_INTEGER;
  return left - right || a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
}

function buildWarnings(inputWarnings, { questionResults, omittedEvidenceIds, claimCount }) {
  const warnings = new Map();

  const add = (code, message) => {
    if (!warnings.has(code)) warnings.set(code, { code, message });
  };

  for (const warning of inputWarnings ?? []) {
    add(warning.code, warning.message ?? WARNING_MESSAGES[warning.code]);
  }

  if (questionResults.some((question) => question.status !== "answered")) {
    add("gaps_present", WARNING_MESSAGES.gaps_present);
  }
  if (questionResults.some((question) => question.status === "conflicted")) {
    add("conflicts_present", WARNING_MESSAGES.conflicts_present);
  }
  if (omittedEvidenceIds.length > 0) {
    add("claims_withheld", WARNING_MESSAGES.claims_withheld);
  }
  if (claimCount === 0) {
    add("no_claims", WARNING_MESSAGES.no_claims);
  }

  return [...warnings.values()].sort(compareWarnings);
}

function buildQuestionResults(gapQuestions, claimById, omittedIds) {
  const byId = new Map();
  for (const question of gapQuestions) {
    if (!byId.has(question.question_id)) byId.set(question.question_id, question);
  }

  return [...byId.values()]
    .sort((a, b) => compareQuestionIds(a.question_id, b.question_id))
    .map((question) => {
      const originalSupport = uniqueSorted(question.supporting_evidence_ids ?? []);
      const permittedSupport = originalSupport.filter((id) => claimById.has(id));
      const omittedSupport = originalSupport.filter((id) => omittedIds.has(id));

      let status = question.status;
      let unavailableBasis = null;

      if (
        (question.status === "answered" || question.status === "partial") &&
        originalSupport.length > 0 &&
        permittedSupport.length === 0
      ) {
        status = "unavailable";
        unavailableBasis = omittedSupport.length > 0 ? "classification" : "missing";
      } else if (
        question.status === "answered" &&
        permittedSupport.length > 0 &&
        omittedSupport.length > 0 &&
        permittedSupport.length < originalSupport.length
      ) {
        status = "partial";
      }

      return {
        questionId: question.question_id,
        status,
        unavailableBasis,
        permittedSupport,
        omittedSupport,
        conflictIds: uniqueSorted(question.conflict_ids ?? []),
      };
    });
}

function groupClaims(questionResults, claimById, permittedClaims) {
  const categoryClaims = new Map(CLAIM_SECTIONS.map((section) => [section.id, []]));
  const placedInCategory = new Set();

  for (const question of questionResults) {
    if (question.status !== "answered" && question.status !== "partial") continue;
    const category = categoryForQuestion(question.questionId);
    if (!categoryClaims.has(category)) continue;

    const bucket = categoryClaims.get(category);
    for (const id of question.permittedSupport) {
      if (placedInCategory.has(id)) continue;
      placedInCategory.add(id);
      bucket.push(claimById.get(id));
    }
  }

  for (const bucket of categoryClaims.values()) {
    bucket.sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  }

  const conflictResults = questionResults.filter((question) => question.status === "conflicted");
  const placedInConflicts = new Set(
    conflictResults.flatMap((question) => question.permittedSupport),
  );

  const placed = new Set([...placedInCategory, ...placedInConflicts]);
  const additional = sortClaims(permittedClaims.filter((claim) => !placed.has(claim.claim_id)));

  return { categoryClaims, conflictResults, additional };
}

function renderAccount(lines, input) {
  const { account, audience, classification_ceiling: ceiling } = input;

  lines.push("## Account", "");
  lines.push("| Field | Value |", "| --- | --- |");
  lines.push(`| Account ID | \`${tableCell(account.account_id)}\` |`);
  lines.push(`| Canonical name | ${tableCell(account.canonical_name)} |`);
  if (account.identifiers?.domain) {
    lines.push(`| Domain | ${tableCell(account.identifiers.domain)} |`);
  }
  lines.push(`| Audience | ${tableCell(AUDIENCE_LABELS[audience] ?? audience)} |`);
  lines.push(`| Output classification | ${tableCell(ceiling)} |`);
  lines.push("");
}

function renderClaimSections(lines, categoryClaims) {
  for (const section of CLAIM_SECTIONS) {
    lines.push(`## ${section.title}`, "");

    if (section.id === "service_alignment") {
      lines.push("Possible alignment is a hypothesis, not a confirmed customer need.", "");
    }

    const claims = categoryClaims.get(section.id);
    if (claims.length === 0) {
      lines.push("No permitted evidence was retrieved for the questions in this section.", "");
      continue;
    }

    for (const claim of claims) lines.push(claimBullet(claim));
    lines.push("");
  }
}

function renderAdditionalEvidence(lines, additional) {
  if (additional.length === 0) return;

  lines.push("## Additional permitted evidence", "");
  lines.push(
    "The following permitted evidence is not mapped to a research question in the supplied gap result.",
    "",
  );
  for (const claim of additional) lines.push(claimBullet(claim));
  lines.push("");
}

function renderGaps(lines, questionResults) {
  lines.push("## Open questions and evidence gaps", "");

  const openQuestions = questionResults.filter((question) =>
    ["partial", "unanswered", "unavailable"].includes(question.status),
  );

  if (openQuestions.length === 0) {
    lines.push("No open questions or evidence gaps were supplied.", "");
    return;
  }

  for (const question of openQuestions) {
    lines.push(`**${question.questionId}** — ${oneLine(questionText(question.questionId))}`, "");

    if (question.status === "unanswered") {
      lines.push("No permitted evidence was retrieved for this question.", "");
    } else if (question.status === "partial") {
      lines.push("Available evidence addresses part of this question.", "");
    } else if (question.unavailableBasis === "classification") {
      lines.push("Evidence is unavailable at the current classification level.", "");
    } else {
      lines.push("Required evidence is not available in the rendered input.", "");
    }
  }
}

function renderConflicts(lines, warnings, conflictResults, claimById) {
  lines.push("## Conflicts and cautions", "");

  if (warnings.length > 0) {
    lines.push("**Warnings**", "");
    for (const warning of warnings) lines.push(oneLine(warning.message), "");
  }

  if (conflictResults.length === 0) {
    lines.push("No conflicts were supplied.", "");
    return;
  }

  lines.push("**Conflicts requiring human review**", "");

  for (const question of conflictResults) {
    lines.push(`**${question.questionId}** — ${oneLine(questionText(question.questionId))}`, "");

    if (question.conflictIds.length > 0) {
      const references = question.conflictIds.map((id) => `\`${id}\``).join(", ");
      lines.push(`Conflict reference: ${references}`, "");
    }

    lines.push("Conflicting evidence requires human review.", "");

    const claims = sortClaims(
      question.permittedSupport.map((id) => claimById.get(id)),
    );

    if (claims.length === 0) {
      lines.push(
        question.omittedSupport.length > 0
          ? "Supporting statements are not available at the current classification level."
          : "No permitted supporting statements were provided for this conflict.",
        "",
      );
      continue;
    }

    for (const claim of claims) lines.push(claimBullet(claim));
    lines.push("");
  }
}

function formatTimestamp(claim) {
  if (claim.published_at && claim.occurred_at) {
    return `Published ${claim.published_at}; occurred ${claim.occurred_at}`;
  }
  if (claim.published_at) return `Published ${claim.published_at}`;
  if (claim.occurred_at) return `Occurred ${claim.occurred_at}`;
  return "Not provided";
}

function renderEvidenceReferences(lines, citedEvidenceIds, claimById) {
  lines.push("## Evidence references", "");

  if (citedEvidenceIds.length === 0) {
    lines.push("No evidence was cited.", "");
    return;
  }

  lines.push(
    "| Evidence ID | Source type | Source reference | Record ID | Timestamp | Classification |",
    "| --- | --- | --- | --- | --- | --- |",
  );

  for (const id of citedEvidenceIds) {
    const claim = claimById.get(id);
    lines.push(
      `| \`${id}\` | ${tableCell(claim.source_type)} | ${tableCell(claim.source_uri ?? "Not provided")} | ${tableCell(claim.source_record_id ?? "Not provided")} | ${tableCell(formatTimestamp(claim))} | ${tableCell(claim.access_classification)} |`,
    );
  }

  lines.push("");
}

/**
 * Render the only MVP template. Input has already been ceiling-filtered and
 * validated by the skill entry point; this function performs no retrieval,
 * inference, conflict resolution, or identity change.
 */
export function renderFirstMeetingBrief(input, context = {}) {
  const omittedEvidenceIds = uniqueSorted(context.omittedEvidenceIds ?? []);
  const omittedIds = new Set(omittedEvidenceIds);
  const permittedClaims = sortClaims(input.claims);
  const claimById = new Map(permittedClaims.map((claim) => [claim.claim_id, claim]));

  const questionResults = buildQuestionResults(
    input.gap_result.questions,
    claimById,
    omittedIds,
  );
  const { categoryClaims, conflictResults, additional } = groupClaims(
    questionResults,
    claimById,
    permittedClaims,
  );

  const warnings = buildWarnings(input.warnings ?? [], {
    questionResults,
    omittedEvidenceIds,
    claimCount: context.inputClaimCount ?? input.claims.length,
  });

  const renderedIds = new Set();
  for (const claims of categoryClaims.values()) {
    for (const claim of claims) renderedIds.add(claim.claim_id);
  }
  for (const question of conflictResults) {
    for (const id of question.permittedSupport) renderedIds.add(id);
  }
  for (const claim of additional) renderedIds.add(claim.claim_id);

  const citedEvidenceIds = uniqueSorted(renderedIds);

  const lines = [];
  lines.push(`# First-meeting brief — ${oneLine(input.account.canonical_name)}`, "");
  renderAccount(lines, input);
  renderClaimSections(lines, categoryClaims);
  renderAdditionalEvidence(lines, additional);
  renderGaps(lines, questionResults);
  renderConflicts(lines, warnings, conflictResults, claimById);
  renderEvidenceReferences(lines, citedEvidenceIds, claimById);

  const hasOpenQuestions = questionResults.some((question) => question.status !== "answered");
  const status =
    hasOpenQuestions ||
    conflictResults.length > 0 ||
    omittedEvidenceIds.length > 0 ||
    warnings.length > 0
      ? "partial"
      : "success";

  return {
    markdown: lines.join("\n").trimEnd() + "\n",
    status,
    citedEvidenceIds,
    omittedEvidenceIds,
    warnings,
    questionResults,
  };
}
