# source.rank

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

For one resolved account, order the evidence sources that hold data about it by **how recent that data
is**, newest first. The skill reports an ordering and the timestamps behind it; it never judges the
sources.

**This is recency ordering only.** A higher rank means "its newest data is more recent", nothing more.
The skill makes no judgement of source reliability, authority, accuracy, completeness or quality, and no
business policy is encoded. A newer source is not a better or more trustworthy source, and the ranking
must not be used to pick a winner between conflicting claims. Do not read a rank as a recommendation to
prefer a source.

## Naming

Capability id `source.rank`, in `skills/source-rank/`, function `rankSources`. This follows the existing
`noun.verb` convention (`evidence.retrieve`, `gap.detect`). The result carries
`ranking_basis: "data_recency_only"` so a consumer cannot mistake the ordering for a quality ranking.

## When to use

- Records or normalized evidence for a resolved account are available and the caller wants to know which
  source (CRM, a market-intelligence provider, a public web source, an internal document store, ...)
  holds the most recently dated data about the account.
- A later step needs a machine-readable, reproducible freshness ordering of an account's sources, with
  the IDs of the records that justify each source's latest date.
- A caller needs to see which sources have no usable date at all, rather than having them silently
  dropped.

## When not to use

- You need to decide which source is more reliable, authoritative or correct, or which claim wins a
  conflict. This skill does not do that.
- You need to retrieve, normalize or summarize evidence; use the retrieval and normalization skills first.
- The account is unresolved. `account_id` must be a resolved identifier, not a name or domain.
- You need a freshness threshold, staleness verdict or policy ("older than N days is stale"). No such rule
  is approved or encoded; age is reported as a number and left to the caller.

## Input

```json
{
  "account_id": "acct_vantage_001",
  "records": [ { "...": "one source-record.schema.json item" } ],
  "evidence": [ { "...": "one evidence.schema.json item" } ],
  "now": "2026-11-05T12:00:00Z"
}
```

- `account_id` — required resolved identifier (same rules as `gap.detect`: no whitespace, not a domain).
- `records` — optional array of raw source records (`source-record.schema.json`).
- `evidence` — optional array of normalized evidence items (`evidence.schema.json`).
- At least one of `records` / `evidence` must be present (it may be empty, which is reported as blocked).
- `now` — optional RFC 3339 date-time used for `age_days`. Supplying it (or `deps.now`) makes the whole
  call clock-free; otherwise the system clock is read once. Input `now` takes precedence over `deps.now`.

No parallel record format exists. Items are validated one by one against the shared schemas with a single
deliberate relaxation: **the three timestamp fields (`published_at`, `occurred_at`, `retrieved_at`) need
not be valid date-times**, because a missing or malformed timestamp is a reportable condition here, not a
rejection. Every other field is validated strictly. Callers should pass records already filtered to the
classification ceiling they may show: the output exposes source identifiers, IDs, timestamps and counts
but never record content, titles, claims, excerpts or URIs.

Pass either the raw records or the normalized evidence derived from them. If both are supplied for the
same data, `record_count` counts every accepted item, so the same underlying record is counted twice.

## Source identifier

Records are grouped by the field the shared schema uses to name the source system:

1. `metadata.provider` of a source record (trimmed, case-sensitive) — `source_id_basis: "metadata.provider"`.
2. Fallback when the provider is absent or empty: the broad `source_type`, emitted as
   `source_type:<type>` — `source_id_basis: "source_type"`, with a `SOURCE_ID_FALLBACK` warning. This is a
   coarser grouping (for example `crm_record` and `crm_activity` land in separate groups).

Evidence items have no provider field. An evidence item whose `source_record_id` equals the `record_id` of
an accepted supplied record inherits that record's source identifier; any other evidence item is grouped
by its own `source_type` (the same fallback).

## Timestamp field precedence

The recency of an item is the as-of date of its **data**, never the time it was fetched, whenever the
schema lets us tell them apart. Per item, the first usable value wins:

1. `published_at` — the time the source itself states it published the data; this is the source's own
   as-of statement.
2. `occurred_at` — when the underlying event or activity happened (for example a CRM call), used when no
   publication time exists.
3. `retrieved_at` — **fallback only**, see below.

When an item carries both `published_at` and `occurred_at`, `published_at` wins (it is when the source held
that information); the schemas keep the two fields distinct and so does this skill. An invalid value in a
higher-precedence field is treated as missing and the next field is tried.

A source's `latest_data_at` is the maximum of its items' data timestamps (`published_at` / `occurred_at`).
**`retrieved_at` is used only at source level and only when no item of that source has a usable data
timestamp.** It is then reported with `recency: "retrieval_fallback"`, `latest_data_at_field:
"retrieved_at"` and a `RETRIEVAL_TIME_FALLBACK` warning, because it says when the data was fetched, not how
recent it is. An item without a data timestamp inside an otherwise dated source never contributes its
retrieval time.

## Timestamp validity

