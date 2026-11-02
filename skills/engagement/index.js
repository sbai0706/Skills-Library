import { citationsInMarkdown } from "../../workflows/prepare-first-meeting/provenance.js";
import { validate } from "../../schemas/index.js";
import {
  failedSkill,
  resolveClaimIds,
  skillResult,
  startedAt,
  visibleClaims,
} from "../account-intelligence/common.js";

export const SKILL_NAME = "engagement.draft";
export const SKILL_VERSION = "0.1.0";

const DEFAULT_GUIDANCE = Object.freeze({
  template_id: "engagement-default",
  version: "0.1.0",
  approval_status: "provisional",
  tone: "neutral",
});

const TONE_COPY = Object.freeze({
  neutral: {
    subject: "A question for your team",
    ask: "Would you be open to a short conversation to compare perspectives and decide whether any next discussion would be useful?",
  },
  concise: {
    subject: "Question for your team",
    ask: "Would a short introductory conversation be useful?",
  },
  formal: {
    subject: "Request for a conversation",
    ask: "Would you be available for a brief discussion to determine whether there is a relevant topic to explore?",
  },
  warm: {
    subject: "A conversation, if useful",
    ask: "Would you be open to a short conversation about what would be useful to your team?",
  },
});

function safeMessage(code) {
  return ({
    INVALID_INPUT: "Engagement input could not be accepted.",
    ACCOUNT_SCOPE_MISMATCH: "Engagement evidence must belong to the requested account.",
    EVIDENCE_REFERENCE_UNAVAILABLE: "A requested evidence reference is unavailable in this account and classification scope.",
    UNSUPPORTED_MAPPING: "A requested mapping or evidence source could not be used.",
    STAKEHOLDER_REFERENCE_UNAVAILABLE: "The requested recipient is not uniquely identified by a supplied stakeholder mapping.",
    FOLLOW_UP_EVIDENCE_REQUIRED: "Follow-up drafting requires at least one supplied evidence reference.",
  })[code] ?? "Engagement drafting could not produce a trustworthy result.";
}

function fail(started, code) {
  return failedSkill(SKILL_NAME, started, code, safeMessage(code));
}

function blocked(started, code) {
  return skillResult({
    skill: SKILL_NAME,
    status: "blocked",
    data: null,
    started,
    errors: [{ code, message: safeMessage(code), retryable: false }],
  });
}

function markdownEscape(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()#+!|>])/g, "\\$1");
}

function cite(ids) {
  return [...new Set(ids)].sort().map((id) => `\`[${id}]\``).join(", ");
}

function resolveVisibleIds(ids, claimIndex, withheldIds) {
  const result = resolveClaimIds(ids, claimIndex, withheldIds);
  if (!result.ok && [
    "CLASSIFICATION_RESTRICTED",
    "EVIDENCE_REFERENCE_UNAVAILABLE",
  ].includes(result.code)) {
    return { ...result, code: "EVIDENCE_REFERENCE_UNAVAILABLE" };
  }
  return result;
}

function resolvedStakeholders(stakeholderMap, accountId, claimIndex, withheldIds) {
  if (stakeholderMap === undefined) return { ok: true, stakeholders: [] };
  if (!validate("stakeholderMap", stakeholderMap).valid) {
    return { ok: false, code: "INVALID_INPUT" };
  }
  if (stakeholderMap.account_id !== accountId) {
    return { ok: false, code: "ACCOUNT_SCOPE_MISMATCH" };
  }

  const stakeholders = [];
  for (const stakeholder of stakeholderMap.stakeholders) {
    const claims = resolveVisibleIds(stakeholder.claim_ids, claimIndex, withheldIds);
    const evidence = resolveVisibleIds(stakeholder.evidence_ids, claimIndex, withheldIds);
    if (!claims.ok) return claims;
    if (!evidence.ok) return evidence;
    if (JSON.stringify(claims.ids) !== JSON.stringify(evidence.ids)) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    stakeholders.push({
      name_hypothesis: stakeholder.display_name,
      role_hypothesis: stakeholder.role_evidence,
      claim_ids: claims.ids,
    });
  }
  return { ok: true, stakeholders };
}

function evidenceNotes(claims) {
  return claims.map((claim) => ({
    claim: claim.claim,
    claim_ids: [claim.claim_id],
    verification_status: claim.verification_status,
  }));
}

