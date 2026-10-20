# account.resolve

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Resolve a free-form account reference to exactly one credible account, or refuse and say why.
This skill never guesses and never invents an account ID.

## When to use

- You have a human-written account reference (name, partial name, or domain) and need a stable account ID.
- A downstream step requires account identity before it can retrieve evidence or read CRM records.

## When not to use

- You already hold a verified account ID from a trusted source.
- You need to create, edit, or merge accounts. This skill is read-only.
- You need to retrieve evidence about an account. Resolve identity first, then call the retrieval skill.
- The reference is a person, an opportunity, or an unrelated company you only heard about second-hand.

## Input

Required: `account_reference` — a non-empty string.

```json
{ "account_reference": "Northstar" }
```

The adapter receives the name portion of the reference (text before `,`, `;`, or `(`) plus a
limit. A bare domain is passed through unchanged.

## Output behavior

Results follow `schemas/skill-result.schema.json`; `data.outcome` is one of:

| outcome | status | Meaning |
| --- | --- | --- |
| `resolved` | `success` | Exactly one credible account. `data.account` has `account_id`, canonical `name`, and any identifiers the adapter returned. |
| `ambiguous` | `blocked` | Two or more credible accounts. `data.candidates` lists all of them with scores. Ask the user to disambiguate. |
| `not_found` | `blocked` | No credible account. `data.reason` is `account_not_found`; no account data is returned. |
| — | `failed` | Adapter error or invalid input. `data` is `null` and `errors` carries a structured code. |

`data.match` reports how the match was made: `exact_name`, `normalized_name`, `domain`, or
`token_match`, with the numeric score. A non-exact match adds a `FUZZY_MATCH` warning.
`evidence_ids` is always empty: resolving identity produces no evidence claims.

## Matching constraints

Deterministic only — no model judgment.

1. Adapter candidates are compared on `account.name` (and `account.domain` when the reference is a domain).
2. Names are normalized: trim, strip diacritics, lowercase, `&` → `and`, punctuation → space,
   remove generic legal suffixes (`inc`, `llc`, `ltd`, `corp`, `plc`, `gmbh`, `the`, …).
3. Score = `0.7 × coverage + 0.3 × precision` over significant tokens.
4. A candidate is **credible** only if score ≥ 0.6, coverage > 0.5, and at least one token matched.
5. Identical scores are ordered by normalized-name equality, then `account_id`, so ordering is stable.

If you change any rule, update `match.js`, this section, and `tests/account-resolve.test.js` together.

## Ambiguity handling

More than one credible candidate is always `blocked` with `AMBIGUOUS_ACCOUNT`. Do not pick the
highest score, do not prefer the one you have seen before, and do not ask the skill to retry with a
rewritten name. Relay the candidate list to the user and request a domain, location, or account ID.
If the user supplies one, call the skill again with that reference.

## Failure behavior

| Error code | Meaning | Retry |
| --- | --- | --- |
| `INVALID_INPUT` | Reference missing or blank | After fixing the input |
| `ACCOUNT_NOT_FOUND` | No credible candidate | No — ask the user |
| `AMBIGUOUS_ACCOUNT` | Multiple credible candidates | No — disambiguate |
| `ADAPTER_UNAUTHORIZED` | Caller lacks permission | No — escalate access |
| `ADAPTER_UNAVAILABLE` | Transport or timeout failure | Yes — after the adapter recovers |
| `ADAPTER_MALFORMED_RESPONSE` | Adapter returned unusable data | No — report the defect |
| `INTERNAL_ERROR` | Unexpected defect | No — report it |

A failed result has `data: null`. Never fill it in from conversation history or from a plausible
name: an invented account ID is a data-integrity incident.

## Examples

**Exact match**

```json
{ "account_reference": "Northstar Logistics" }
```

→ `success`, `data.outcome: "resolved"`, `data.account.account_id: "sf_clear_001"`, `match.method: "exact_name"`.

**Ambiguous**

```json
{ "account_reference": "Meridian Health" }
```

→ `blocked`, `data.outcome: "ambiguous"`, candidates `sf_amb_001` and `sf_amb_002`.
Ask: "Which Meridian Health entity — Boston or Denver?"

**Not found**

```json
{ "account_reference": "Aurora Grid" }
```

→ `blocked`, `data.outcome: "not_found"`. State that no account matched; do not substitute a similar
account without the user's confirmation.
