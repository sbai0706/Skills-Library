# Sales Copilot — Skills Foundation

Working foundation for Sales Copilot with eleven callable skills and five composed workflows:
`account.resolve`, `evidence.retrieve`, `evidence.normalize`, `gap.detect`, `artifact.render`,
`signal.extract`, `stakeholder.map`, `offering.match`, `engagement.draft`, `qualification.assess`,
and `opportunity.strategy`. The workflows are `prepare-first-meeting`,
`prepare-first-meeting-v2`, `prepare-engagement`, `qualification`, and `opportunity-strategy`.

The two v0.2.0 skills carry the earlier policy tightening (exact-match-only account
resolution, fail-closed classification defaults, documented no-retry rule). `evidence.normalize`
converts retrieved raw source records into claim-level evidence records. `gap.detect` reports
question coverage without filling gaps, `artifact.render` produces a cited Markdown brief under a
classification ceiling, and `prepare-first-meeting` composes them in a fixed order with
provenance verification.

Architecture reference: [Sales_Skills_Library_Architecture_v2.md](Sales_Skills_Library_Architecture_v2.md).
That document describes the eventual direction. The repository currently implements the shared
evidence foundation and all four Phase 1 outcome slices as deterministic, fixture-backed library
workflows; this is not a business-validated customer pilot or a live host integration. See the
[Phase 1 acceptance summary](docs/PHASE1_SKILLS_PLAN.md) and
[historical MVP handoff](docs/MVP_HANDOFF.md).

The Account Intelligence skills accept only explicit caller mappings to normalized evidence. They
do not discover signals, infer stakeholder authority, or automatically recommend offerings. The
Engagement, Qualification, and Opportunity Strategy slices likewise produce reviewable drafts,
evidence inventories, and hypotheses—not business approvals or external actions. The default
signal, persona, and offering registries remain provisional fixtures, and the sample offering
entries are placeholders pending business review. See
[workflows/prepare-first-meeting-v2/WORKFLOW.md](workflows/prepare-first-meeting-v2/WORKFLOW.md).

The core skills are plain JavaScript functions with no model-provider dependency. Four selected
repo-local Claude Code wrappers live under `.claude/skills` and invoke the portable fixture CLIs;
see the [agent skills usage guide](docs/AGENT_SKILLS.md) for installation, invocation, and limits.
The wrappers' frontmatter and CLI paths are tested, but Claude Code runtime discovery itself has
not been tested. There is no production agent-host integration.

## Requirements

- Node.js 20 or newer (developed on Node 24)
- npm

## Run the tests

```bash
npm install
npm test
```

`npm test` runs `node --test`, which discovers every file under `tests/`. No external
services, credentials, or network calls are required.

## Portable first-meeting CLI

The v1 CLI is a **development and demonstration interface**. It invokes the existing workflow with
repository fixture adapters and the deterministic fixture claim extractor. It is agent-agnostic,
does not contact live systems, and is not an authorization boundary for production data.

Install dependencies and run the complete suite:

```bash
npm install
npm test
```

Direct invocation:

```bash
npm run prepare-first-meeting -- \
  --account "Northstar Logistics" \
  --sources crm,public_source \
  --classification internal
```

Options are `--account` (required), `--sources` (default `crm,public_source`), `--classification`
(default `internal`), `--template` (default `first-meeting-brief-v1`), `--audience` (default
`internal_sales`), `--fixture`, and `--output json|markdown` (default `json`). The default fixture
is the explicitly documented safe demo `workflow-first-meeting-success`; pass `--fixture` to select
any other supported workflow fixture. `confidential` is never the default. Unknown source IDs,
classification values, audiences, template IDs, or fixture names fail closed. CLI arguments do not
accept roles or permitted-classification overrides; the fixture input's authorization context is
not taken from fixture input files. Retrieval uses the workflow's normal default context and
permission behavior. `--classification` sets only the renderer's output ceiling; it does not grant
retrieval permission or elevate authorization.

