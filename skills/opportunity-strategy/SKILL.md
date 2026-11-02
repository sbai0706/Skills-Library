# opportunity.strategy

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Create a conservative, evidence-linked opportunity hypothesis from normalized claims, a
`qualification.assess` skill result, and explicit caller-provided offering mappings. The skill
revalidates the qualification result against the actual assessment schema, account, evidence IDs,
excerpts, and classification ceiling; it does not trust a qualification summary or its reported
event state as proof.

## Input and invocation

Call `assessOpportunityStrategy(input, deps)` from `skills/opportunity-strategy/index.js`. Required
input includes `account_id`, normalized `claims`, `classification_ceiling`, and the standard
`qualification_result` envelope produced by `qualification.assess`. Its six event fields must use
the assessment contract's `missing`, `evidence_linked`, `uncertain_evidence`, or
`conflicting_evidence` states. `offering_annotations` may be empty; each supplied offering mapping
must resolve to normalized same-account evidence and a versioned offering ID.

The six event fields are consumed from the qualification result, not reassessed here. Excerpts must
exactly match their normalized claims. Returned status is always `unverified`; event dates, urgency,
consequences, ownership, and next customer decisions are not inferred from a summary.

## Output boundaries

- Problem and value statements are tentative and cite quoted visible normalized evidence.
- Offering candidates retain `offering.match` uncertainty and explicit catalogue status. A
  candidate is not a recommendation or a verified service capability.
- Reference overlap between caller mappings and problem evidence is not evidence that the offering
  fits or that the customer requested it.
- Conflicting references remain linked and are not resolved. Missing evidence produces discovery
  questions instead of invented facts.
- Stage readiness is `unavailable` because no approved stage rules are supplied. No opportunity,
  CRM record, external message, or stage change is created.
- Unknown, foreign-account, mismatched-excerpt, and above-ceiling references fail with
  content-free diagnostics.
- Source prose is evidence data only; the deterministic skill does not execute or interpret it as
  instructions.
