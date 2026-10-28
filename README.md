# Sales Copilot — Skills Foundation

Minimal, working foundation for Sales Copilot skills with three implemented capabilities:
`account.resolve` (v0.2.0), `evidence.retrieve` (v0.2.0), and `evidence.normalize` (v0.1.0).

The two v0.2.0 skills carry the earlier policy tightening (exact-match-only account
resolution, fail-closed classification defaults, documented no-retry rule). `evidence.normalize`
converts retrieved raw source records into claim-level evidence records. The repository
intentionally implements only what these capabilities need.

Architecture reference: [Sales_Skills_Library_Architecture_v2.md](Sales_Skills_Library_Architecture_v2.md).
That document describes the eventual direction; this repository implements only the shared
contracts and these three skills. See [docs/MVP_HANDOFF.md](docs/MVP_HANDOFF.md) for frozen contracts and the parallel `gap.detect` / `artifact.render` handoff.

The skills are plain JavaScript functions. There is no agent-platform integration, no prompt
parsing, and no model provider dependency. `SKILL.md` is the agent-facing description;
`index.js`, the schemas, and the adapters are the portable implementation.

## Requirements

- Node.js 20 or newer (developed on Node 24)
- npm

## Run the tests

```bash
npm install
npm test
```

`npm test` runs `node --test`, which discovers every file under `tests/`. No external
services, credentials, or network calls are required. Current suite: 139 tests. See [the implementation handoff](docs/MVP_HANDOFF.md) for the exact baseline command and task boundaries.

## Layout

```text
schemas/
  skill-result.schema.json      Shared result envelope for every skill
  evidence.schema.json          Common evidence record for later skills
  evidence.example.json         One valid evidence record used by the tests
  source-record.schema.json     Raw retrieved source record (input to evidence.normalize)
  source-record.example.json    One valid raw source record used by the tests
  gap-result.schema.json        Structured answer/gap/conflict status per question
  gap-result.example.json       Example gap result used by tests
  first-meeting-brief-input.schema.json   Structured inputs for a future renderer
  first-meeting-brief-input.example.json  Example renderer input used by tests
  error.schema.json             Structured error entry
  index.js                      Ajv compilation and validate(name, value)

adapters/
  account-adapter.js            Account adapter interface, JSDoc types, record validation
  fixture-account-adapter.js    In-memory account adapter used by tests and local demos
  evidence-adapter.js           Evidence interface, source/record-type map, envelope validation
  fixture-evidence-adapter.js   In-memory evidence adapter with per-source failure modes
  claim-extractor.js            Claim extractor interface (proposes candidates, never decides)
  fixture-claim-extractor.js    Deterministic extractor reading metadata.claim_candidates_json

skills/account-resolve/
  SKILL.md                      Agent-facing instructions
  skill.yaml                    Machine-readable contract
  index.js                      Skill entry point (resolveAccount)
  match.js                      Deterministic scoring and credibility rules
  normalize.js                  Name/domain normalization
  search.js                     Adapter call wrapper and response normalization

skills/evidence-retrieve/
  SKILL.md                      Agent-facing instructions
  skill.yaml                    Machine-readable contract
  index.js                      Skill entry point (retrieveEvidence)
  validate-input.js             Request validation, including unknown-source rejection
  records.js                    Record validation, deduplication, ordering, classification filter

skills/evidence-normalize/
  SKILL.md                      Agent-facing instructions
  skill.yaml                    Machine-readable contract
  index.js                      Skill entry point (normalizeEvidence)
  validate-input.js             Request-level validation (account_id, records array)
  records.js                    Record validation and candidate claim checking
  claims.js                     Claim IDs, classification policy, dedup, conflict detection
  text.js                       Deterministic comparison utilities (support, excerpt matching)

fixtures/
  clear-account/                Account fixtures: accounts.json + expected.json
  ambiguous-account/
  missing-account/
  evidence-complete/            Evidence fixtures: sources.json + expected.json
  evidence-sparse/
  evidence-partial-source-failure/
  evidence-unauthorized/
  normalize-single-source/      Normalization fixtures: records.json + expected.json
  normalize-multiple-claims/
  normalize-duplicate/
  normalize-conflicting/
  normalize-unsupported/
  normalize-classification/
  normalize-empty/

reference/
  first-meeting-questions.yaml  Draft reference questions for the future first-meeting workflow

docs/
  MVP_HANDOFF.md                Frozen contracts and parallel implementation handoff

tests/
  schemas.test.js               Envelope, evidence, source-record, and error schema tests
  account-resolve.test.js       account.resolve behavior, fixture cases, adapter failures
  evidence-retrieve.test.js     evidence.retrieve behavior, multi-source, authorization, ordering
  evidence-normalize.test.js    evidence.normalize claims, support rules, conflicts, dedup, extractor failures
  integration-contracts.test.js Gap result, brief input, and timestamp schema validation
  contracts.test.js             skill.yaml/SKILL.md contract checks for every skill
  reference.test.js             Structure and integrity of the reference questions
```

