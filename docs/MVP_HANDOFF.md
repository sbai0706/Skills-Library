# Sales Copilot MVP implementation handoff

> **Historical handoff:** `gap.detect`, `artifact.render`, and the `prepare-first-meeting`
> workflow have since been implemented. The original task boundaries and baseline below are
> retained for context. Integration changed the frozen renderer input schema to structural-only
> validation; the renderer applies the classification ceiling and the workflow verifies its
> omissions. This semantically significant change needs contract-owner review. See the
> [workflow documentation](../workflows/prepare-first-meeting/WORKFLOW.md) for current behavior.
> `bin/prepare-first-meeting.js` is now the portable CLI/host boundary: it parses CLI options,
> constructs fixture dependencies, invokes the workflow, and formats process output. Workflow
> behavior remains in the workflow module; the CLI adds no matching, retrieval, extraction, gap,
> rendering, or classification policy.

This is the working handoff for the next parallel skill tasks. It records current contracts and decisions; it is not a replacement for the [architecture reference](../Sales_Skills_Library_Architecture_v2.md).

## Objective and implementation boundary

The MVP is building portable, testable capabilities for a cited first-meeting research brief. The currently implemented skills are:

- `account.resolve` — resolves only exact account identifiers/names/domains; fuzzy matches block for confirmation.
- `evidence.retrieve` — retrieves raw, account-scoped source records through an adapter.
- `evidence.normalize` — converts explicit extractor candidates into validated claim-level evidence with provenance.

The library is **agent-agnostic**. `SKILL.md` is the agent-facing layer; ordinary JavaScript functions, JSON Schemas, and adapter interfaces are the portable implementation. There is no agent runtime, platform-specific integration, model SDK, or live connector. Fixture adapters and the fixture claim extractor are the only implementations.

## Canonical result and data contracts

Every skill returns the shared envelope in [skill-result.schema.json](../schemas/skill-result.schema.json): `skill`, `skill_version`, `status`, `data`, `evidence_ids`, `warnings`, `errors`, `trace_id`, `started_at`, and `finished_at`. Statuses are `success`, `partial`, `blocked`, and `failed`; do not create a parallel envelope.

- [source-record.schema.json](../schemas/source-record.schema.json) is the raw retrieved record contract. It includes source/account IDs, source type, title, raw content, URI, timestamps, access classification, question IDs, and flat scalar metadata. It is not a claim.
- [evidence.schema.json](../schemas/evidence.schema.json) is the normalized claim contract. It requires claim ID/text, source/account provenance, retrieval time, excerpt, confidence, verification status, and classification. Optional `question_ids` are provenance only.
- Timestamp semantics are distinct: source `published_at` maps only to claim `published_at`; source `occurred_at` maps only to claim `occurred_at`. Both may be present. Neither substitutes for the other. The source-record schema gained optional `published_at`; the evidence schema gained optional `occurred_at`. Older records remain valid.
- [gap-result.schema.json](../schemas/gap-result.schema.json) represents per-question status, evidence IDs, safe reason codes, conflict IDs, and counts. Its missing-evidence descriptions are allowlisted generic text; it carries no claim text or generated prose conclusions.
- [first-meeting-brief-input.schema.json](../schemas/first-meeting-brief-input.schema.json) is the structured renderer input: account identity, normalized claims, gap result, optional warnings, template ID, audience, and classification ceiling. It rejects arbitrary raw source-record fields and enforces the ceiling for claims.

The gap and brief schemas are integration contracts, not implementations of `gap.detect` or `artifact.render`.

## Adapter and extractor boundaries

- Account lookup uses `adapters/account-adapter.js`; evidence retrieval uses `adapters/evidence-adapter.js`. Their fixture implementations do no network access. Adapters enforce authorization and return structured `{ok, error}` failures; the skills never perform retries.
- Claim extraction uses `adapters/claim-extractor.js`. The fixture-only implementation reads `metadata.claim_candidates_json`, a JSON string stored in flat metadata because the source-record schema allows scalar metadata values only. It does not interpret prose.
- A future model-backed extractor must implement the existing extractor interface. It may propose candidates, but `evidence.normalize` continues to own support validation, provenance, classification, confidence, deduplication, conflict detection, and output construction. Do not add a model SDK or bypass those checks.

## Portable CLI host boundary

- `npm run prepare-first-meeting -- --account "Northstar Logistics"` invokes the existing workflow. It is a fixture-only development and demonstration interface, not a production authorization boundary.
- The CLI explicitly selects one of the checked-in `workflow-first-meeting-*` fixtures (or uses the documented safe success demo), creates the fixture account/evidence adapters and fixture extractor, then calls `prepareFirstMeeting`.
- `--output json` writes one workflow result to stdout and diagnostic summaries to stderr. `--output markdown` writes an artifact only for success/partial results; blocked/failed results provide a safe stderr explanation.
- Exit codes are `0` success, `2` partial with artifact, `3` blocked, and `1` failed or invalid invocation.
- It does not accept caller-supplied roles or permitted classifications, and confidential is not a default. Unknown sources/templates fail through the existing workflow and renderer validation.
- A future host replaces fixture dependency construction with approved implementations of the existing adapter and extractor interfaces; the workflow stays the composition boundary.

## Policies to preserve