The supported fixtures are `workflow-first-meeting-success`, `workflow-first-meeting-ambiguous`,
`workflow-first-meeting-fuzzy-confirmation`, `workflow-first-meeting-missing-account`,
`workflow-first-meeting-sparse`, `workflow-first-meeting-partial-source-failure`,
`workflow-first-meeting-normalization-rejection`, `workflow-first-meeting-conflicted`,
`workflow-first-meeting-classification-filtered`, `workflow-first-meeting-retrieval-failure`, and
`workflow-first-meeting-renderer-failure`.

### Demonstration fixtures

```bash
# 1. Complete successful brief (uses the safe demo fixture)
npm run prepare-first-meeting -- --account "Northstar Logistics"

# 2. Ambiguous account -> blocked
npm run prepare-first-meeting -- --fixture workflow-first-meeting-ambiguous --account "Meridian Health"

# 3. Fuzzy match requires confirmation -> blocked
npm run prepare-first-meeting -- --fixture workflow-first-meeting-fuzzy-confirmation --account "Northstar"

# 4. Sparse evidence -> usable brief
npm run prepare-first-meeting -- --fixture workflow-first-meeting-sparse --account "Lumen Harbor Terminals"

# 5. Partial source failure -> partial brief
npm run prepare-first-meeting -- --fixture workflow-first-meeting-partial-source-failure --account "Cobalt Freight Systems"

# 6. Conflicting evidence is retained for review
npm run prepare-first-meeting -- --fixture workflow-first-meeting-conflicted --account "Halcyon Foods" --sources crm

# 7. Public ceiling filters internal and confidential claims
npm run prepare-first-meeting -- --fixture workflow-first-meeting-classification-filtered --account "Juniper Ridge Energy" --sources crm --classification public

# 8. Total retrieval failure -> failed
npm run prepare-first-meeting -- --fixture workflow-first-meeting-retrieval-failure --account "Rivermark Utilities"
```

`--output json` prints exactly one workflow-result JSON value to stdout; safe diagnostic summaries
go to stderr. The repository `.npmrc` silences npm's lifecycle banner so the documented `npm run`
command preserves that output contract. `--output markdown` prints only the rendered artifact when
available; blocked and failed runs print a concise safe explanation to stderr and no artifact to
stdout.

### Account Intelligence v2 CLI

The additive v2 consumer keeps the v1 workflow, schema, and renderer unchanged. It composes
`signal.extract`, `stakeholder.map`, and `offering.match` from explicit mappings, calls the v2
semantic validator before rendering enrichment, and verifies citations before returning the
artifact:

```bash
npm run prepare-first-meeting-v2 -- --account "Northstar Logistics" --mapping-fixture northstar-example
```

The default `--mapping-fixture none` leaves signal, stakeholder, and offering coverage explicitly
unknown. `northstar-example` is a deterministic illustrative mapping over existing fixture claims;
it is not automated research, approved policy, or a real offering recommendation. `--output
markdown` prints only the final artifact when the workflow succeeds or is partial. The v2 result
does not expose withheld claim IDs.

| Exit code | Meaning |
| --- | --- |
| `0` | Success with usable artifact. |
| `2` | Partial result with usable artifact. |
| `3` | Blocked by an account or workflow gate. |
| `1` | Failed workflow or invalid CLI invocation. |

To move toward live use, a future host can invoke `prepareFirstMeetingV2` with approved adapter and
extractor implementations, explicit caller mappings, and the correct reference registries. All
shipped CLIs remain fixture-only and do not provide live-adapter support.

## Phase 1 outcome workflows

The four outcomes below have portable, fixture-backed skill/workflow implementations. Every
example uses checked-in fixtures and the deterministic claim extractor; it does not search the
web, contact a CRM, send a message, or establish that a caller mapping is true or approved.

