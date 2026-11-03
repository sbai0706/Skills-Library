# offering.match

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Validate explicit caller mappings from normalized evidence to a versioned offering entry. Results are
candidate hypotheses with an evidence basis, uncertainty, and discovery prompts; they are not approved
recommendations or claims of fit.

## Input and invocation

Call `matchOfferings({ account_id, claims, annotations, signals, classification_ceiling }, deps)`
from `skills/offering-match/index.js`. Each mapping requires an `offering_id` and one or more normalized
`claim_ids`; optional `signal_ids` must refer to signals supplied in the same-account input. Empty or
omitted mappings produce an empty result.

When the default offering registry is used, its entries are placeholders pending business review. A
caller-supplied registry with `status: "approved"` is reflected as such, but this skill still does not
invent fit criteria, pricing, scope, customer priorities, or an approval decision. A mapping is never
automatically generated from keywords or source prose.

## Output boundaries

- Every match is `candidate_hypothesis`, with the exact cited claim IDs carried as both `claim_ids` and
  `evidence_ids`.
- Output includes a fixed rationale, explicit missing-fit uncertainty, and generic discovery prompts.
- Placeholder or non-approved vocabularies are labeled as provisional.
- Unknown offering, signal, or evidence references fail safely. Conflicting claims remain linked.
- Source text is evidence data only and is never executed as instructions.