- **Classification:** `evidence.retrieve` defaults omitted `permitted_classifications` to `[public, internal]`; an explicit empty array permits nothing; `confidential` requires explicit inclusion and adapter authorization. Unknown classifications are withheld, never treated as public. Withheld records expose aggregate counts only, not IDs, titles, content, or metadata. `evidence.normalize` inherits record classification or raises it; it never lowers it.
- **Account identity:** only exact canonical account ID, exact canonical name, exact normalized name, or authoritative exact domain resolves. A fuzzy/partial match returns `blocked` / `confirmation_required`; multiple candidates remain `ambiguous`. Unconfirmed candidates contain only ID, name, domain, match type, score, and matched tokens—no restricted account details.
- **Claim support:** excerpt must occur in content verbatim, allowing whitespace-run normalization only. Every significant claim token must occur in the excerpt. Unsupported candidates are rejected, not repaired. `inferred` and `low` confidence are not emitted.
- **Conflicts:** preserve both direct claims, mark both `conflicting`, and link claim IDs; never choose a winner or combine them.
- **Diagnostics:** rejection reasons and gap reason codes are structured and safe. Never copy confidential claim text into diagnostics.

## Provenance and deterministic identifiers

Every claim points to one `source_record_id` and carries source URI/type, account ID, available publication and occurrence timestamps separately, retrieval timestamp, exact supporting excerpt, and classification. Claim IDs are stable: `clm_` plus the first 16 hex characters of SHA-256 over `account_id|source_record_id|normalized claim text`. Timestamp fields are not part of this derivation. Duplicate candidate text within one record is removed; equal text from different records stays separate with independent provenance. Conflict IDs are derived from sorted claim IDs.

## Fixture and test conventions

- Each scenario lives in `fixtures/<scenario>/` with nonempty `records.json` or `sources.json` and `expected.json`. Use fictional entities and reserved `.example` domains; do not make test behavior depend on services or the wall clock.
- Node.js built-in `node:test` is the test framework. From the repository root, enter `Skills Library` and run `npm test`.
- Baseline after this handoff work: **139 tests, 139 passing, 0 failing**.

## Assumptions and known limitations

- Reference questions in [first-meeting-questions.yaml](../reference/first-meeting-questions.yaml) are draft (`0.1.0`), with `business_owner: TBD`; they are not approved business policy.
- Only fixture adapters and the deterministic fixture extractor exist. There is no Salesforce, public-web, SharePoint, or other live connectivity.
- `evidence.normalize` uses conservative token support rather than unrestricted semantic inference; fixture candidates are explicit. The extractor boundary is the replacement point for future prose interpretation.
- Cross-record equivalent claims are separate records, not merged into `corroborated` claims. Gap-result summary counts must agree with question statuses; JSON Schema validation alone does not enforce arithmetic consistency.
- Authorization scope/role mapping, public source approval, freshness, and business ownership remain provisional.

## Frozen shared contracts

The following files are frozen for the parallel `gap.detect` and `artifact.render` branches:

- `schemas/skill-result.schema.json`
- `schemas/error.schema.json`
- `schemas/source-record.schema.json`
- `schemas/evidence.schema.json`
- `schemas/gap-result.schema.json`
- `schemas/first-meeting-brief-input.schema.json`
- `reference/first-meeting-questions.yaml`

Frozen means: **stop and report a blocker before any breaking or semantically significant change**. Do not reinterpret timestamp semantics, status meanings, classification rules, evidence IDs, question IDs, or audience/ceiling behavior in a branch. Additive changes also require coordination if they affect the other branch's contract.

## Exact next tasks

1. **`gap.detect`** — implement a portable function that consumes the reference question set and normalized claims for one account; return a result that validates against `gap-result.schema.json`. Use evidence IDs to classify each stable question ID as answered/partial/unanswered/conflicted. Emit only the safe reason codes and generic missing-evidence descriptions. Do not copy claim text, generate conclusions, answer questions in prose, or resolve conflicts.
2. **`artifact.render`** — implement a portable renderer that consumes `first-meeting-brief-input.schema.json`. Render only structured identity, claims, gaps, and warnings; honor the audience and classification ceiling. Do not retrieve, normalize, answer questions, accept raw source records, or introduce a workflow.

Do not implement workflow composition, live connectors, platform integrations, or another skill as part of these tasks.

## Input replaceability audit (2026-10-30)

The input boundaries were statically and end-to-end checked with an in-memory MCP-like replay client. Account lookup, evidence retrieval, and claim extraction remain replaceable through the existing injected interfaces; no skill logic, workflow order, or shared contract changes were needed. Fixture JSON remains demo/test storage, and `metadata.claim_candidates_json` is specific to the fixture extractor. See [INPUT_REPLACEABILITY_AUDIT.md](INPUT_REPLACEABILITY_AUDIT.md) for the mapping, coverage, limitations, and verdict (**PASS WITH MINOR FIXES**).

The replay suite passed (11/11). The complete suite reports 257 passed and 3 failed out of 260; the same three CLI `spawnSync("npm", ...)` exit-status failures were present at the audit baseline (246/249), on this Windows environment. No live connector was added.

## Commands a new agent must run before editing

Run from the repository root:

```sh
git status --short
cd "Skills Library"
npm test
```

Then read this handoff, the target skill's relevant contracts, `schemas/skill-result.schema.json`, and the target skill conventions before editing. If tests fail before the branch's changes, report the baseline failure rather than attributing it to the branch.