| Outcome | Entry points and portable invocation | Current boundary |
|---|---|---|
| [Account Intelligence](workflows/prepare-first-meeting-v2/WORKFLOW.md) | `signal.extract`, `stakeholder.map`, `offering.match`; `npm run prepare-first-meeting-v2 -- --account "Northstar Logistics" --mapping-fixture northstar-example --output json` | Caller supplies all enrichment mappings. Stakeholder roles are explicitly unverified hypotheses; registries are provisional and unsupported coverage stays unknown. |
| [Engagement](workflows/prepare-engagement/WORKFLOW.md) | `engagement.draft`; initial: `npm run prepare-engagement -- --fixture engagement-initial --mode initial --output json`; follow-up: `npm run prepare-engagement -- --fixture engagement-follow-up --mode follow_up --output json` | Produces reviewable drafts only. Follow-up requires cited caller-selected activity; nothing is sent. |
| [Qualification](workflows/qualification/WORKFLOW.md) | `qualification.assess`; `npm run qualification -- --account "Northstar Logistics" --assessment-fixture northstar-provisional --output json` | Inventories evidence for supplied criteria and six event fields. Decisions remain `not_determined`; no approved B-FITT definition or threshold is embedded. |
| [Opportunity Strategy](workflows/opportunity-strategy/WORKFLOW.md) | `opportunity.strategy`; `npm run opportunity-strategy -- --fixture northstar-example --output json` | Produces tentative evidence-linked hypotheses and discovery. Stage readiness is unavailable; no opportunity or CRM change is made. |

These are Skills Library deliverables, not a complete customer pilot. `success` and `partial` are
workflow execution/output statuses, not business approval; CLI exit code `2` means a usable partial
artifact with explicit gaps. See the [Phase 1 plan](docs/PHASE1_SKILLS_PLAN.md) for the acceptance
record, unresolved business rules, and external host dependencies. The four Claude Code wrappers are
selected invocations, not wrappers for every internal skill or every workflow: Account Intelligence
v2 currently has a portable CLI but no `/prepare-first-meeting-v2` wrapper.

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
  first-meeting-brief-input.schema.json   Structured renderer input (structural validation only)
  first-meeting-brief-input-v2.schema.json Additive structured renderer input
  prepare-first-meeting-v2-*.schema.json  V2 workflow and mapping contracts
  prepare-engagement-*.schema.json       Engagement workflow contracts
  engagement-draft-*.schema.json         Engagement skill contracts
  qualification-*.schema.json            Qualification skill/workflow contracts
  opportunity-strategy-*.schema.json     Opportunity Strategy contracts
  first-meeting-brief-input.example.json  Example renderer input used by tests
  workflow-input.schema.json    prepare-first-meeting input contract
  workflow-result.schema.json   prepare-first-meeting result contract
  error.schema.json             Structured error entry
  index.js                      Ajv compilation and validate(name, value)

adapters/
  account-adapter.js            Account adapter interface, JSDoc types, record validation
  fixture-account-adapter.js    In-memory account adapter used by tests and local demos
  evidence-adapter.js           Evidence interface, source/record-type map, envelope validation
  fixture-evidence-adapter.js   In-memory evidence adapter with per-source failure modes
  claim-extractor.js            Claim extractor interface (proposes candidates, never decides)
  fixture-claim-extractor.js    Deterministic extractor reading metadata.claim_candidates_json

bin/
  prepare-first-meeting.js      Portable fixture CLI; invokes the existing workflow
  prepare-first-meeting-v2.js   Portable CLI; invokes the additive Account Intelligence workflow
  prepare-engagement.js         Portable CLI; emits initial/follow-up drafts
  qualification.js              Portable CLI; emits an advisory evidence assessment
  opportunity-strategy.js       Portable CLI; emits a tentative strategy artifact

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

skills/gap-detect/
  SKILL.md                      Agent-facing instructions
  skill.yaml                    Machine-readable contract
  index.js                      Skill entry point (detectGaps)
  validate-input.js             Question, claim, conflict, and version validation
  claims.js                     Claim acceptance and evidence/question linkage
  conflicts.js                  Conflict validation and deterministic conflict IDs
  questions.js                  Deterministic question coverage and status policy
  reference.js                  Reference question-set loader

skills/artifact-render/
  SKILL.md                      Agent-facing instructions
  skill.yaml                    Machine-readable contract
  index.js                      Skill entry point (renderArtifact)
  validate-input.js             Structural input validation
  templates.js                  Template registry; unknown IDs fail structurally
  first-meeting-brief.js        Deterministic Markdown brief renderer
  first-meeting-brief-v2.js     Semantically validated Account Intelligence renderer
  reference.js                  Reference question-set loader

