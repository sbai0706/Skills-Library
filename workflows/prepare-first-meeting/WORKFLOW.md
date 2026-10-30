# prepare-first-meeting

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Compose the portable skills into one deterministic, agent-agnostic workflow:

```text
workflow.input -> account.resolve -> evidence.retrieve -> evidence.normalize -> gap.detect -> artifact.render -> provenance.check
```

The workflow returns a cited Markdown first-meeting brief only when every provenance invariant holds. It
is plain JavaScript and depends on caller-supplied fixture adapters and the fixture claim extractor. It
does not contact live services, use a model, retry, parallelize, or reorder steps.

## Purpose

Given an account reference, resolve exactly one account, retrieve permitted evidence, normalize it into
claims, report coverage against the first-meeting questions, render a brief, and verify that every
citation in the returned artifact is traceable to a normalized claim within the classification ceiling.

The output also records the fixed step order, per-step summaries, safe diagnostics, and the exact
cited/omitted claim IDs. A caller can therefore distinguish a trustworthy brief from a blocked,
degraded, or failed run without inspecting raw evidence.

## When to use

- A human supplies an account reference and needs a first-meeting brief from permitted fixture evidence.
- A caller needs a fully composed workflow rather than individual skill calls.
- The caller needs deterministic behavior and an explicit reason whenever the workflow stops early.

## When not to use

- A live CRM, web, or document connector is required. The MVP uses fixture adapters only.
- The caller needs model-generated prose, conflict resolution, qualification, opportunity stage, or
  recommended answers.
- The caller needs DOCX, PPTX, PDF, HTML application, or presentation output.
- The account is already resolved and the caller only needs one skill.

## Input contract

Input validates against `schemas/workflow-input.schema.json` after deterministic default application.
Only `account_reference` is required.

| Field | Default | Meaning |
| --- | --- | --- |
| `account_reference` | required | Free-text account reference; fuzzy or partial matches block. |
| `questions` | draft reference set | Optional non-empty array of `{ id, text }` (or `question`) objects. IDs must be stable and unique. `null` uses the reference set. |
| `requested_sources` | `["crm", "public_source"]` | Non-empty unique subset of `crm`, `public_source`, `internal_document`. |
| `audience` | `internal_sales` | One of `internal_sales`, `executive`, `customer`. |
| `template_id` | `first-meeting-brief-v1` | Renderer template ID. Unknown IDs fail structurally. |
| `classification_ceiling` | `internal` | One of `public`, `internal`, `confidential`; forwarded unchanged to the renderer. |
| `context` | `{}` | Optional `{ requested_by, roles, permitted_classifications }`; forwarded to retrieval. |

Unknown fields, unsupported sources, duplicate sources or question IDs, empty question text, unknown
audiences, unknown classifications, and malformed contexts fail before any skill runs. Nothing is
silently repaired.

## Output contract

Output validates against `schemas/workflow-result.schema.json`:

```json
{
  "workflow": "prepare-first-meeting",
  "workflow_version": "0.1.0",
  "status": "success",
  "account": { "account_id": "sf_wf_northstar", "canonical_name": "Northstar Logistics" },
  "account_candidates": [],
  "artifact": { "format": "markdown", "template_id": "first-meeting-brief-v1", "classification": "internal", "markdown": "..." },
  "evidence_ids": ["clm_example"],
  "omitted_evidence_ids": [],
  "warnings": [],
  "errors": [],
  "steps": [],
  "trace_id": "trace_...",
  "started_at": "2026-10-20T14:00:00.000Z",
  "finished_at": "2026-10-20T14:00:01.000Z"
}
```

- `artifact` is `null` for every blocked or failed run.
- `evidence_ids` is exactly the set of `clm_` citations found in the returned artifact, sorted.
- `omitted_evidence_ids` is exactly the normalized claims withheld by the classification ceiling, sorted.
- `account_candidates` contains only safe identifying fields for blocked unconfirmed accounts.
- `steps` follows execution order and includes only completed or attempted steps.
- `trace_id`, timestamps, and runtime dependency overrides are the only volatile fields.

## Fixed execution and stopping rules

The workflow calls the skills in this order and never goes backward:

