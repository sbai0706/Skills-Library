# prepare-engagement

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Compose the existing Account Intelligence evidence workflow with `engagement.draft`:

```text
workflow.input
  -> prepare-first-meeting-v2
  -> engagement.draft
  -> citation and classification verification
```

The v2 workflow supplies the resolved account, normalized claims, and caller-mapped stakeholder
records. The Engagement consumer checks its selected references again at the actual draft boundary.
It intentionally does not copy the base workflow's gap result, gap statuses, or conflict warnings;
draft warnings are based on visible selected claims only.

## Modes and invocation

The input contract is `schemas/prepare-engagement-input.schema.json`. `mode: "initial"` returns an
outreach draft plus meeting agenda, discovery questions, and stakeholder-specific talking points.
`mode: "follow_up"` requires explicit `follow_up_claim_ids` from same-account `crm_activity` or
`internal_document` meeting evidence and returns a follow-up draft plus proposed next actions.

Fixture-only CLI examples:

```bash
npm run prepare-engagement -- --fixture engagement-initial --output markdown
npm run prepare-engagement -- --fixture engagement-follow-up --output markdown
```

Direct invocation:

```js
import { prepareEngagement } from "./workflows/prepare-engagement/index.js";

const result = await prepareEngagement({
  mode: "follow_up",
  workflow_input: {
    account_reference: "Northstar Logistics",
    requested_sources: ["crm"],
    classification_ceiling: "internal"
  },
  follow_up_claim_ids: ["clm_..."]
}, {
  accountAdapter,
  evidenceAdapter,
  claimExtractor
});
```

The optional `annotations.stakeholders` array follows the Account Intelligence mapping contract.
`recipient_name` is optional and must exactly match one unique mapped name. Without it, the outreach
draft uses a generic greeting rather than choosing a person. The caller may supply a versioned
`messaging_guidance` profile with `template_id`, `version`, `approval_status`, and `tone`. Unverified
is the default; caller-reported approval is never treated as verified by this library.

## Result and safety

The result validates against `schemas/prepare-engagement-result.schema.json`; its artifact exists
only for `success` or `partial`. `failed` and `blocked` results have `artifact: null`,
`engagement: null`, and no evidence IDs. Empty follow-up references block; sparse initial input can
return a generic, explicitly partial draft. Conflicting visible claims are cited and flagged without
choosing a winner. Claims above the output ceiling are never cited or copied into names, IDs, warnings,
or other draft-facing metadata.

The workflow is fixture-backed and deterministic at the content level. It has no mail, calendar,
Salesforce write, or CRM mutation adapter; every returned message and next action is draft/proposal
text for human review.
