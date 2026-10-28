# evidence.normalize

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Convert retrieved raw source records into structured, claim-level evidence records.
Every emitted claim is machine-checked for direct support against its source excerpt.
This skill never guesses a claim into existence.

## When to use

- You hold raw source records (typically the output of `evidence.retrieve`) for a resolved account
  and need claim-level evidence with provenance.
- A later step (gap detection, qualification, brief rendering) requires claims it can cite.

## When not to use

- You need to retrieve records. That is `evidence.retrieve`; this skill performs no retrieval.
- You need to answer first-meeting questions or decide whether a compelling event exists.
  A claim list is not an answer; questions may remain unanswered even with claims present.
- You need to resolve a contradiction. Conflicts are reported, never adjudicated.
- The account is unresolved. `account_id` must be a resolved identifier.

## Source records vs evidence claims

| Source record (`source-record.schema.json`) | Evidence claim (`evidence.schema.json`) |
| --- | --- |
| Raw retrieved material, one per source record | A single factual assertion, machine-verified |
| No claim text, confidence, or verification | Carries claim text, confidence, verification status |
| Relevance decided by the adapter | Support decided by this skill against the excerpt |

Adapter relevance is not evidence correctness. A record the adapter considered relevant still
produces no claims unless a candidate claim passes direct-support checking.

## Required input

```json
{
  "account_id": "acct_northstar",
  "records": [ { ...one source-record.schema.json object... } ]
}
```

- `account_id` — resolved identifier, never an account name or domain.
- `records` — an array (possibly empty) of raw source records.

An empty array is valid and returns `success` with zero claims.
Records belonging to another account are rejected with reason `foreign_account`.

## Extraction boundary

Turning unrestricted prose into candidate claims genuinely requires reading comprehension,
and this repository contains no model. The boundary is therefore explicit:

- The skill accepts a **claim extractor** dependency implementing `extract(record)` from
  `adapters/claim-extractor.js`. The extractor PROPOSES candidates; it never decides.
- The only implementation today is the deterministic fixture extractor, which reads explicit
  candidate claims from the record's flat `metadata.claim_candidates_json` string. It parses
  no prose. A future model-backed extractor can replace it without changing this skill's
  input or output contract.
- The skill itself owns validation, direct-support checking, provenance, classification
  policy, confidence, deduplication, conflicts, rejection, and output construction.

## Direct-support requirement

A claim is emitted only when both hold:

1. **Verbatim excerpt.** The candidate excerpt appears in the record content, ignoring only
   whitespace-run differences. Nothing else is normalized away.
2. **Token support.** Every significant token of the claim (lowercased, diacritics stripped,
   stopwords and punctuation removed) occurs in the excerpt. Numbers survive, so quantities,
   years, and dates remain comparable. A claim that introduces a name, quantity, date,
   product, intention, or relationship absent from the excerpt is rejected as
   `unsupported_claim` — not "cleaned up" into something supportable.

One source record may produce multiple claims. One claim references exactly one source
record in this MVP.

## Provenance, confidence, and verification

Every claim carries `source_record_id` plus `source_uri` when available, the record's
`source_type` and `account_id`, `retrieved_at`, and the excerpt it rests on. Distinct
optional timestamps are preserved without substitution: source `published_at` maps to claim
`published_at`; source `occurred_at` maps to claim `occurred_at`. If a source has both,
both are carried; if it has no publication date, `published_at` is omitted. The record's
`question_ids` are preserved as optional claim metadata — carrying a question ID does not prove
the question was answered.

Confidence is deterministic policy, never model judgment:

| Condition | Confidence |
| --- | --- |
| Directly supported, complete statement (`completeness: "complete"`) | `high` |
| Directly supported, but partial or hedged (`completeness` omitted or `"partial"`) | `medium` |
| Weak or unsupported candidate | rejected — `low` is never emitted |

`verification_status` is `direct` for every accepted claim. `conflicting` replaces it when a
conflict is detected (below). `inferred` is never emitted by this MVP. `corroborated` is not
emitted either: cross-record agreement currently yields separate claims, not a merged
corroborated record.

