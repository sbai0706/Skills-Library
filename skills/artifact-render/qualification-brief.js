const FIELD_LABELS = Object.freeze({
  event: "Event",
  deadline: "Deadline",
  consequence: "Consequence",
  accountable_owner: "Accountable owner",
  relevantz_service_need: "Relevantz service need",
  next_customer_decision: "Next customer decision",
});

function safeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}\[\]()#+.!|])/g, "\\$1");
}

function renderEvidence(evidence) {
  if (evidence.length === 0) return "_No visible evidence is mapped._";
  return evidence.map((item) =>
    `> ${safeText(item.excerpt)} [${item.claim_id}]`,
  ).join("\n");
}

function renderCriteria(criteriaSet) {
  if (criteriaSet.assessments.length === 0) {
    return "No criteria definition was supplied. No B-FITT dimensions or criteria are inferred.";
  }
  const lines = [
    `Caller-supplied criteria set: ${criteriaSet.version ?? "unversioned"} (${criteriaSet.status}).`,
    "Evidence states are references only; no criterion is marked satisfied or failed.",
  ];
  for (const criterion of criteriaSet.assessments) {
    lines.push(
      "",
      `### ${safeText(criterion.label)} (${safeText(criterion.id)})`,
      `Definition: ${safeText(criterion.definition)}`,
      `Evidence state: **${criterion.evidence_state}**`,
      renderEvidence(criterion.evidence),
    );
  }
  return lines.join("\n");
}

function renderEvent(eventAssessment) {
  const lines = [
    `Event verification status: **${eventAssessment.status}**. Evidence-field completeness does not verify a compelling event, urgency, or causality.`,
  ];
  for (const [field, assessment] of Object.entries(eventAssessment.fields)) {
    lines.push(
      "",
      `### ${FIELD_LABELS[field]}`,
      `Evidence state: **${assessment.evidence_state}**`,
      renderEvidence(assessment.evidence),
    );
  }
  return lines.join("\n");
}

export function renderQualificationBrief(account, assessment) {
  const questions = assessment.discovery_questions.map((item) =>
    `- ${safeText(item.question)}`,
  );
  const markdown = [
    `# Qualification evidence brief - ${safeText(account.canonical_name)}`,
    "",
    "> Advisory evidence inventory only. This brief does not qualify an account, verify a compelling event, recommend a stage, create an opportunity, or change a CRM record.",
    "",
    "## Qualification criteria",
    "",
    renderCriteria(assessment.criteria_set),
    "",
    "## Compelling-event evidence assessment",
    "",
    renderEvent(assessment.event_assessment),
    "",
    "## Qualification decision",
    "",
    `**${assessment.qualification_decision}**`,
    "",
    "## Stage readiness",
    "",
    `**${assessment.stage_readiness.status}** - ${assessment.stage_readiness.reason}.`,
    "",
    "## Discovery questions",
    "",
    ...questions,
    "",
  ].join("\n");
  const evidenceIds = [
    ...new Set([
      ...assessment.criteria_set.assessments.flatMap((criterion) =>
        criterion.evidence.map((item) => item.claim_id)),
      ...Object.values(assessment.event_assessment.fields).flatMap((field) =>
        field.evidence.map((item) => item.claim_id)),
    ]),
  ].sort();
  return { markdown, evidenceIds };
}
