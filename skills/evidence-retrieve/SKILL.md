# evidence.retrieve

**Version:** 0.2.0 · **Status:** draft · **Business owner:** TBD

Retrieve raw source records for one resolved account and a set of research questions.
This skill returns inputs. It does not turn them into claims.

## When to use

- You hold a **resolved** `account_id` and specific research questions.
- A later step needs source material before claims can be normalized or assessed.

## When not to use

- The account is unresolved. Call `account.resolve` first; this skill rejects names and domains.
- You need evidence claims, confidence, or verification status. That is `evidence.normalize`.
- You need a summary, an answer, or a judgement about a compelling event.
- You need to write anything back to a source system. This skill is read-only.

## Required input

```json
{
  "account_id": "sf_clear_001",
  "questions": [
    { "id": "FM-CTX-001", "text": "What does the company do?" },
    { "id": "FM-DEV-001", "text": "What meaningful recent developments are available?" }
  ],
  "requested_sources": ["crm", "public_source"]
}
```

- `account_id` — a resolved identifier, no whitespace, not a domain.
- `questions` — at least one `{id, text}`; IDs are unique and stable.
- `requested_sources` — at least one of `crm`, `public_source`, `internal_document`.
  An unrecognized source fails the call; it is never dropped.
- `context` (optional) — `{requested_by, roles, permitted_classifications}` forwarded to
  the adapter for authorization and used to withhold over-classified records. See
  **Classification** below for the default.

## Source records are not evidence claims

Records follow `schemas/source-record.schema.json`. They carry `record_id`, `account_id`,
`source_type`, `title`, raw `content`, `source_uri`, optional `published_at`, optional
`occurred_at`, `retrieved_at`, `access_classification`, the `question_ids` the adapter judged
relevant, and a flat `metadata` object. Publication and event/activity occurrence timestamps are
distinct; a source may provide either or both, and retrieval preserves them without substitution.

They deliberately have **no** `claim`, `confidence`, or `verification_status`.
Do not describe them as evidence, findings, or facts. Do not summarize them in place of the
source text. Downstream normalization produces claims; this skill only retrieves.

## Output

`data` contains `account_id`, `requested_sources`, `question_ids`, `records`,
`source_results` (one per source with `outcome` and counts), and `record_count`.
`evidence_ids` is always empty. Records are deduplicated by `record_id` and ordered by
`source_type`, then `occurred_at`, then `record_id`, so repeated runs are stable.

Per-source `outcome`: `ok`, `empty`, `unauthorized`, `unavailable`, `malformed`,
`unsupported`.

## Classification

The classification filter is fail-closed:

| Caller supplies | Permitted |
| --- | --- |
| `permitted_classifications` omitted | `public`, `internal` |
| `permitted_classifications: []` | nothing |
| `["public", "internal", "confidential"]` | those three |

- **Confidential** requires explicit inclusion in the list. Omitting the field never permits it.
- The adapter must still authorize the read independently; the classification filter is a second,
  skill-level control, not a replacement for authorization.
- A record whose `access_classification` is not `public`, `internal`, or `confidential` is
  **withheld**, never treated as public, and reported as `UNRECOGNIZED_CLASSIFICATION_WITHHELD`.
- Withholding is reported through aggregate counts only (`withheld_count`, `RECORDS_WITHHELD`,
  `CLASSIFICATION_RESTRICTED`). No withheld record's identifier, title, content, or metadata
  appears anywhere in the result.

## Partial results

Sources are retrieved independently. One failing source never discards another's records.

| Situation | Status |
| --- | --- |
| Every source clean (including empty) | `success` |
| Some sources usable, at least one failed, denied, restricted, or degraded | `partial` |
| Every source failed, at least one authorization denial or classification block | `blocked` |
| Every source failed, no access-policy issue | `failed` |

A `partial` or `blocked` result carries a structured `errors` entry per affected source
(`details.source` identifies it) and a `PARTIAL_SOURCES` warning. Present the usable records and
state which source is missing. Never fill the gap from memory.

## Zero results

An empty retrieval is `success` with `records: []` and a `NO_RECORDS_RETRIEVED` warning.
Say that no records were retrieved from the requested sources. Do **not** say the information
does not exist, and do not substitute outside knowledge.

## Authorization

The adapter enforces access. On denial the skill returns no records from that source, preserves
the `ADAPTER_UNAUTHORIZED` error, and returns `partial` if another source worked or `blocked`
if none did. A denied source's records must never appear in any field of the result.

A source whose records were all withheld by the classification policy yields `blocked` with
`CLASSIFICATION_RESTRICTED` when it is the only source, and `partial` when another source
produced usable records. Withheld records are counted, never described.

## Constraints

- No model call, no summarization, no ranking, no confidence scoring.
- No live Salesforce or web access. Only fixture adapters exist in this repository.
- Malformed records are rejected whole and reported; material fields are never repaired.
- Records for another account, or citing a question that was not asked, are rejected.
- Adapters return `{ok:false, error:{code,message,retryable}}`; they do not throw, and thrown
  errors are normalized to `ADAPTER_UNAVAILABLE`.

## Retry policy

**The skill never retries.** It calls each requested source exactly once and reports the result.

| Error code | Retryable | Why |
| --- | --- | --- |
| `ADAPTER_UNAVAILABLE` | yes | Transient transport or timeout failure |
| `ADAPTER_MALFORMED_RESPONSE` | no | Deterministic payload defect; repeating it cannot help |
| `ADAPTER_UNAUTHORIZED` | no | Access will not change on retry |
| `UNSUPPORTED_SOURCE` | no | The source is not part of the contract |
| `CLASSIFICATION_RESTRICTED` | no | The caller's permission is unchanged |
| `INVALID_INPUT` | no | The same request will fail again |

A future live adapter may retry transient transport failures **inside** the adapter before
returning. Retryable errors are surfaced for the caller to schedule, not acted on here.

## Examples

**Complete** — `{"account_id":"sf_clear_001","questions":[…],"requested_sources":["crm","public_source"]}`
→ `success`, five records, `source_results` all `ok`.

**Partial** — same request where public sources time out → `partial`, CRM records retained,
`errors: [{code:"ADAPTER_UNAVAILABLE", details:{source:"public_source"}}]`.

**Empty** — valid account, both adapters return nothing → `success`, `record_count: 0`,
`NO_RECORDS_RETRIEVED`.

**Denied** — public source denied, CRM succeeds → `partial`, CRM records only, no text from the
denied source anywhere in the result.

**Restricted** — an internal and a confidential CRM record with
`context: {"permitted_classifications": ["public", "internal"]}` → `partial`, the internal
record returned, `CLASSIFICATION_RESTRICTED` reported, and nothing about the confidential record
in the output.

**Rejected input** — `{"account_id":"Northstar Logistics", …}` → `failed`, `INVALID_INPUT`;
resolve the account first.