## Deduplication

Conservative and scoped to the source record:

- **Within one record**, exact normalized claim text collapses to one claim; later candidates
  are rejected as `duplicate_claim` and counted in a `DUPLICATE_CLAIMS_REMOVED` warning.
- **Across records**, identical claim text is NOT a duplicate. Each record's version is kept
  with its own claim ID and provenance, so independent corroboration is never discarded to
  shorten output.

Claim IDs are deterministic: `clm_` + the first 16 hex characters of
`SHA-256("<account_id>|<record_id>|<normalized claim text>")`. The same input always
produces the same ID; no random values are involved.

## Conflicts

When candidates declare the same `conflict_key` and their accepted claims disagree, the skill:

- keeps every claim, each with its own provenance and classification;
- marks each one `verification_status: "conflicting"`;
- lists the conflict in `data.conflicts` with a stable `conflict_id`, the shared key, and both
  claim IDs;
- never selects a winner, never merges, never discards either side.

A conflict is not an execution failure. Present both claims with their sources and let a human
decide.

## Classification

Fail-closed, same policy as `evidence.retrieve`:

- A claim's `access_classification` defaults to the record's.
- A candidate may keep or raise the level (e.g. label a specific fact `confidential` inside an
  `internal` record) but may never lower it. A downgrade attempt is rejected as
  `classification_violation`.
- `question_ids` ride along as metadata and are never treated as authorization.

## Constraints and rejections

Nothing is silently dropped. Every rejection appears in `data.rejected_records` with
`source_record_id`, a stable `reason` code, a safe explanation, and a `scope` of
`record` (whole record unusable) or `candidate` (one claim candidate, others may survive).
Rejection messages never contain record content, so confidential text cannot leak through
the diagnostics channel.

| Reason | Scope | Meaning |
| --- | --- | --- |
| `malformed_source_record` | record | Failed schema or integrity validation |
| `foreign_account` | record | Belongs to a different account than requested |
| `extractor_failure` | record | Extractor threw, errored, or returned a malformed envelope |
| `excerpt_not_found` | candidate | Excerpt not a verbatim segment of the content |
| `unsupported_claim` | candidate | Claim introduces information absent from the excerpt |
| `classification_violation` | candidate | Attempted to lower the record's classification |
| `duplicate_claim` | candidate | Equivalent claim from the same record already accepted |

Duplicates are recorded as rejections plus a warning — one consistent policy, not sometimes
an error and sometimes silent.

## Output and status

`data` contains `account_id`, `claims`, `rejected_records`, `conflicts`, `source_record_count`,
and `claim_count`. The envelope's `evidence_ids` equals exactly the emitted claim IDs.
Claims and rejections are sorted deterministically (`record_id`, then `claim_id` / reason).

| Situation | Status |
| --- | --- |
| All records processed, none rejected (including empty input) | `success` |
| Some records or candidates rejected, at least one claim or clean record remains | `partial` |
| Extractor missing or request-level input invalid | `failed` |

Zero claims from valid input is `success`, not a failure: absence of evidence is not
evidence of absence. Unsupported content is not a system failure either — it is a rejection.

## Examples

**Single supported claim** — one news record, one candidate whose excerpt matches verbatim →
`success`, one `high`-confidence `direct` claim, `evidence_ids` holds its claim ID.

**Contradiction surfaced** — two records, same `conflict_key: "automation_start_date"`, one
says 2027 and one says 2028 → both claims kept and marked `conflicting`, one conflict entry
linking both claim IDs, no winner.

**Empty input** — `records: []` → `success`, `claim_count: 0`, no claims, no rejections.

**Unsupported candidate** — claim mentions "five depots in 2028" but the excerpt only says
"pilot at one depot" → rejected `unsupported_claim`; the record's other supported claim
still normalizes, result is `partial`.

**Confidential stays confidential** — a candidate on a confidential record tries to label
itself `public` → rejected `classification_violation`; the record's other claims keep
the `confidential` level.