1. Validate input and apply defaults.
2. `account.resolve` with `{ account_reference }`.
3. `evidence.retrieve` with the resolved account ID, active questions, requested sources, and context.
4. `evidence.normalize` with only records whose `account_id` equals the resolved account ID.
5. `gap.detect` with the normalized claims and conflicts.
6. `artifact.render` with the canonical account, claims, schema-valid gap result, fixed-code warnings,
   audience, template, and ceiling.
7. Verify provenance before exposing the artifact.

Stopping rules:

| Condition | Result | Later skills |
| --- | --- | --- |
| Input validation fails or an unsupported source is requested | `failed` | None run. |
| Account is `ambiguous`, `confirmation_required`, or `not_found` | `blocked` | Retrieval and later skills do not run. |
| `account.resolve` fails or returns no usable identity | `failed` | Retrieval and later skills do not run. |
| `evidence.retrieve` returns `failed` or `blocked` | Same status | Normalization and later skills do not run. |
| Retrieval returns no usable record list | `failed` | Normalization and later skills do not run. |
| `evidence.normalize` returns `failed` or `blocked` | Same status | Gap detection and later skills do not run. |
| Normalization returns no usable claim list | `failed` | Gap detection and later skills do not run. |
| `gap.detect` returns `failed`, `blocked`, or schema-invalid data | `failed`/`blocked` | The renderer does not run. |
| `artifact.render` returns `failed` or `blocked` | Same status | No artifact is returned. |
| Provenance verification fails | `failed` | No artifact is returned. |

There is no retry, no fallback template, no partial-artifact return, and no recovery from a malformed
skill envelope. An exception from a skill is converted to a safe failed step with
`WORKFLOW_INTERNAL_ERROR`.

## Status aggregation

| Workflow status | Meaning |
| --- | --- |
| `success` | Artifact rendered and verified; no earlier step was partial and no claim was omitted by classification. Gaps, conflicts, and their renderer warnings alone do not change this. |
| `partial` | Artifact rendered and verified, but an earlier step was partial or at least one claim was withheld by classification filtering. |
| `blocked` | A policy gate stopped execution, such as account ambiguity, required confirmation, or `not_found`. |
| `failed` | Input validation, a required skill, gap-result validation, or provenance verification failed. |

Important distinctions:

- A sparse account is still `success` when the artifact renders and verifies; gaps are warnings, not
  failures.
- Unresolved conflicts are preserved and rendered for human review; they do not block and do not make
  the workflow partial by themselves.
- Partial retrieval or partial normalization makes the workflow `partial` when the artifact renders.
- Classification filtering makes the workflow `partial` because the brief is knowingly incomplete at the
  permitted ceiling.
- Renderer `partial` caused only by gaps does not make the workflow `partial`.
- If the workflow ends `blocked` or `failed` without a structured error, a safe
  `WORKFLOW_INTERNAL_ERROR` is added.

## Diagnostic aggregation

Warnings and errors from each skill preserve their code and retryability, with a fixed safe
message derived from the step and code:

```json
{ "step": "artifact.render", "skill": "artifact.render", "code": "INVALID_INPUT", "message": "...", "retryable": false }
```

- Free-form skill messages, `details`, raw records, claim text, excerpts, source URIs, source record
  IDs, and withheld content are never copied.
- Identical diagnostics are deduplicated by step, skill, code, safe message, and retryable.
- Diagnostics are sorted by fixed step order, then code, message, and retryable.
- Step summaries expose only counts, statuses, outcome/match method, template ID, and sorted code lists.
- A diagnostics leak check is part of the test suite for the classification-filtered scenario.

The workflow generates fixed renderer warning codes/messages from earlier results:
`partial_normalization`, `gaps_present`, `conflicts_present`, and `no_claims`.

## Provenance invariants

After rendering, the workflow independently verifies:

1. The rendered artifact is a non-empty Markdown string.
2. Parsed Markdown citations are unique and sorted `clm_` IDs.
3. Markdown citations equal `data.cited_evidence_ids` and the renderer envelope `evidence_ids`.
4. Every citation maps to a normalized claim.
5. Every citation is at or below the classification ceiling.
6. Renderer `omitted_evidence_ids` equals exactly the normalized claims above the ceiling.
7. Every normalized claim is either cited or omitted.
8. Every gap `supporting_evidence_ids` entry exists in the normalized claims.

