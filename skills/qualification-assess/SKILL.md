# qualification.assess

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Inventories caller-mapped, normalized evidence for qualification criteria and the six compelling-event fields. It is an advisory evidence assessment, not a qualification decision.

## Input and invocation

Call `assessQualification(input, deps)` from `skills/qualification-assess/index.js`. The input validates against `schemas/qualification-assess-input.schema.json` and requires an account ID, normalized claims, and a classification ceiling. Optional `criteria_set` must supply a semantic version, an `approved` or `provisional` approval status, and explicit criterion definitions. Optional `event_evidence` maps field names to normalized claim IDs.

Each evidence mapping must resolve to a normalized claim for the same account and within the requested classification ceiling. Unknown, foreign-account, malformed, and above-ceiling references fail with safe diagnostics. A missing mapping remains missing. Caller mappings add evidence references only; they do not establish that a criterion is satisfied or that an event is compelling.

## Output and safety

The shared `skillResult` envelope contains `data` validating against `schemas/qualification-assessment.schema.json`. Each criterion and each of the six event fields is marked `missing`, `evidence_linked`, `uncertain_evidence`, or `conflicting_evidence`; linked excerpts are copied from visible normalized claims. No claim is selected as the winner of a visible conflict.

- No default B-FITT dimensions, weights, threshold, or criterion definitions are supplied. Without a caller definition, criteria remain unprovided.
- Evidence linkage is not a pass/fail result. `qualification_decision` is always `not_determined`.
- An event with linked field evidence remains `unverified`; field completeness does not establish a compelling event, urgency, or causality.
- `stage_readiness` is always `unavailable` until approved lifecycle mappings, QL/SAL order, and stage gates are provided.
- No stage changes, opportunity creation, external connector calls, or CRM mutations occur.
- The source presentation's mockup labels and examples are not adopted as policy. Repository sample evidence is fabricated/illustrative and must not be used as customer truth.
