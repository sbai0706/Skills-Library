# Orchestrator Notes

Working notes for the orchestrating agent. Rules that always apply live in `../CLAUDE.md`;
project background is in [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md). Update this file when state,
decisions, or the plan change.

## State (2026-11-04)

- `main` @ `3745d60` plus this notes/CLAUDE.md commit. Baseline full suite: **369/369**.
- Phase 1 four outcomes (Account Intelligence v2, Engagement, Qualification, Opportunity Strategy)
  are deterministic, fixture-backed workflows.
- Current goal: replace fixture inputs with real MCP connections (Salesforce + Microsoft 365) and
  verify them live.
- Other local branches/worktrees (`feature/gap-detect`, `feature/artifact-render`,
  `sbai0706-*`, Copilot worktrees) were intentionally preserved; do not assume they are merged.
- An empty untracked folder `Skills Library/skills/signal-extract` inside the repo is a harmless
  leftover.

## Live source findings (verified 2026-11-04)

### Salesforce

- Connector `Salesforce - CONNECTOR 2 UAT` → sandbox `relevantz--newuat.sandbox.my.salesforce.com`.
  Tools: `discover`, `describe`, `dispatch_readonly`, `dispatch`, `display_widget`.
  This is the generic Salesforce API connector, not the `sobject-reads` Hosted MCP server
  described in [SALESFORCE_HOSTED_MCP.md](SALESFORCE_HOSTED_MCP.md) (that Codex config remains
  disabled and is not used).
- SOQL works: `dispatch_readonly` GET `/services/data/v66.0/query` with `queryParams.q`.
  Response: `{status_code, body: {totalSize, done, records[{attributes:{type,url}, ...fields}]}, url}`.
  Errors come back as `{error_code: "API_ERROR", status_code, body}` (e.g. 400 `INVALID_TYPE`).
- Data volume: 42 Account, 239 Opportunity, 29 Contact, 2 Task, 0 Event. Account `Website`,
  `BillingCity`, `Description` mostly null; `Industry` populated. Names look like real customers
  (e.g. BENEVIS, BNY, Infosys) — treat as internal/confidential.
- Only `dispatch_readonly` may be used. `dispatch` is write-capable and forbidden.

### Microsoft 365

- Official Claude Microsoft 365 connector. `sharepoint_search` and `read_resource` work against
  real company content (e.g. site `Consultativeselling` has a `Benevis` folder with a proposal deck
  — a cross-source candidate since BENEVIS is also a Salesforce account).
- SharePoint pages readable via `page:///sites/{siteId}/pages/{pageId}`; files via
  `file:///{driveId}/{itemId}`.
- Granted scopes include write/send scopes (Mail.Send, Files.ReadWrite.All, ChannelMessage.Send).
  The library integration stays read-only; creating a clearly labelled test page/file is allowed.

## Agreed integration direction (proposed; confirm open items below)

Three seams already isolate all data entry: `AccountAdapter`, `EvidenceAdapter`,
`ClaimExtractor` (`adapters/`). `tests/replay-mcp.test.js` already prototypes an in-memory MCP
replay client.

**Mode A first — host-mediated capture/replay.** The host agent (Claude) calls the connectors with
its existing auth and writes raw tool results to a capture file; the library adds adapters that
map captured MCP results into the existing contracts. No credentials in the repo; captures can be
replayed deterministically. **Mode B** (Node acting as MCP client via `@modelcontextprotocol/sdk`)
is deferred; both modes share the same mappers and a `McpToolClient { listTools, callTool }`
interface.