## Using the skills in code

### account.resolve

```js
import { resolveAccount } from "./skills/account-resolve/index.js";
import { createFixtureAccountAdapter } from "./adapters/fixture-account-adapter.js";

const adapter = createFixtureAccountAdapter({ fixture: "ambiguous-account" });
const result = await resolveAccount({ account_reference: "Meridian Health" }, { adapter });

// result.status === "blocked"
// result.data.outcome === "ambiguous"
// result.data.candidates has both credible accounts
```

It depends only on `{ name, searchAccounts(query, options) }`, so a Salesforce or HTTP adapter
can replace the fixture adapter without changing the skill or its contract.

### evidence.retrieve

```js
import { retrieveEvidence } from "./skills/evidence-retrieve/index.js";
import { createFixtureEvidenceAdapter } from "./adapters/fixture-evidence-adapter.js";

const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-partial-source-failure" });
const result = await retrieveEvidence(
  {
    account_id: "sf_clear_001",
    questions: [{ id: "FM-REL-001", text: "Which prior activity exists for this account?" }],
    requested_sources: ["crm", "public_source"],
  },
  { adapter },
);

// result.status === "partial"          (public source timed out)
// result.data.records                  CRM records only, as raw source data
// result.errors[0].details.source      "public_source"
```

It depends only on `{ name, supportedSources, retrieve(request) }`. Records follow
`schemas/source-record.schema.json` and contain no claim, confidence, or verification fields.

### evidence.normalize

```js
import { normalizeEvidence } from "./skills/evidence-normalize/index.js";
import { createFixtureClaimExtractor } from "./adapters/fixture-claim-extractor.js";

const extractor = createFixtureClaimExtractor();
const result = await normalizeEvidence(
  { account_id: "acct_northstar", records: retrievedRecords },
  { extractor },
);

// result.status === "success"
// result.data.claims                 evidence records, each validated against evidence.schema.json
// result.data.rejected_records       structured rejections with reason codes
// result.data.conflicts              contradictions, preserved without a winner
// result.evidence_ids === claims.map((c) => c.claim_id)
```

It depends only on `{ name, extract(record) }` implementing `adapters/claim-extractor.js`. The
fixture extractor reads explicit candidate claims from the record's flat
`metadata.claim_candidates_json` string; it parses no prose. A model-backed extractor can
replace it without changing the skill's input or output contract.

## Design decisions

- **Node.js + `node:test`** because no stack existed when work started and the built-in runner
  needs no framework. Only three small dependencies are used: `ajv` and `ajv-formats` (schema
  validation) and `yaml` (reference data).
- **`additionalProperties: false`** on all contracts so extra fields fail loudly instead of
  drifting.
- **Skill directories use kebab-case** (`evidence-retrieve`) while the contract name stays
  namespaced (`evidence.retrieve`), matching the architecture document's skill identifiers.