A timestamp is usable only if it is a string in RFC 3339 `date-time` form with an explicit offset
(`2026-10-12T09:00:00Z`, `2026-10-12T11:00:00+02:00`) and a real calendar date. `null` and absent values are
simply missing. Any other present value (wrong type, empty string, date only, no offset, impossible date such
as 30 February) is invalid: it is treated as missing, counted in `invalid_timestamp_count` and
`summary_counts.invalid_timestamps`, and reported through an `INVALID_TIMESTAMP_IGNORED` warning. An item is
never rejected for its timestamps alone. Instants are compared by UTC epoch value and emitted in UTC.

## Ordering and ties

1. `dated` sources (ranked by a data timestamp), newest first.
2. `retrieval_fallback` sources, newest retrieval first. They always follow data-dated sources, because a
   retrieval time is typically newer than the data it fetched and would otherwise outrank genuinely dated data.
3. `unknown` sources (no usable timestamp at all), by `source_id` ascending, with `rank: null`.

Ranks are 1-based and continuous across groups 1 and 2. Sources with the same latest instant in the same
group are **tied**: they are ordered by `source_id` ascending (code-unit order, locale independent), receive
distinct consecutive ranks, list each other in `tied_with`, and trigger a `RECENCY_TIE` warning. The result
never depends on input order and never on the number of records a source has.

Account scope: any item whose `account_id` differs from the request is excluded before anything else is
inspected, counted in `summary_counts.records_excluded_foreign_account`, and reported in a
`FOREIGN_ACCOUNT_RECORDS_EXCLUDED` warning. It is never ranked, and its IDs are not echoed.

## Output

The common skill-result envelope; `data` validates against `source-rank-result.schema.json`:

```json
{
  "account_id": "acct_vantage_001",
  "now": "2026-11-05T12:00:00Z",
  "ranking_basis": "data_recency_only",
  "timestamp_precedence": ["published_at", "occurred_at", "retrieved_at"],
  "sources": [
    {
      "rank": 1,
      "source_id": "fixture-market-intel",
      "source_id_basis": "metadata.provider",
      "source_types": ["third_party"],
      "recency": "dated",
      "latest_data_at": "2026-10-30T08:00:00Z",
      "latest_data_at_field": "published_at",
      "age_days": 6,
      "record_count": 3,
      "supporting_record_ids": ["src_mi_2002"],
      "supporting_evidence_ids": ["clm_mi_3001"],
      "tied_with": [],
      "invalid_timestamp_count": 0
    }
  ],
  "summary_counts": {
    "sources": 5, "data_dated": 3, "retrieval_fallback": 1, "recency_unknown": 1,
    "records_accepted": 10, "records_excluded_foreign_account": 1,
    "records_rejected": 0, "invalid_timestamps": 1
  }
}
```

- `supporting_record_ids` / `supporting_evidence_ids` — every accepted item whose timestamp equals the
  source's `latest_data_at`, sorted. Source record IDs (`src_...`) and evidence IDs (`clm_...`) are kept in
  separate arrays because the envelope's `evidence_ids` may only hold `clm_` IDs.
- `age_days` — whole days (rounded down) from `latest_data_at` to `now`; negative means the timestamp is later
  than `now` (reported with a `FUTURE_TIMESTAMP` warning; the value is still used, not discarded).
- Envelope `evidence_ids` — sorted union of all `supporting_evidence_ids`; empty for record-only input.

Runnable fixture: `fixtures/source-rank-recency/` (`input.json`, `expected.json`).

## Status behavior

| Situation | Status |
| --- | --- |
| At least one source is dated and every source has a usable timestamp (warnings allowed) | `success` |
| Some source has recency unknown, or some item was rejected as malformed or duplicate | `partial` |
| No item matches the account or is usable (nothing supplied, all foreign, or all rejected) | `blocked`, `data: null` |
| Invalid request (bad account, bad `now`, wrong types, neither array, unknown property) | `failed`, `INVALID_INPUT` |

Errors use existing codes: `INVALID_INPUT` (request, malformed or duplicate item),
`ACCOUNT_SCOPE_MISMATCH` (nothing belongs to the account), `EVIDENCE_REFERENCE_UNAVAILABLE` (nothing supplied).
Warning codes: `FOREIGN_ACCOUNT_RECORDS_EXCLUDED`, `RECORDS_REJECTED`, `INVALID_TIMESTAMP_IGNORED`,
`SOURCE_ID_FALLBACK`, `RETRIEVAL_TIME_FALLBACK`, `RECENCY_UNKNOWN`, `RECENCY_TIE`, `FUTURE_TIMESTAMP`.
Items with duplicate IDs are all rejected, so the outcome cannot depend on which copy came first.

## Constraints

- Recency ordering only: never judge source reliability, authority, accuracy, completeness or quality.
- Never apply business policy: no staleness threshold, freshness requirement or source preference is invented.
- Never use a conflict, claim text or classification to influence order; never pick a conflict winner.
- Never rank, count by ID or echo an item from another account.
- Never silently drop a source: sources without a usable timestamp are listed as recency unknown.
- Never treat an invalid timestamp as valid, and never let `retrieved_at` override a data timestamp.
- Never copy record content, titles, claims, excerpts or URIs into the result or diagnostics.
- Never retrieve evidence, call a connector or make a network call; never write to any system.
- Deterministic: identical input gives identical `data`; no clock read when `now` is supplied.
