# gap.detect

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Compare normalized evidence claims against the first-meeting reference questions and return an explicit
coverage result for every question. The skill reports gaps; it never fills them.

## Purpose

For one resolved account, determine whether the available normalized claims:

- answer a question;
- partially answer a question;
- leave a question unanswered;
- contain unresolved conflicting claims relevant to a question.

The result is a structured gap result that identifies stable question IDs, per-question status, valid
supporting evidence IDs, safe reason codes, and conflict references.

## When to use

- Normalized claims for a resolved account are available and first-meeting question coverage must be
  summarized without generating prose.
- A later workflow needs a machine-readable record of which questions are answered, partial, unanswered,
  or conflicted.
- Unresolved conflicts must be surfaced without selecting a winning claim.

## When not to use

- Evidence has not been retrieved or normalized. Use the retrieval and normalization skills first.
- You need to retrieve records, normalize raw material, or create new factual claims.
- You need to answer a question in prose, recommend a discovery answer, or decide qualification or
  opportunity stage.
- You need to resolve a conflict. Conflicts are reported for human review.
- The account is unresolved. `account_id` must be a resolved identifier, not a name or domain.

## Missing evidence is not false information

An `unanswered` question means no valid evidence linked to that question was supplied. It does not mean
the underlying fact is false, absent from the account, or impossible. The only safe description is the
generic reason code and allowlisted text returned by the skill. Never convert a gap into a negative fact.

A `partial` question means relevant claims exist but one or more explicitly declared required aspects are
not covered. It is not a statement that the unsupported aspect is false.

## Required input

```json
{
  "account_id": "acct_northstar",
  "questions": [
    { "id": "FM-CTX-001", "question": "What does the company sell, to whom, and in which geographies?" }
  ],
  "claims": [ { "...": "one evidence.schema.json record" } ],
  "conflicts": [ { "conflict_id": "cfl_example", "claim_ids": ["clm_a", "clm_b"] } ]
}
```

- `account_id` — required resolved identifier.
- `questions` — optional array; when omitted, the draft reference question set is used. Every provided
  question needs a stable unique ID.
- `claims` — required array of evidence claims; an empty array is valid.
- `conflicts` — optional array of unresolved conflict records. Each conflict needs a conflict ID (or one
  is derived deterministically from its sorted claim IDs) and claim IDs that exist in the accepted input.
- `question_set_version` — optional semantic version; defaults to the reference question set version.

Claims are validated against `evidence.schema.json`. Claims for another account, claims with duplicate
evidence IDs, malformed claims, and claims referencing question IDs outside the question set are rejected
and reported through safe structured diagnostics. A rejected claim is never used to classify a question.
Conflicts that reference rejected or unknown evidence IDs are rejected rather than partially applied.

## Deterministic question linkage

A claim may contribute to a question only when its own `question_ids` array explicitly contains that
question ID. No semantic similarity, keyword matching, or model judgment is used for linkage.

A claim may link to several questions and then contributes to each of them. A claim with no question IDs
is valid evidence but contributes to no question. A claim referencing any unknown question ID is rejected
whole rather than silently having the unknown reference ignored.

## Question status policy

| Status | Meaning |
| --- | --- |
| `answered` | At least one valid relevant claim exists and every declared required aspect is covered. |
| `partial` | Relevant valid claims exist, but at least one explicitly declared required aspect is not covered. |
| `unanswered` | No valid relevant claim exists. Supporting evidence IDs are empty. |
| `conflicted` | At least one unresolved conflict applies to a relevant claim. |

Question order follows the supplied question order. Supporting evidence IDs are sorted
deterministically. A question with no required aspects is answered as soon as it has a valid relevant
claim; no additional business threshold is invented.

### Provisional required-aspect scaffolding

Required aspects exist only to prove partial coverage in the MVP. A question fixture may declare:

```json
{
  "id": "FM-SVC-001",
  "required_aspects": [
    { "id": "initiative", "source_types": ["news"] },
    { "id": "alignment", "claim_ids": ["clm_example"] }
  ]
}
```

An aspect is covered when at least one relevant claim matches one of its declared source types or one of
its declared evidence IDs. These aspect definitions are **provisional implementation scaffolding, not
approved business policy**. They do not define an approved requirement for every reference question.