| Phase | Content | Model |
|---|---|---|
| P1 MCP transport | Promote the replay prototype to `adapters/mcp/`: client interface, MCP error → `ADAPTER_*` mapping, capture file format + schema (size limits, redaction rules), git-ignored local capture directory. | sonnet |
| P2 Salesforce adapters | Account search via SOQL (escaping, `LIMIT 50`) → `AdapterAccount`. Evidence: Account/Opportunity/Contact fields → `crm_record`; Task (Event kept in the interface, currently 0 rows) → `crm_activity`; `record_id` = `src_sf_<Id>`; CRM default classification `internal`. Question → field routing in a reference file marked provisional. Deterministic structured-field claim extractor. | design opus, implementation sonnet |
| P3 CLI + wrapper | `--source fixture\|capture`, `--capture <path>` on all CLIs; fixture stays default so existing tests are unaffected. Wrapper instructions for Claude: which tools to call, how to write the capture, never `dispatch`. | sonnet |
| P4 M365 | SharePoint documents and pages → `internal_document`. Email/Teams excluded (not in source taxonomy; privacy). | sonnet |
| P5 Live acceptance | Sandbox scenario matrix: unique match, ambiguous, missing, field not permitted, no activity, classification ceiling. Synthetic regression fixtures shaped like real captures; live runs opt-in, not part of `npm test`; results documented. | sonnet runs, orchestrator judges |
| P6 (optional) | Mode B direct Node MCP client. | later |

Expect sparse live results (few descriptions, 2 Tasks): many gaps are correct behavior. Mapping /
assessment inputs (v2 mappings, qualification assessment, opportunity-strategy qualification
input) reference evidence IDs and remain caller-supplied; first live runs use the no-mapping paths.

## Decisions (2026-11-04)

1. Plan approved: Mode A, phases P1–P5.
2. Claim extraction v1: structured fields only (composite extractor kept as extension point).
3. P2 details (user): Contacts `internal`, Name/Title/Department only; no free text in v1 (incl.
   Task/Event Subject, Event Location) pending privacy review; `Qualification_Score__c` + six
   qualification-like picklists kept as raw record lines but excluded from claims/brief
   (`CLAIM_EXCLUDED_FIELDS`) pending approved B-FITT. Full list: §10 of
   [design/P2_SALESFORCE_ADAPTERS.md](design/P2_SALESFORCE_ADAPTERS.md).

## Progress

- P1 done: `adapters/mcp/` merged (8649b22). See [MCP_CAPTURE.md](MCP_CAPTURE.md).
- P2 done: `adapters/salesforce/` merged (f95673b); suite 466/466. All generated SOQL verified
  live (read-only) in the sandbox; Task `Owner.attributes.type` is `"Name"` (polymorphic).
- P3 done: merged (b0212b4); suite 515/515. Five workflow CLIs take `--source capture --capture`
  (prepare-engagement initial only); `bin/salesforce-capture-plan.js` (plan, `--init-capture` restricted
  to `.captures/`, `--validate` gate); wrapper capture sections. Live smoke (one sandbox account, 6
  calls): first-meeting v1/v2 success/0, qualification/engagement/opportunity-strategy partial/2,
  missing-entry capture failed/1 (REPLAY_INCOMPLETE on stderr only).
- Design issue RESOLVED (2026-11-04): one account with 38 Opportunities gave ~350 citations /
  ~69k-char brief. Now Opportunity claims = StageName/Amount/CloseDate only, capped per object
  (Opp 10, Contact 20, Task 10, Event 10) by deterministic ordering; see P2 design section 10.9.
- Next: P4 (M365), P5 (live acceptance; Event shape still unverified — 0 rows).
- Agent worktrees kept under `.claude/worktrees/` (locally excluded via `.git/info/exclude`).

## Environment notes

- Previous orchestration ran from Cowork through a Linux VM where the mounted repo was very slow
  (full suite exceeded the call limit; a VM-local clone ran it in ~13 s). Running Claude Code
  natively on Windows should not have this issue.
- Subagents were verified able to call the Salesforce and M365 connectors in Cowork; re-verify in
  Claude Code (connector availability there depends on its own MCP configuration).

## Log

- 2026-11-04: Orchestrator setup; baseline 369/369. Verified Salesforce UAT + M365 connectors.
  Proposed Mode A integration plan. Moved orchestration to Claude Code; added `CLAUDE.md` and
  these notes.
- 2026-11-04 (Claude Code): baseline 369/369; connectors and subagent connector access verified.
  P1 and P2 implemented, reviewed, fixed and merged locally (466/466). Nothing pushed.
- 2026-11-04: P3 implemented, reviewed, live-smoked, fixed and merged (515/515). Nothing pushed.