workflows/prepare-first-meeting/
  WORKFLOW.md                   Agent-facing workflow instructions
  workflow.yaml                 Machine-readable workflow contract
  index.js                      Fixed sequential composition and status aggregation
  validate-input.js             Input defaults and validation
  provenance.js                 Citation/omission provenance invariants
  reference.js                  Reference question-set loader

skills/signal-extract/
skills/stakeholder-map/
skills/offering-match/
  SKILL.md, skill.yaml, validate-input.js, and index.js for explicit mapping skills

skills/engagement/
  SKILL.md, skill.yaml, index.js for reviewable message and meeting drafts

skills/qualification-assess/
  SKILL.md, index.js for criterion/event evidence inventory without a qualification decision

skills/opportunity-strategy/
  SKILL.md, index.js, render.js for evidence-linked hypotheses and discovery

workflows/prepare-first-meeting-v2/
  WORKFLOW.md                   Account Intelligence v2 workflow contract and invocation
  workflow.yaml                 Machine-readable workflow contract
  index.js                      Additive workflow composition and v2 validation

workflows/prepare-engagement/
  WORKFLOW.md                   Initial and follow-up draft workflow contract
  workflow.yaml                 Machine-readable workflow contract
  index.js                      Evidence-backed draft composition; no sending

workflows/qualification/
  WORKFLOW.md                   Qualification evidence workflow contract
  index.js                      Account/evidence normalization plus qualification.assess

workflows/opportunity-strategy/
  WORKFLOW.md                   Opportunity Strategy contract and invocation
  workflow.yaml                 Machine-readable workflow contract
  index.js                      Composes the actual Qualification assessor and strategy

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
  gap-*/                        Gap coverage, conflict, rejection, and empty-claim fixtures
  brief-*/                      Renderer golden, sparse, partial, conflict, classification, template fixtures
  workflow-first-meeting-*/     End-to-end workflow scenarios: input.json, expected.json, accounts.json, sources.json
  engagement-*/                 Initial, follow-up, sparse, empty, and conflict draft scenarios
  qualification-event/          Provisional criteria/event evidence mapping
  opportunity-strategy/         Caller mapping fixture for a provisional offering hypothesis

reference/
  first-meeting-questions.yaml  Draft reference questions used by gap detection and rendering

docs/
  AGENT_SKILLS.md              Repo-local Claude Code wrapper installation and usage
  PHASE1_SKILLS_PLAN.md         Current four-outcome acceptance summary and unresolved dependencies
  MVP_HANDOFF.md                Frozen contracts and original parallel implementation handoff

.claude/skills/
  prepare-first-meeting/        Claude Code project wrapper for the v1 fixture CLI
  prepare-engagement/           Initial/follow-up draft wrapper
  qualification/                Advisory evidence-assessment wrapper
  opportunity-strategy/         Tentative strategy wrapper

tests/
  schemas.test.js               Envelope, evidence, source-record, and error schema tests
  account-resolve.test.js       account.resolve behavior, fixture cases, adapter failures
  evidence-retrieve.test.js     evidence.retrieve behavior, multi-source, authorization, ordering
  evidence-normalize.test.js    evidence.normalize claims, support rules, conflicts, dedup, extractor failures
  gap-detect.test.js            Gap statuses, conflicts, rejections, ordering, determinism
  artifact-render.test.js       Rendering, classification filtering, leakage, templates, determinism
  prepare-first-meeting.test.js Workflow fixtures, stopping rules, provenance, diagnostics, determinism
  prepare-first-meeting-cli.test.js CLI output, argument, status, leakage, and cwd behavior
  integration-contracts.test.js Gap result, brief input, workflow, and timestamp schema validation
  contracts.test.js             skill.yaml/SKILL.md contract checks for every skill
  reference.test.js             Structure and integrity of the reference questions
  engagement.test.js            Draft boundary, classification, source, and replay coverage
  qualification.test.js         Six-field evidence assessment and safe-reference coverage
  opportunity-strategy.test.js  Strategy composition, provenance, ceiling, and CLI coverage
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