function initialDraft(value, visible, outreachClaims, meetingClaims, stakeholders) {
  const tone = TONE_COPY[value.messaging_guidance.tone];
  const citedOutreachClaims = outreachClaims.filter((claim) => claim.verification_status !== "conflicting");
  const greeting = "Hello,";
  const factLine = citedOutreachClaims.length > 0
    ? `The supplied evidence records ${citedOutreachClaims.map((claim) =>
      `“${markdownEscape(claim.claim)}” ${cite([claim.claim_id])}`,
    ).join("; ")}. Is any of this still current, and would a conversation about it be useful?`
    : "Would a short introductory conversation be useful? Add an account-specific reference only after checking it against visible evidence.";
  const outreachBody = `${greeting}\n\n${factLine}\n\n${tone.ask}\n\nRegards,\n[Sender name]`;

  const agenda = [
    "Ask what would make this conversation useful to the participant.",
    "Confirm which supplied account context, if any, is current and relevant.",
    "Ask what next discussion, if any, would be useful; do not presume an owner, date, or commitment.",
  ];
  const discoveryQuestions = meetingClaims.length > 0
    ? meetingClaims.map((claim) => ({
      question: claim.verification_status === "conflicting"
        ? `The supplied evidence records “${markdownEscape(claim.claim)}”. Is this statement current, or should it be corrected?`
        : `Is the supplied information “${markdownEscape(claim.claim)}” current and relevant to this discussion?`,
      claim_ids: [claim.claim_id],
    }))
    : [{
      question: "What account-specific topic, if any, would be most useful to discuss?",
      claim_ids: [],
    }];

  const stakeholderTalkingPoints = stakeholders.map((stakeholder) => ({
    name_hypothesis: stakeholder.name_hypothesis,
    role_hypothesis: stakeholder.role_hypothesis,
    claim_ids: [...new Set(stakeholder.claim_ids)].sort(),
    prompt: "Please verify this caller-supplied name and role hypothesis against the cited source notes; no person-role relationship or decision authority is established.",
  }));

  const notes = evidenceNotes([...new Map(
    [
      ...outreachClaims,
      ...meetingClaims,
      ...stakeholders.flatMap((stakeholder) => stakeholder.claim_ids.map((id) => visible.byId.get(id))),
    ].map((claim) => [claim.claim_id, claim]),
  ).values()]);
  const data = {
    mode: "initial",
    draft_only: true,
    messaging_guidance: value.messaging_guidance,
    outreach_draft: {
      subject: tone.subject,
      body: outreachBody,
      claim_ids: [...new Set(citedOutreachClaims.map((claim) => claim.claim_id))].sort(),
    },
    meeting_prep: {
      agenda,
      discovery_questions: discoveryQuestions,
      stakeholder_talking_points: stakeholderTalkingPoints,
      evidence_notes: notes,
    },
    follow_up_draft: null,
    next_actions: [],
    warnings: [],
  };
  if (notes.some((item) => item.verification_status === "conflicting")) {
    data.warnings.push({
      code: "VISIBLE_EVIDENCE_CONFLICT",
      message: "Visible conflicting evidence is retained for review; no version was selected.",
    });
  }
  if (citedOutreachClaims.length === 0) {
    data.warnings.push({
      code: "NO_OUTREACH_CONTEXT",
      message: "No non-conflicting outreach evidence was selected; the message remains generic.",
    });
  }
  if (meetingClaims.length === 0) {
    data.warnings.push({
      code: "NO_MEETING_CONTEXT",
      message: "No meeting context was selected; discovery remains open-ended.",
    });
  }
  if (stakeholders.length === 0) {
    data.warnings.push({
      code: "NO_STAKEHOLDER_MAPPING",
      message: "No caller-supplied stakeholder hypothesis was provided.",
    });
  }
  if (visible.byId.size === 0) {
    data.warnings.push({
      code: "NO_VISIBLE_EVIDENCE",
      message: "No visible account evidence was available; account-specific assertions were not added.",
    });
  }
  return data;
}

