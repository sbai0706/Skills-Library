# opportunity-strategy

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Compose the existing account-resolution, evidence-retrieval, and evidence-normalization path with
`opportunity.strategy`. The workflow accepts the standard skill-result envelope from
`qualification.assess`, rechecks its account and every supplied evidence ID/excerpt against the
normalized claims, then returns a Markdown artifact only after validating all citations.

The workflow does not run a qualification assessor in this checkout. Until the Qualification slice
is integrated, callers must supply an actual `qualification.assess` result; the bundled result is a
fixture for deterministic local testing only. The strategy path never trusts a summary, status, or
reported urgency as proof and always emits the compelling-event assessment as `unverified`.

## Portable fixture invocation

```bash
npm run opportunity-strategy -- --fixture northstar-example --output markdown
```

The fixture uses the existing illustrative Northstar evidence and a provisional placeholder
offering catalogue. It is not automated research, approved catalogue content, a customer-approved
business case, or a qualification run.

Direct callers can invoke `runOpportunityStrategy(input, deps)` from
`workflows/opportunity-strategy/index.js`. Supply account/evidence adapters and a deterministic
claim extractor using the same dependency conventions as `prepareFirstMeeting`; the
`qualification_result` must be a successful or partial standard skill-result object from
`qualification.assess`. `offering_annotations` are optional explicit mappings and default to empty.

## Safety and output

- Every emitted customer reference resolves to a visible normalized claim for the resolved account.
  Qualification excerpts must exactly match their source claim.
- Hidden/foreign/unknown references fail with safe diagnostics and no artifact.
- All six compelling-event fields are retained as linked evidence or explicit gaps. The workflow
  does not implement a second event assessor, infer urgency, choose conflict winners, or derive
  decisions from unverified summaries.
- Offering matches remain hypotheses. Catalogue status is shown as approved, provisional, or
  unknown; a candidate is not an approved service recommendation.
- The value hypothesis is generated only when a caller-mapped candidate cites evidence also linked
  to the event, consequence, or service-need fields. It is explicitly tentative and asserts no
  delivery capability or outcome.
- Stage readiness is unavailable without approved stage rules. Opportunity creation, stage changes,
  CRM writes, and customer communications are not performed.
- Source prose is escaped for display and never executed as instructions.