### gap.detect and artifact.render

```js
import { detectGaps } from "./skills/gap-detect/index.js";
import { renderArtifact } from "./skills/artifact-render/index.js";

const gaps = await detectGaps({ account_id, claims, conflicts });
const brief = await renderArtifact({
  account,
  claims,
  gap_result: gaps.data,
  warnings: [],
  output_template_id: "first-meeting-brief-v1",
  audience: "internal_sales",
  classification_ceiling: "internal",
});

// gaps.data.questions            answered/partial/unanswered/conflicted per question
// gaps.evidence_ids              sorted supporting claim IDs
// brief.data.rendered_artifact   deterministic cited Markdown
// brief.data.omitted_evidence_ids claims withheld by the classification ceiling
```

### prepare-first-meeting

```js
import { prepareFirstMeeting } from "./workflows/prepare-first-meeting/index.js";
import { createFixtureAccountAdapter } from "./adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "./adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "./adapters/fixture-claim-extractor.js";

const result = await prepareFirstMeeting(
  { account_reference: "Northstar Logistics", classification_ceiling: "internal" },
  {
    accountAdapter: createFixtureAccountAdapter({ fixture: "workflow-first-meeting-success" }),
    evidenceAdapter: createFixtureEvidenceAdapter({ fixture: "workflow-first-meeting-success" }),
    claimExtractor: createFixtureClaimExtractor(),
  },
);

// result.status                  success | partial | blocked | failed
// result.artifact                cited Markdown, or null on blocked/failed
// result.evidence_ids            exactly the citations in the artifact
// result.omitted_evidence_ids    exactly the claims withheld by classification
```

See [the workflow contract](workflows/prepare-first-meeting/WORKFLOW.md) for stopping rules,
status aggregation, diagnostic handling, and provenance invariants.

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
- **The workflow verifies its artifact.** It composes the skills in fixed order, stops on a
  block or failure, and checks citations and classification omissions before returning a brief.

## Shared-contract history

The original foundation added the following error codes additively:

| Code | Added for |
| --- | --- |
| `UNSUPPORTED_SOURCE` | Unknown or unavailable requested source |
| `CONFIRMATION_REQUIRED` | Fuzzy/partial account match that needs human confirmation |
| `CLASSIFICATION_RESTRICTED` | Records withheld by the access-classification policy |
| `EXTRACTOR_UNAVAILABLE` | Claim extractor failed or threw for a record |
| `EXTRACTOR_MALFORMED_RESPONSE` | Claim extractor returned an unusable envelope |

The Account Intelligence, Engagement, Qualification, and Opportunity Strategy slices extend the
same enum. See [`schemas/error.schema.json`](schemas/error.schema.json) for the current full set;
the shared result envelope remains common to all skills.

`schemas/evidence.schema.json` gained optional `question_ids` and `occurred_at`; source records
gained optional `published_at` to distinguish publication time from event/occurrence time. These
are additive, and prior records remain valid. Normalization maps the timestamp fields one-to-one.

The gap and renderer use `gap-result.schema.json` and `first-meeting-brief-input.schema.json`.
The latter was changed from enforcing classification ceilings in the schema to structural
validation: `artifact.render` filters claims and the workflow verifies its omissions. This is a
semantically significant change to the originally frozen contract and requires owner review.
The workflow has separate input and result schemas; the shared skill envelope is unchanged.

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

## Remaining work and limits

The four Phase 1 outcomes have fixture-backed library workflows, but business validation and a
production pilot are not complete. Approved B-FITT dimensions/criteria, qualification thresholds,
event verification and urgency rules, stage mappings/advancement gates, personas, offerings, and
messaging guidance remain business-owned inputs; the library does not invent them. Automated
source discovery, model-backed claim extraction, live Salesforce/web/document connectivity,
authorization, approval UI, CRM writeback, message sending, additional artifact formats, and
broader orchestration remain outside the current implementation.