function followUpDraft(value, claims) {
  const notes = evidenceNotes(claims);
  const ids = claims.map((claim) => claim.claim_id);
  const conflict = claims.some((claim) => claim.verification_status === "conflicting");
  const lines = claims.map((claim) => `- ${markdownEscape(claim.claim)} ${cite([claim.claim_id])}`).join("\n");
  const clarification = conflict
    ? "\n\nThe supplied notes include conflicting statements. Please clarify whether any, all, or none are current; this draft selects no version."
    : "";
  const body = [
    "Hello,",
    "",
    "Here is the supplied information for your review:",
    lines,
    clarification,
    "",
    "Could you confirm whether this information is accurate and advise whether any next step should be considered?",
    "",
    "Regards,",
    "[Sender name]",
    "",
    "No owner, date, agreement, or commitment is inferred by this draft.",
  ].filter((line) => line !== "").join("\n");
  const data = {
    mode: "follow_up",
    draft_only: true,
    messaging_guidance: value.messaging_guidance,
    outreach_draft: null,
    meeting_prep: null,
    follow_up_draft: { body, claim_ids: ids },
    next_actions: [
      {
        action: "Ask whether the cited information is accurate as supplied.",
        claim_ids: ids,
      },
      {
        action: "Ask whether any next step, owner, or timing should be recorded; leave each open until confirmed.",
        claim_ids: ids,
      },
    ],
    warnings: [],
  };
  if (conflict) {
    data.warnings.push({
      code: "VISIBLE_EVIDENCE_CONFLICT",
      message: "Visible conflicting evidence is retained for review; no version was selected.",
    });
  }
  data.evidence_notes = notes;
  return data;
}

function renderMarkdown(data) {
  const approvalLabel = {
    provisional: "provisional",
    unverified: "unverified",
    caller_reported_approved: "caller-reported approved; approval was not verified by this skill",
  }[data.messaging_guidance.approval_status];
  const sections = [
    `# Engagement draft — ${data.mode === "initial" ? "initial outreach and meeting preparation" : "follow-up"}`,
    "",
    "**Draft only:** for human review; no communication was sent.",
    `**Messaging guidance:** ${markdownEscape(data.messaging_guidance.template_id)} v${markdownEscape(data.messaging_guidance.version)} — ${approvalLabel}; tone: ${data.messaging_guidance.tone}.`,
  ];

  if (data.outreach_draft) {
    sections.push(
      "",
      "## Initial outreach draft",
      "",
      `**Subject:** ${markdownEscape(data.outreach_draft.subject)}`,
      "",
      data.outreach_draft.body,
    );
    if (data.meeting_prep.evidence_notes.some((note) => note.verification_status === "conflicting")) {
      sections.push("", "**Hold for review:** visible evidence conflicts; do not use a conflicting detail in outreach until a person resolves it.");
    }
    sections.push("", "## Meeting preparation", "", "### Agenda", "",
      ...data.meeting_prep.agenda.map((item) => `- ${item}`),
      "", "### Discovery questions", "",
      ...data.meeting_prep.discovery_questions.map((item) =>
        `- ${item.question}${item.claim_ids.length > 0 ? ` ${cite(item.claim_ids)}` : ""}`,
      ),
      "", "### Stakeholder-specific talking points", "",
      ...(data.meeting_prep.stakeholder_talking_points.length > 0
        ? data.meeting_prep.stakeholder_talking_points.map((item) =>
          `- **Unverified caller-supplied mapping hypothesis:** name “${markdownEscape(item.name_hypothesis)}”; role “${markdownEscape(item.role_hypothesis)}”. ${item.prompt} Source notes: ${cite(item.claim_ids)}.`,
        )
        : ["No caller-supplied name/role hypothesis was provided; no target person or authority is inferred."]),
    );
    if (data.meeting_prep.evidence_notes.length > 0) {
      sections.push("", "### Evidence notes", "");
      for (const note of data.meeting_prep.evidence_notes) {
        const label = note.verification_status === "conflicting"
          ? "Visible conflict — verify; no version selected"
          : "Recorded context";
        sections.push(`- **${label}:** ${markdownEscape(note.claim)} ${cite(note.claim_ids)}`);
      }
    }
  }

  if (data.follow_up_draft) {
    sections.push("", "## Follow-up draft", "", data.follow_up_draft.body, "", "## Proposed next actions", "");
    sections.push(...data.next_actions.map((item) => `- ${item.action} ${cite(item.claim_ids)}`));
    if (data.evidence_notes.some((note) => note.verification_status === "conflicting")) {
      sections.push("", "### Evidence requiring review", "");
      for (const note of data.evidence_notes.filter((item) => item.verification_status === "conflicting")) {
        sections.push(`- Conflicting note: ${markdownEscape(note.claim)} ${cite(note.claim_ids)}`);
      }
    }
  }
  return sections.join("\n");
}

