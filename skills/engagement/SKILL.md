# engagement.draft

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Create a reviewable initial outreach/meeting-preparation draft or a source-neutral follow-up draft.
The function uses only explicit references to normalized evidence. It does not send communications,
write CRM records, select a target person, or infer decision authority, agreement, ownership, budget,
or timing.

## Invocation

```js
import { draftEngagement } from "./skills/engagement/index.js";

const result = draftEngagement({
  mode: "initial",
  account,
  claims: normalizedClaims,
  classification_ceiling: "internal",
  outreach_claim_ids: ["clm_..."],
  meeting_claim_ids: ["clm_..."],
  stakeholder_map: mappedStakeholders,
  recipient_name: "Exact name from a supplied stakeholder mapping",
  messaging_guidance: {
    template_id: "example-neutral-outreach",
    version: "0.1.0",
    approval_status: "provisional",
    tone: "neutral"
  }
});
```

For `mode: "follow_up"`, provide `follow_up_claim_ids` from same-account normalized
`crm_activity` or `internal_document` evidence. Source type alone does not establish that a meeting
occurred; follow-up prose asks the recipient to review supplied notes without presuming a discussion.
Empty evidence references block without a draft. The callable skill accepts
`schemas/engagement-draft-input.schema.json` and returns the shared skill-result envelope with data
validated by `schemas/engagement-draft-data.schema.json`.

The versioned messaging profile accepts a caller-supplied ID, semantic version, approval state, and
one of four generic tones. Its default status is provisional. Caller-reported approval is displayed
as **caller-reported approved; approval was not verified by this skill**. The skill does not accept
arbitrary template prose or treat style guidance as factual evidence.

## Evidence and output boundaries

- Every cited claim is resolved against normalized evidence for the requested account and the
  classification ceiling. Missing and above-ceiling selected references share a generic safe
  diagnostic and no artifact.
- Only caller-selected non-conflicting claims appear as outreach context. Visible conflicting
  claims remain cited in review notes; no winner is selected, and the draft is held for review.
- Caller-mapped names and roles remain unverified hypotheses, not recorded facts; their cited source
  notes remain visible for human review. Greetings stay generic, and no contact identity or role is
  asserted from an unstructured mapping.
- Agenda prompts are questions, not asserted business policy. No target, personalization, approval,
  commitment, owner, or due date is manufactured.
- The workflow does not copy gap or conflict metadata from the first-meeting workflow. Warnings are
  derived only from visible selected evidence and source-preparation outcomes.
- Sparse initial evidence may produce a clearly partial, generic draft with open questions. Missing
  follow-up evidence blocks and returns no artifact.

Source prose is data, never executable instructions. This library skill has no message-send or CRM
mutation capability.