- **No workflow engine, registry, router, or orchestrator.** Each skill is one exported function
  that takes an input object and a dependency object.
- **Adapters never throw for runtime failures**; they return `{ok:false, error}` so the skill can
  map failures to stable error codes. A thrown error is still normalized, never propagated.
- **Matching is deterministic and conservative** (`account.resolve`): normalization, token
  coverage/precision scoring, a fixed 0.6 credibility floor, and "more than one credible
  candidate" always producing a blocked result.
- **Schema pattern**: `status` and `outcome` are separate. `status` is the shared envelope
  lifecycle; `data.outcome` is the skill-specific business outcome.
- **Source records are not evidence claims.** `evidence.retrieve` returns raw records; converting
  them to claim-level evidence is a separate, later skill.
- **Per-source isolation.** Each requested source is retrieved independently, so one failure
  yields a `partial` result that preserves the other sources' records.
- **Authorization denial leaks nothing.** A denied source contributes no records and no text to
  any field of the result; its outcome is reported, not its content.
- **Classification is fail-closed.** Omitting `context.permitted_classifications` permits only
  `public` and `internal`; an explicit empty array permits nothing; `confidential` requires
  explicit inclusion; an unrecognized classification is withheld and reported, never treated as
  public. Withheld records surface as aggregate counts only.
- **Exactness, not score, authorizes resolution.** Only an exact account ID, canonical name,
  normalized name, or authoritative domain resolves. A single fuzzy or partial-name candidate
  returns `blocked` with `confirmation_required`.
- **Malformed payloads are non-retryable.** The skills never retry; a deterministic adapter
  defect is reported with `retryable: false`. Only `ADAPTER_UNAVAILABLE` is retryable, and a
  future live adapter may retry transient transport failures internally.
- **Empty is not failure.** A successful retrieval with zero records is `success` with a
  `NO_RECORDS_RETRIEVED` warning, never an execution failure and never a claim of absence.
- **The extractor proposes; the skill decides** (`evidence.normalize`). Candidate claims come
  from a pluggable `claim-extractor` interface. The skill alone owns direct-support checking,
  classification policy, deduplication, conflicts, rejection, and output construction, so a
  model-backed extractor can never bypass the support rules.
- **Direct support is machine-checked, not judged.** A claim is emitted only when its excerpt
  appears verbatim in the record content (whitespace-run differences aside) and every
  significant claim token occurs in the excerpt. Unsupported candidates are rejected, never
  "cleaned up".
- **Contradictions are preserved, never adjudicated.** Conflicting claims are both kept, both
  marked `conflicting`, and linked through a conflict entry. No winner is selected.
- **Cross-record agreement is not collapsed.** Identical claim text from different records
  stays as separate claims with separate provenance; independent corroboration is never
  discarded to shorten output.

## Shared-contract change

`schemas/error.schema.json` gained five enum members across revisions, each additive:

| Code | Added for |
| --- | --- |
| `UNSUPPORTED_SOURCE` | Unknown or unavailable requested source |
| `CONFIRMATION_REQUIRED` | Fuzzy/partial account match that needs human confirmation |
| `CLASSIFICATION_RESTRICTED` | Records withheld by the access-classification policy |
| `EXTRACTOR_UNAVAILABLE` | Claim extractor failed or threw for a record |
| `EXTRACTOR_MALFORMED_RESPONSE` | Claim extractor returned an unusable envelope |

`schemas/evidence.schema.json` gained optional `question_ids` and `occurred_at`; source records
gained optional `published_at` to distinguish publication time from event/occurrence time. These
are additive, and prior records remain valid. Normalization maps the timestamp fields one-to-one.

Two integration schemas are now available: `gap-result.schema.json` (safe per-question status,
evidence IDs, reason codes, conflicts, counts) and `first-meeting-brief-input.schema.json`
(structured identity, claims, gaps, warnings, template, audience, and classification ceiling).
They define contracts only; neither next skill is implemented. No field was removed or renamed,
and the shared result envelope is unchanged.

