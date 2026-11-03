# opportunity-strategy

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Compose the existing account-resolution, evidence-retrieval, and evidence-normalization path with
the actual `qualification.assess` skill and `opportunity.strategy`. Caller-provided event evidence
mappings are passed to the qualification skill after normalization; the workflow rechecks the
resulting account, all evidence IDs/excerpts, and classification scope before validating artifact
citations.

The workflow does not accept a caller-drafted qualification result. It runs the integrated
qualification skill over the same normalized claims used by the strategy. The strategy path never
trusts a summary, status, or reported urgency as proof and always emits the compelling-event
assessment as `unverified`.

## Portable fixture invocation

```bash
npm run opportunity-strategy -- --fixture northstar-example --output markdown
```

The fixture uses the existing illustrative Northstar evidence and a provisional placeholder
offering catalogue. The event mapping is an example caller-supplied ID mapping, not a verified
event; it is not automated research, approved catalogue content, or a customer-approved business
case.

Direct callers can invoke `runOpportunityStrategy(input, deps)` from
`workflows/opportunity-strategy/index.js`. Supply account/evidence adapters and a deterministic
claim extractor using the same dependency conventions as `prepareFirstMeeting`. The optional
`qualification` object accepts `criteria_set` and `event_evidence` mappings in the
`qualification.assess` input format. The workflow supplies normalized claims, conflicts, account,
and classification ceiling itself. `offering_annotations` are optional explicit mappings and
default to empty.

## Safety and output

- Every emitted customer reference resolves to a visible normalized claim for the resolved account.
  Qualification excerpts must exactly match their source claim; qualification output is created by
  the integrated skill, not accepted from caller prose.
- Hidden/foreign/unknown references fail with safe diagnostics and no artifact.
- All six compelling-event fields are retained as linked evidence or explicit gaps. The workflow
  does not implement a second event assessor, infer urgency, choose conflict winners, or derive
  decisions from unverified summaries.
- Offering matches remain hypotheses. Catalogue status is shown as approved, provisional, or
  unknown; a candidate is not an approved service recommendation.
- A value hypothesis is generated only when a caller-mapped candidate reuses references that also
  support the problem hypothesis. This reference overlap is not evidence that the offering fits.
  The hypothesis is explicitly tentative and asserts no delivery capability or outcome.
- Stage readiness is unavailable without approved stage rules. Opportunity creation, stage changes,
  CRM writes, and customer communications are not performed.
- Source prose is escaped for display and never executed as instructions.
