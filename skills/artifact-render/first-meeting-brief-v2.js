import { validateFirstMeetingBriefInputV2 } from "../../schemas/index.js";
import { referenceEntries } from "../account-intelligence/common.js";
import { citationsInMarkdown } from "../../workflows/prepare-first-meeting/provenance.js";

function escapeMarkdown(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()#+!|>])/g, "\\$1");
}

function citations(ids) {
  return ids.map((id) => `[\`${id}\`]`).join(", ");
}

function statusLabel(status) {
  if (status === "approved") return "approved reference vocabulary";
  if (status === "provisional") return "provisional reference vocabulary";
  return "reference approval status unknown";
}

function renderSignals(brief, referenceRegistry) {
  const signals = brief.signals.signals;
  const taxonomy = referenceEntries(referenceRegistry?.signalTaxonomy, "signals");
  if (signals.length === 0) {
    return "No caller-provided signal mappings; no event or compelling-event judgment was inferred.";
  }
  return signals.map((signal) => {
    const category = taxonomy.entries.get(signal.signal_type_id);
    const claimIds = citations(signal.claim_ids);
    const conflict = signal.claim_ids.some((id) =>
      brief.claims.find((claim) => claim.claim_id === id)?.verification_status === "conflicting",
    );
    return `- **${escapeMarkdown(category.label)}** — caller-mapped using ${claimIds}; ${statusLabel(referenceRegistry.signalTaxonomy.status)}.${conflict ? " Conflicting evidence is retained for review." : ""}`;
  }).join("\n");
}

function renderStakeholders(brief, referenceRegistry) {
  const stakeholders = brief.stakeholder_map.stakeholders;
  const personas = referenceEntries(referenceRegistry?.personas, "personas");
  if (stakeholders.length === 0) {
    return "No caller-provided stakeholder mappings; stakeholder coverage remains unknown and no authority is inferred.";
  }
  const mapped = stakeholders.map((stakeholder) => {
    const persona = personas.entries.get(stakeholder.persona_id);
    const conflict = stakeholder.claim_ids.some((id) =>
      brief.claims.find((claim) => claim.claim_id === id)?.verification_status === "conflicting",
    );
    return `- **${escapeMarkdown(stakeholder.display_name)}** — caller-mapped persona hypothesis: ${escapeMarkdown(persona.label)}. Role evidence: “${escapeMarkdown(stakeholder.role_evidence)}”. Titles do not imply budget authority or decision rights. Evidence: ${citations(stakeholder.claim_ids)}.${conflict ? " Conflicting evidence is retained for review." : ""}`;
  }).join("\n");
  return [
    "Coverage is limited to caller-provided mappings; other roles and decision authority remain unknown.",
    mapped,
  ].join("\n");
}

function renderOfferings(brief, referenceRegistry) {
  const matches = brief.offering_matches.matches;
  const offerings = referenceEntries(referenceRegistry?.offerings, "offerings");
  if (matches.length === 0) {
    return "No caller-provided offering mappings; no fit recommendation was generated.";
  }
  return matches.map((match) => {
    const offering = offerings.entries.get(match.offering_id);
    const conflict = match.claim_ids.some((id) =>
      brief.claims.find((claim) => claim.claim_id === id)?.verification_status === "conflicting",
    );
    const questions = match.discovery_questions.map((question) => `  - ${escapeMarkdown(question)}`).join("\n");
    const uncertainties = match.uncertainties.map((uncertainty) => `  - ${escapeMarkdown(uncertainty)}`).join("\n");
    return [
      `### ${escapeMarkdown(offering.label)}`,
      `Candidate hypothesis only — ${statusLabel(referenceRegistry.offerings.status)}. ${escapeMarkdown(match.rationale)}`,
      `Evidence: ${citations(match.claim_ids)}.`,
      "Uncertainties:",
      uncertainties,
      "Discovery:",
      questions,
      conflict ? "Conflicting evidence is retained for human review; no winner was selected." : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

/**
 * Append evidence-linked Account Intelligence sections after semantic validation.
 *
 * @returns {{ok: true, markdown: string, citedEvidenceIds: string[]} | {ok: false}}
 */
export function renderFirstMeetingBriefV2(brief, { baseMarkdown, referenceRegistry } = {}) {
  const validation = validateFirstMeetingBriefInputV2(brief, { referenceRegistry });
  if (!validation.valid || typeof baseMarkdown !== "string" || baseMarkdown.trim() === "") {
    return { ok: false };
  }
  if (
    (brief.signals.signals.length > 0 && !referenceEntries(referenceRegistry?.signalTaxonomy, "signals").ok) ||
    (brief.stakeholder_map.stakeholders.length > 0 && !referenceEntries(referenceRegistry?.personas, "personas").ok) ||
    (brief.offering_matches.matches.length > 0 && !referenceEntries(referenceRegistry?.offerings, "offerings").ok)
  ) {
    return { ok: false };
  }

  const markdown = [
    baseMarkdown.trimEnd(),
    "",
    "---",
    "",
    "## Account Intelligence",
    "",
    "### Signals",
    renderSignals(brief, referenceRegistry),
    "",
    "### Stakeholders",
    renderStakeholders(brief, referenceRegistry),
    "",
    "### Offering hypotheses",
    renderOfferings(brief, referenceRegistry),
  ].join("\n");

  return { ok: true, markdown, citedEvidenceIds: citationsInMarkdown(markdown) };
}