## Conflict behavior

A conflict applies to a question when any claim involved in the conflict is explicitly linked to that
question. A conflicted question:

- keeps status `conflicted`;
- retains every relevant claim ID and every claim ID involved in the applicable conflict;
- keeps the applicable conflict IDs;
- includes the safe reason code `conflicting_claims`;
- is never converted to `unanswered`, `partial`, or `answered`.

No claim is selected as correct, no conflict is merged away, and no conflicting claim is discarded. If a
claim is already marked `conflicting` but no conflict record references it, a deterministic derived
conflict reference is emitted so the unresolved state is not hidden. A conflict is a valid business
result, not a skill failure. An invalid conflict reference is rejected and reported; it never makes the
whole result untrustworthy.

## Classification-safe diagnostics

The gap result contains no claim text, excerpt, source content, or generated conclusion. Diagnostics may
contain stable IDs, question IDs, counts, schema paths, and fixed reason text only. Confidential claim
content therefore cannot leak through warnings, errors, or `missing_evidence_description`, which is
restricted to allowlisted generic text.

## Output

The skill returns the common skill-result envelope with a `data` payload that validates against
`gap-result.schema.json`:

```json
{
  "account_id": "acct_northstar",
  "question_set_version": "0.1.0",
  "questions": [
    {
      "question_id": "FM-CTX-001",
      "status": "answered",
      "supporting_evidence_ids": ["clm_example"],
      "reason_codes": []
    },
    {
      "question_id": "FM-DEV-001",
      "status": "conflicted",
      "supporting_evidence_ids": ["clm_a", "clm_b"],
      "reason_codes": ["conflicting_claims"],
      "conflict_ids": ["cfl_example"]
    },
    {
      "question_id": "FM-STK-001",
      "status": "unanswered",
      "supporting_evidence_ids": [],
      "missing_evidence_description": "No supporting claims were provided.",
      "reason_codes": ["no_supporting_claims"]
    }
  ],
  "summary_counts": {
    "total": 3,
    "answered": 1,
    "partial": 0,
    "unanswered": 1,
    "conflicted": 1
  }
}
```

The envelope's `evidence_ids` is the sorted union of all evidence IDs referenced by question results.
Every emitted evidence ID exists in the accepted input. The summary counts always agree with the
per-question statuses.

## Status behavior

| Situation | Status |
| --- | --- |
| All valid input processed, including unanswered questions or conflicts | `success` |
| Some claims or conflicts rejected, but a trustworthy gap result remains | `partial` |
| Input cannot be validated, the reference dependency fails, or processing is malformed | `failed` |
| A genuine policy or authorization condition prevents execution | `blocked` (not produced by this skill today) |

Empty claims, all-unanswered results, and unresolved conflicts are valid business results. They are not
execution failures.

## Constraints

- Never retrieve, normalize, or invent evidence.
- Never create a factual claim or answer a question in prose.
- Never treat missing evidence as proof that a fact is false.
- Never infer a question linkage from semantic similarity; require an explicit question ID.
- Never silently accept an unknown question reference, duplicate evidence ID, foreign-account claim, or
  conflict that references unknown evidence.
- Never select a conflict winner or merge conflicting claims.
- Never downgrade a conflicted question to another status.
- Never copy claim text, excerpts, or source content into diagnostics or descriptions.
- Never decide qualification, opportunity stage, or a recommended discovery answer.
- Never use a live connector, renderer, workflow composition, or platform integration in this skill.

## Examples

**All answered** — two claims explicitly link to two questions and both questions have no declared
aspects → `success`, both `answered`, supporting IDs sorted.

**Empty claims** — valid questions and `claims: []` → `success`, every question `unanswered` with
`no_supporting_claims`; no claim is fabricated.

**Partial coverage** — a question declares an initiative aspect and an alignment aspect, and only a news
claim is linked to it → `partial` with the safe partial-support description.

**Conflict surfaced** — two linked claims disagree and an unresolved conflict references both → the
question is `conflicted`, both IDs remain, the conflict ID is preserved, and no winner is chosen.

**Foreign claim rejected** — a claim belongs to another account → it is not used, the result is `partial`,
and the rejected evidence ID never appears in question or envelope evidence IDs.