Any failure returns `failed` with `PROVENANCE_INVARIANT_FAILED`, no artifact, and empty `evidence_ids`
and `omitted_evidence_ids`. Verification failures expose a fixed problem category internally but never
return claim text or withheld IDs in diagnostics.

## Classification behavior

The workflow forwards `classification_ceiling` unchanged to `artifact.render`. The renderer validates the
input structurally, then applies the ceiling fail-closed and records omitted claim IDs. The workflow
verifies the exact omission set rather than trusting the renderer's count.

- A public ceiling permits public claims only.
- An internal ceiling permits public and internal claims.
- A confidential ceiling permits all three levels.
- Omitted claims do not appear in the artifact, citations, diagnostics, or step summaries.
- Withholding any claim makes the workflow `partial`.

## Usage

```js
import { prepareFirstMeeting } from "./workflows/prepare-first-meeting/index.js";
import { createFixtureAccountAdapter } from "./adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "./adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "./adapters/fixture-claim-extractor.js";

const result = await prepareFirstMeeting(
  {
    account_reference: "Northstar Logistics",
    classification_ceiling: "internal",
  },
  {
    accountAdapter: createFixtureAccountAdapter({ fixture: "workflow-first-meeting-success" }),
    evidenceAdapter: createFixtureEvidenceAdapter({ fixture: "workflow-first-meeting-success" }),
    claimExtractor: createFixtureClaimExtractor(),
  },
);
```

`deps.now` and `deps.traceId` make timestamps and tracing deterministic for tests. The optional skill
function overrides (`resolveAccount`, `retrieveEvidence`, `normalizeEvidence`, `detectGaps`,
`renderArtifact`) exist only to observe call ordering and inject failure scenarios in tests.

## Fixture scenarios

| Fixture | Expected status | What it proves |
| --- | --- | --- |
| `workflow-first-meeting-success` | `success` | All five skills run; gaps only; artifact citations equal final evidence IDs. |
| `workflow-first-meeting-ambiguous` | `blocked` | Two credible accounts; safe candidates; retrieval not called. |
| `workflow-first-meeting-fuzzy-confirmation` | `blocked` | Fuzzy candidate requires confirmation; retrieval not called. |
| `workflow-first-meeting-missing-account` | `blocked` | No credible account; no downstream calls. |
| `workflow-first-meeting-sparse` | `success` | No records; gap language only, no invented facts. |
| `workflow-first-meeting-partial-source-failure` | `partial` | One source fails; partial records still produce a verified brief. |
| `workflow-first-meeting-normalization-rejection` | `partial` | One candidate is rejected; remaining claim renders. |
| `workflow-first-meeting-conflicted` | `success` | Conflict is preserved without a winner; normalizes as a business result. |
| `workflow-first-meeting-classification-filtered` | `partial` | Internal and confidential claims are withheld without leakage. |
| `workflow-first-meeting-retrieval-failure` | `failed` | Fatal retrieval failure stops normalization. |
| `workflow-first-meeting-renderer-failure` | `failed` | Unknown template fails structurally; no fallback artifact. |

Each fixture directory contains `input.json`, `expected.json`, `accounts.json`, and `sources.json`.

## Implementation notes and assumptions

- The MVP is fixture-only: adapters, extractor, reference questions, and schemas are local files.
- The workflow trusts each skill's envelope shape only enough to check status and required data; invalid
  envelopes become safe failed steps.
- Retrieval records are filtered to the resolved account before normalization as defense in depth.
- `first-meeting-brief-input.schema.json` is structural only. This is a deliberate contract adjustment
  discovered during integration: classification filtering belongs to `artifact.render`, and the workflow
  verifies its omissions. It is semantically significant and should be reviewed with the contract owners.
- Per-step schema validation of every intermediate skill output is proven in tests by wrapping the real
  skills; the production workflow validates the gap result before rendering because it is a direct
  renderer dependency.
- No step-level duration or retry metadata is recorded; the frozen skill envelopes do not expose it.
- `trace_id` is propagated only at the workflow level; individual skills do not accept an upstream trace
  ID in the current contracts.

## Deferred work

- Live CRM/web/document adapters and extractor integration.
- Additional output templates and non-Markdown formats.
- Retry/backoff and partial re-execution policies.
- Persisted workflow runs, step durations, and cross-workflow tracing.
- Human-review workflow for blocked ambiguity and unresolved conflicts.