function withGuidance(value) {
  const supplied = value.messaging_guidance ?? {};
  const approvalStatus = supplied.approval_status ?? DEFAULT_GUIDANCE.approval_status;
  return {
    template_id: supplied.template_id ?? DEFAULT_GUIDANCE.template_id,
    version: supplied.version ?? DEFAULT_GUIDANCE.version,
    approval_status: approvalStatus === "approved" ? "caller_reported_approved" : approvalStatus,
    approval_reference_provided: typeof supplied.approval_reference === "string" &&
      supplied.approval_reference.trim() !== "",
    tone: supplied.tone ?? DEFAULT_GUIDANCE.tone,
  };
}

/**
 * Draft initial outreach/meeting preparation or source-neutral follow-up from
 * normalized evidence. This skill never sends messages or mutates a CRM.
 */
export function draftEngagement(input, deps = {}) {
  const started = startedAt(deps);
  if (!validate("engagementDraftInput", input).valid) {
    return fail(started, "INVALID_INPUT");
  }

  const value = {
    ...input,
    messaging_guidance: withGuidance(input),
  };
  const visible = visibleClaims(
    value.account.account_id,
    value.claims,
    value.classification_ceiling,
  );
  if (!visible.ok) return fail(started, visible.code);

  const stakeholderResult = resolvedStakeholders(
    value.stakeholder_map,
    value.account.account_id,
    visible.byId,
    visible.withheldIds,
  );
  if (!stakeholderResult.ok) return fail(started, stakeholderResult.code);

  if (value.recipient_name !== undefined) {
    const matches = stakeholderResult.stakeholders.filter(
      (stakeholder) => stakeholder.name_hypothesis === value.recipient_name,
    );
    if (matches.length !== 1) return fail(started, "STAKEHOLDER_REFERENCE_UNAVAILABLE");
  }

  const selectedIds = {
    outreach: value.outreach_claim_ids ?? [],
    meeting: value.meeting_claim_ids ?? [],
    followUp: value.follow_up_claim_ids ?? [],
  };
  const resolved = {};
  for (const [key, ids] of Object.entries(selectedIds)) {
    if (ids.length === 0) {
      resolved[key] = [];
      continue;
    }
    const references = resolveVisibleIds(ids, visible.byId, visible.withheldIds);
    if (!references.ok) return fail(started, references.code);
    resolved[key] = references.ids.map((id) => visible.byId.get(id));
  }

  if (value.mode === "follow_up" && resolved.followUp.length === 0) {
    return blocked(started, "FOLLOW_UP_EVIDENCE_REQUIRED");
  }
  if (value.mode === "follow_up" &&
      resolved.followUp.some((claim) => !["crm_activity", "internal_document"].includes(claim.source_type))) {
    return fail(started, "UNSUPPORTED_MAPPING");
  }

  const data = value.mode === "initial"
    ? initialDraft(
      value,
      visible,
      resolved.outreach,
      resolved.meeting,
      stakeholderResult.stakeholders,
    )
    : followUpDraft(value, resolved.followUp);
  data.messaging_guidance = withGuidance(input);
  data.markdown = renderMarkdown(data);
  const evidenceIds = citationsInMarkdown(data.markdown);
  const status = data.warnings.some((warning) => warning.code === "VISIBLE_EVIDENCE_CONFLICT") ||
      data.warnings.some((warning) => [
        "NO_VISIBLE_EVIDENCE",
        "NO_OUTREACH_CONTEXT",
        "NO_MEETING_CONTEXT",
        "NO_STAKEHOLDER_MAPPING",
      ].includes(warning.code)) ||
      (value.mode === "initial" &&
        (visible.byId.size === 0 || resolved.outreach.length === 0))
    ? "partial"
    : "success";

  const result = skillResult({
    skill: SKILL_NAME,
    status,
    data,
    started,
    evidenceIds,
    warnings: data.warnings,
  });
  if (!validate("engagementDraftData", result.data).valid) {
    throw new Error("engagement.draft produced invalid data.");
  }
  return result;
}

export default draftEngagement;
