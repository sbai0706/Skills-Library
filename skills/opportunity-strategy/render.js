import { validate } from "../../schemas/index.js";

function escapeMarkdown(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+!|])/g, "\\$1");
}

function citations(ids) {
  return ids.map((id) => `\`[${id}]\``).join(", ");
}

function renderEvidence(field) {
  if (field.evidence.length === 0) return "- No visible normalized evidence was supplied.";
  return field.evidence
    .map((item) =>
      `- “${escapeMarkdown(item.excerpt)}” ${citations([item.claim_id])}`,
    )
    .join("\n");
}

export function renderOpportunityStrategy(account, strategy) {
  if (
    !account ||
    typeof account.account_id !== "string" ||
    typeof account.canonical_name !== "string" ||
    !validate("opportunityStrategyResult", strategy).valid
  ) {
    return { ok: false };
  }

  const fieldEvidence = Object.values(strategy.event_assessment.fields)
    .flatMap((field) => field.evidence);
  const evidenceById = new Map(fieldEvidence.map((item) => [item.claim_id, item]));
  if (strategy.customer_problem_hypothesis.evidence_ids.some((id) => !evidenceById.has(id))) {
    return { ok: false };
  }

  const lines = [
    `# Opportunity strategy hypothesis — ${escapeMarkdown(account.canonical_name)}`,
    "",
    "> Advisory only. This artifact does not verify a compelling event, assert urgency or authority, recommend a stage change, or create an opportunity.",
    "",
    "## Customer problem hypothesis",
    "",
    escapeMarkdown(strategy.customer_problem_hypothesis.statement),
    "",
    "Evidence:",
    ...renderEvidence({
      evidence: strategy.customer_problem_hypothesis.evidence_ids.map((id) => evidenceById.get(id)),
    }).split("\n"),
    "",
    "## Compelling-event evidence",
    "",
    "Status: unverified. A linked excerpt is not proof of an event, deadline, urgency, or accountable decision owner.",
    "",
  ];
  if (Object.values(strategy.event_assessment.fields).some(
    (field) => field.evidence_state === "conflicting",
  )) {
    lines.push("Conflicting evidence is retained for review; no winner is selected.", "");
  }

  for (const [fieldId, field] of Object.entries(strategy.event_assessment.fields)) {
    lines.push(
      `### ${escapeMarkdown(fieldId.replaceAll("_", " "))} — ${escapeMarkdown(field.evidence_state)}`,
      "",
      ...renderEvidence(field).split("\n"),
      "",
    );
  }

  lines.push("## Offering candidates", "");
  if (strategy.offering_candidates.length === 0) {
    lines.push("No caller-provided offering mappings were supplied; no offering fit was inferred.", "");
  } else {
    for (const candidate of strategy.offering_candidates) {
      lines.push(
        `### ${escapeMarkdown(candidate.label)}`,
        "",
        `Candidate hypothesis only — ${escapeMarkdown(candidate.catalogue_status)} catalogue. ${escapeMarkdown(candidate.rationale)}`,
        "",
        candidate.fit_basis === "caller_mapping_overlaps_problem_evidence"
          ? `The caller's mapping reuses references that also support the problem hypothesis; this overlap does not establish fit. Evidence: ${citations(candidate.claim_ids)}.`
          : `The caller's mapping does not overlap the problem-hypothesis evidence. Evidence: ${citations(candidate.claim_ids)}.`,
        "",
        "Uncertainties:",
        ...candidate.uncertainties.map((item) => `- ${escapeMarkdown(item)}`),
        "",
        "Discovery:",
        ...candidate.discovery_questions.map((item) => `- ${escapeMarkdown(item)}`),
        "",
      );
    }
  }

  lines.push("## Tentative value hypotheses", "");
  if (strategy.value_hypotheses.length === 0) {
    lines.push("No value hypothesis is asserted because a caller-mapped offering is not linked to the visible problem evidence.", "");
  } else {
    for (const hypothesis of strategy.value_hypotheses) {
      const candidate = strategy.offering_candidates.find(
        (item) => item.offering_id === hypothesis.offering_id,
      );
      lines.push(
        `- **${escapeMarkdown(candidate?.label ?? hypothesis.offering_id)}** — ${escapeMarkdown(hypothesis.statement)} Evidence: ${citations(hypothesis.claim_ids)}.`,
      );
    }
    lines.push("");
  }

  lines.push("## Discovery questions", "");
  for (const item of strategy.discovery_questions) {
    const refs = item.evidence_ids.length > 0 ? ` Evidence: ${citations(item.evidence_ids)}.` : "";
    lines.push(`- **${escapeMarkdown(item.id.replaceAll("_", " "))}** (${escapeMarkdown(item.evidence_state)}): ${escapeMarkdown(item.question)}${refs}`);
  }
  lines.push("", "## Proposed next actions", "");
  for (const action of strategy.proposed_next_actions) {
    const basis = action.provenance.evidence_ids.length > 0
      ? ` Evidence: ${citations(action.provenance.evidence_ids)}.`
      : ` Basis: ${escapeMarkdown(action.provenance.kind.replaceAll("_", " "))}.`;
    lines.push(`- ${escapeMarkdown(action.text)}${basis}`);
  }
  lines.push(
    "",
    "## Stage readiness",
    "",
    "Unavailable: no approved stage rules are supplied. Opportunity creation, conversion, and CRM writes are not performed.",
    "",
    "## Offering catalogue status",
    "",
    `Version: ${escapeMarkdown(strategy.offering_catalogue.version ?? "unknown")} · Status: ${escapeMarkdown(strategy.offering_catalogue.status)}.`,
    "",
  );

  const markdown = lines.join("\n").trimEnd() + "\n";
  const evidenceIds = new Set();
  const addIds = (ids) => ids.forEach((id) => evidenceIds.add(id));
  addIds(strategy.customer_problem_hypothesis.evidence_ids);
  for (const field of Object.values(strategy.event_assessment.fields)) {
    addIds(field.evidence.map((item) => item.claim_id));
  }
  for (const candidate of strategy.offering_candidates) addIds(candidate.evidence_ids);
  for (const question of strategy.discovery_questions) addIds(question.evidence_ids);
  for (const action of strategy.proposed_next_actions) {
    addIds(action.provenance.evidence_ids);
  }

  return { ok: true, markdown, citedEvidenceIds: [...evidenceIds].sort() };
}

export default renderOpportunityStrategy;