## Assumptions

1. Account matching is name/domain based. No aliases, subsidiaries, or parent-company
   relationships are modeled.
2. The adapter is responsible for authorization, record-level scope, pagination, and rate
   limiting. The skill only forwards and maps errors.
3. `account_reference` is free text entered by a user. A bare domain is treated as a domain;
   anything else is treated as an account name.
4. Reference questions are drafts owned by `TBD`; they are not approved business rules.
5. Timestamps are UTC ISO-8601. `trace_id` is generated per skill execution.
6. Fixtures and example domains use the reserved `.example` TLD; nothing calls a live service.
7. **Only fixture adapters exist.** There is no Salesforce, SharePoint, or web connector, and
   only the fixture claim extractor exists; no model provider is contacted.
8. `evidence.retrieve` treats `requested_sources` as a closed set (`crm`, `public_source`,
   `internal_document`). An unknown value fails the request rather than being ignored.
9. The adapter, not the skill, decides which records are relevant to a question; the skill rejects
   records that cite a question ID outside the request.
10. Record ordering is `source_type`, then `occurred_at` (unknown first), then `record_id`.
11. Confidence is placed in the classification list, not in the model: the default is
    `[public, internal]` and confidential access is always an explicit caller decision.
12. `evidence.normalize` preserves source `published_at` as claim `published_at` and source
    `occurred_at` as claim `occurred_at`; it never substitutes one for the other. The
    source-record schema supports both fields when a source has both.
13. Candidate claims in fixtures live in `metadata.claim_candidates_json` (a JSON string)
    because the source-record schema restricts metadata values to flat scalars.
14. `corroborated` is never emitted: cross-record agreement yields separate claims with
    separate provenance rather than a merged corroborated record.

## Open business questions

1. Who owns and approves the first-meeting question set (`business_owner: TBD`)?
2. Which roles may resolve accounts, and what record scope applies (`permitted_roles` is
   provisional)?
3. Should inactive or archived accounts be excluded from matching? The adapter currently passes
   them through and the skill does not filter them.
4. What is the authoritative identifier set for an account (domain, DUNS, ERP ID, Salesforce ID)?
5. ~~Should a fuzzy match require explicit user confirmation before downstream evidence
   retrieval?~~ **Resolved:** fuzzy and partial-name matches now return `blocked` with
   `confirmation_required` and never resolve.
6. What freshness window applies to the account directory cache, if one is added?
7. Who may read `confidential` source records? The default now permits only `public` and
   `internal`; the role-to-classification mapping is still provisional.
8. Should a source that returns only malformed records be retried automatically, or always require
   operator review? It currently returns `failed` for that source, non-retryable, with no retry.
9. Which public-research sources are approved, and what citation metadata must their records carry
   before `evidence.normalize` accepts them?
10. Who owns the claim-extractor policy? When a model-backed extractor is approved, its
    candidate-output contract (`adapters/claim-extractor.js`) is the point of review: the skill's
    support rules stay the same, but the extractor's proposal quality becomes a governance item.
11. Should cross-record agreement ever be merged into a single `corroborated` claim? The current
    policy keeps separate claims with separate provenance; merging would require a small
    evidence-schema extension and a business decision about which source leads.
12. What is the escalation path when a conflict (`conflicting` claims) must be resolved before a
    customer-facing artifact may render? Today conflicts are surfaced for a human; no skill
    adjudicates them.

## Deferred work

Gap detection, artifact rendering, workflow composition, Salesforce connectivity, web retrieval,
meeting briefs, B-FITT, qualification, CRM writeback, approvals, model-driven routing, UI, and
orchestration are intentionally not implemented. Model-backed claim extraction is deferred: the
interface exists (`adapters/claim-extractor.js`) but only the deterministic fixture extractor
implements it. Only the interfaces needed to keep `account.resolve`, `evidence.retrieve`, and
`evidence.normalize` independent of their fixture adapters and extractor exist.
