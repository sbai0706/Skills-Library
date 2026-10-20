# account.resolve

**Version:** 0.2.0 · **Status:** draft · **Business owner:** TBD

Resolve a free-form account reference to exactly one **exactly matching** account, or refuse and
say why. This skill never guesses, never picks the best-looking candidate, and never invents an
account ID.

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
| `resolved` | `success` | Exactly one **exact** match. `data.account` has `account_id`, canonical `name`, and any identifiers the adapter returned. |
| `confirmation_required` | `blocked` | Exactly one credible candidate, but the match is fuzzy or partial-name only. `data.candidates` has it; nothing is accepted until a human confirms. |
| `ambiguous` | `blocked` | Two or more credible accounts. `data.candidates` lists all of them. Ask the user to disambiguate. |
| `not_found` | `blocked` | No credible account. `data.reason` is `account_not_found`; no account data is returned. |
| — | `failed` | Adapter error or invalid input. `data` is `null` and `errors` carries a structured code. |

`data.match` reports how the match was made: `account_id`, `exact_name`, `normalized_name`, or
`domain`, with the numeric score. Every candidate also carries `match_type`
(`account_id`, `exact_name`, `normalized_name`, `domain`, or `fuzzy`) and its score.
`evidence_ids` is always empty: resolving identity produces no evidence claims.

### What may resolve

Only these four reference forms resolve without human confirmation:

1. the canonical account ID (`account_id`);
2. the account name exactly as stored (`exact_name`);
3. the account name after deterministic normalization only (`normalized_name`);
4. an authoritative domain match (`domain`).

Anything else — a partial name, a single shared token, or any other fuzzy match — returns
`blocked` with `confirmation_required`, even when only one candidate is credible and even when
the score is high. A high score is not authority.

## Matching constraints

Deterministic only — no model judgment.

1. Adapter candidates are compared on `account.name` (and `account.domain` when the reference is a domain).
2. Names are normalized: trim, strip diacritics, lowercase, `&` → `and`, punctuation → space,
   remove generic legal suffixes (`inc`, `llc`, `ltd`, `corp`, `plc`, `gmbh`, `the`, …).
3. Score = `0.7 × coverage + 0.3 × precision` over significant tokens.
4. A candidate is **credible** only if score ≥ 0.6, coverage > 0.5, and at least one token matched.
5. Identical scores are ordered by exactness, then `account_id`, so ordering is stable.
6. Exactness is evaluated independently of the score. An exact account ID or authoritative domain
   bypasses the token-credibility gate because it is an identifier, not a name.

If you change any rule, update `match.js`, this section, and `tests/account-resolve.test.js` together.

## Ambiguity and confirmation handling

- **Multiple credible candidates** → always `blocked` with `AMBIGUOUS_ACCOUNT`. Do not pick the
  highest score and do not prefer a candidate you have seen before.
- **One fuzzy or partial candidate** → always `blocked` with `CONFIRMATION_REQUIRED`. Do not treat
  it as resolved and do not pass it to `evidence.retrieve`.
- Relay the candidate identifiers, canonical names, match types, and scores to the user. Request
  an exact account ID or canonical name, then call the skill again.

Candidate lists deliberately expose only `account_id`, `name`, `domain`, `match_type`,
`score`, and `matched_tokens`. Owner, location, contacts, revenue, and other account details are
withheld from unconfirmed candidates.

Never rewrite the reference yourself to force a match, and never retry with a name you invented.

## Failure behavior

| Error code | Meaning | Retry |
| --- | --- | --- |
| `INVALID_INPUT` | Reference missing or blank | After fixing the input |
| `ACCOUNT_NOT_FOUND` | No credible candidate | No — ask the user |
| `AMBIGUOUS_ACCOUNT` | Multiple credible candidates | No — disambiguate |
| `CONFIRMATION_REQUIRED` | Single fuzzy/partial candidate | No — confirm the account |
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

**Partial name — confirmation required**

```json
{ "account_reference": "Northstar" }
```

→ `blocked`, `data.outcome: "confirmation_required"`, one candidate (`sf_clear_001`,
`match_type: "fuzzy"`). Ask the user to confirm, then call again with `"Northstar Logistics"` or
`"sf_clear_001"`, which resolve exactly.

**Exact ID**

```json
{ "account_reference": "sf_clear_001" }
```

→ `success`, `match.method: "account_id"`. Use this whenever the ID is known.
