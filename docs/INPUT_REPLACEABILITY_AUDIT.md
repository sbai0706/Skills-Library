# Input Replaceability Audit

Date: 2026-10-30

## Current boundaries

| Boundary | Current contract | Fixture boundary |
|---|---|---|
| Account lookup | `AccountAdapter.searchAccounts(query)` returns `{ok, accounts}` or a structured adapter error. `account.resolve` validates and scores the returned objects. | `adapters/fixture-account-adapter.js` loads account JSON and implements the interface. `bin/prepare-first-meeting.js` selects the demo fixture. |
| Evidence retrieval | `EvidenceAdapter.retrieve(request)` returns raw source records or a structured adapter error. `evidence.retrieve` validates records, scope, and classification. | `adapters/fixture-evidence-adapter.js` loads source JSON and implements the interface. |
| Claim extraction | `ClaimExtractor.extract(record)` proposes candidates. `evidence.normalize` validates excerpts and claims and owns provenance, classification, deduplication, conflicts, and rejection. | `adapters/fixture-claim-extractor.js` alone reads `metadata.claim_candidates_json`. This field is not an extractor-interface or normalize-input requirement. |
| Workflow injection | `prepareFirstMeeting(input, deps)` receives `accountAdapter`, `evidenceAdapter`, and `claimExtractor`; the five skill calls and their order are fixed in the workflow. | The CLI constructs fixture implementations. Tests can pass alternate implementations directly. |
| Fixture bootstrap | JSON loading is in fixture adapters and the local CLI/demo bootstrap; tests load fixture JSON for assertions. Reference YAML loaders read question/template reference data, not fixture data. | Fixture scenario names and paths are confined to these bootstrap/test/manifest areas. |

Static review of the five skill implementations and `workflows/prepare-first-meeting/index.js` found no fixture-path access, JSON fixture reads, fixture implementation imports, or `metadata.claim_candidates_json` references. Skill manifests and workflow documentation list fixture examples, and `WORKFLOW.md` shows a fixture-based caller example; these describe tests/demo setup and are not runtime dependencies. `evidence.normalize` documentation was clarified so the fixture metadata key cannot be mistaken for a generic requirement.

## Replacement mapping

| Current | Future replacement | Downstream changes required |
|---|---|---|
| `FixtureAccountAdapter` | MCP/REST/CLI account adapter | None, if it returns the account-adapter contract. |
| `FixtureEvidenceAdapter` | MCP/REST/CLI evidence adapter | None, if it returns valid source records and structured errors. |
| `FixtureClaimExtractor` | Model/MCP/other claim extractor | None, if it implements `extract(record)` and returns claim candidates/errors. |
| JSON fixture files | Live transport responses | None outside bootstrap/adapters; map transport payloads into the existing contracts. |

The current evidence-adapter contract returns a complete `records` array and has no continuation cursor. Pagination can be performed inside an adapter before returning, subject to the existing record limit; a streaming/cursor contract would require a separate future contract change and is not needed to prove replacement.

## Verification results

### Statically verified

- `account.resolve` calls only the injected account adapter interface.
- `evidence.retrieve` calls only the injected evidence adapter interface.
- `evidence.normalize` calls only the injected extractor interface; it does not inspect fixture metadata.
- `prepare-first-meeting` injects all three dependencies and has no transport-specific branch or fixture loading.
- Fixture file reads are in fixture adapter modules, CLI/demo bootstrap, and tests. Reference YAML reads are configuration loading, not fixture input.
- Existing contracts express empty arrays, structured malformed/unauthorized/unavailable errors, account scope, classification, source IDs, provenance, and separate `published_at`, `occurred_at`, and `retrieved_at` values.

### Replay verified

`tests/replay-mcp.test.js` uses an in-memory tool client with discovery, invocation, MCP-like `structuredContent`, and independent account/evidence/extractor mappings. It does not invoke fixture adapters, fixture extraction, a network client, or fixture JSON. The coverage includes candidate accounts, empty/malformed data, authorization and transport failures, source metadata, classifications, timestamps, question IDs, unsupported claims, classification downgrade rejection, conflicts, and deterministic claim IDs.

The tool response is mapped as:

```text
MCP-like structured response -> replay adapter/extractor -> existing contracts
```

No tool response is persisted to JSON. A source failure remains an adapter error and becomes the existing `partial`, `blocked`, or `failed` workflow outcome; there is no fixture fallback.

### End-to-end verified

The existing `prepare-first-meeting` function ran with the three replay implementations injected. The unchanged skill order completed, the workflow result validated against its existing schema, and the renderer produced a Markdown brief with claim citations. Tests also cover ambiguous account, zero evidence, partial source failure with retained citations, authorization denial, malformed response, unsupported candidate, classification filtering, conflict retention, and repeat determinism.

### Test run

- Baseline before audit additions: **249 tests; 246 passed, 3 failed**.
- After replay additions: **260 tests; 257 passed, 3 failed**.
- All **11 replay tests passed**.
- The same three existing CLI tests failed at baseline and after the audit: two npm-script invocations and one npm-script invocation from a subdirectory assert an exit code, but `spawnSync("npm", ...)` returns `status: null` in this Windows test environment. Direct CLI invocations pass. This is a pre-existing CLI test-launch issue, not an adapter/workflow failure.

## Contract changes

None. No shared schema, skill contract, skill implementation logic, workflow order, gap logic, renderer logic, or fixture data changed. The only runtime-facing documentation edit clarifies that `metadata.claim_candidates_json` belongs to the fixture extractor only.

## Known limits

- Real authentication was not verified.
- Real vendor response shapes were not verified.
- Pagination volume was not verified; the current evidence adapter interface has no cursor field.
- Rate limits were not verified.
- Production authorization was not verified.
- Unrestricted natural-language extraction was not verified; replay extraction uses explicit, independent candidates.
- Live source quality was not verified.
- The three pre-existing CLI test-launch failures described above remain.

## Final verdict: PASS WITH MINOR FIXES

The input replacement boundaries pass static, replay, and end-to-end verification. The minor completed fix was a documentation clarification separating fixture-only candidate metadata from the generic extractor contract; replay coverage was added without changing shared contracts or business logic. No real MCP or external source was connected.

The three baseline CLI test-launch failures remain outside the input-boundary path; therefore the full repository test command is not reported as completely passing.
