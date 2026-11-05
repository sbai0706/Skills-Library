# P5 live acceptance record (2026-11-05)

Record of the live acceptance run of the Mode A capture/replay integration (Salesforce sandbox
`relevantz--newuat` plus the Microsoft 365 SharePoint connector, both read-only) through the capture
CLIs. It lists **status, exit codes and counts only**: no account names, IDs, search terms, document or
file names, and no payload content. The raw captures stayed in the git-ignored `.captures/` directory
and the run record (which holds real paths) in the git-ignored `local/` directory; neither is committed.

Exit codes: `success` 0, `partial` with artifact 2, `blocked` 3, `failed` or invalid usage 1.

## Results

### S1: mapped account, Salesforce + M365

Date used for the run: 2026-11-05. One account that has a SharePoint mapping, captured from both
sources.

| Run | Status | Exit | Counts / codes |
| --- | --- | ---: | --- |
| `prepare-first-meeting` (v1) | success | 0 | 41 citations (23 `crm_record`, 18 `internal_document`); `GAPS_PRESENT` |
| `prepare-first-meeting-v2` | success | 0 | same 41 citations; `GAPS_PRESENT` |
| `qualification` | partial | 2 | policy/gap codes |
| `opportunity-strategy` | partial | 2 | policy/gap codes |
| `prepare-engagement` (initial) | partial | 2 | policy/gap codes |
| `source-rank` | success | 0 | `salesforce` rank 1 (age 0 days), `m365_sharepoint` rank 2 (age 63 days) |

M365 retrieval: 9 hits, 6 kept, 2 personal (OneDrive) hits and 1 root-site hit excluded.

### S2: ambiguous term

| Run | Status | Exit | Codes / counts |
| --- | --- | ---: | --- |
| Name search | blocked | 3 | `AMBIGUOUS_ACCOUNT`, 3 candidates |
| After choosing the Id and recapturing | success | 0 | |

### S3: single fuzzy match

| Run | Status | Exit | Codes |
| --- | --- | ---: | --- |
| Name search | blocked | 3 | `CONFIRMATION_REQUIRED` |
| After confirmation | success | 0 | |

### S4: no match

| Run | Status | Exit | Codes |
| --- | --- | ---: | --- |
| Name search | blocked | 3 | `ACCOUNT_NOT_FOUND` |

### S5: unmapped account with an M365 capture

| Run | Status | Exit | Counts / codes |
| --- | --- | ---: | --- |
| `prepare-first-meeting` | success | 0 | `M365_NOT_MAPPED`, no M365 call; 80 citations (68 `crm_record`, 12 `crm_activity`) |
| `source-rank` | success | 0 | `salesforce` only |

### S6: account without contacts or activities

| Run | Status | Exit | Notes |
| --- | --- | ---: | --- |
| `prepare-first-meeting` | success | 0 | gap warnings |
| `source-rank` | success | 0 | one source |

### S7: access ceiling

| Run | Status | Exit | Codes / counts |
| --- | --- | ---: | --- |
| `source-rank --classification public` | blocked | 3 | `RECORDS_WITHHELD`, `CLASSIFICATION_RESTRICTED` |
| `prepare-first-meeting` at a public ceiling | partial | 2 | `CLAIMS_WITHHELD`; all 41 claims withheld |
| Confidential control | success | 0 | |

### S8: incomplete captures

| Run | Result |
| --- | --- |
| `--validate` with a missing Salesforce Phase 2 entry (two cases) | exit 1 (missing planned call) |
| `--validate` with a missing M365 search | exit 1 (missing planned call) |
| Workflows replaying those captures (4 runs) | exit 1, `REPLAY_INCOMPLETE` on stderr; the stdout status is to be ignored |

### S9: `--append` refusals

Duplicate calls, `--replace-last` misuse, a busy lock and a path outside `.captures/` were each refused
with exit 1 and the capture file unchanged. `--replace-last` on the same call worked.

### X1 and X2: account-resolution edge cases

| Case | Result |
| --- | --- |
| X1: a term with a SOQL substring match but a weak token match | `ACCOUNT_NOT_FOUND` |
| X2: an exact name among 4 matching rows | `AMBIGUOUS_ACCOUNT` |

Account resolution is token-based (`skills/account-resolve`); a SOQL substring match does not imply a
candidate.

## Not reproducible in this org

- Salesforce and M365 pagination: the largest Salesforce result was 40 rows and the M365 search returned 9
  hits, so no `done:false` or `moreResults` page was ever produced live (covered by synthetic fixtures only).
- Permission errors (`INVALID_FIELD`, 403) and a transient 401 or 429, and `--error-file` with a real error
  payload (synthetic errors are covered by tests).
- Event shape: the org has 0 Events.
- `/teams/` SharePoint locations.

## Known behaviours

- first-meeting at a public ceiling is `partial` (exit 2, `CLAIMS_WITHHELD`), not `blocked`; only
  `source-rank`, which has no claims to fall back on, is `blocked`.
- A single missing Salesforce Phase 2 entry drops the whole `crm` source by design: it is a
  `REPLAY_INCOMPLETE` failure (exit 1), never a smaller result.
- `source-rank` prints a success ranking of the remaining source on stdout under `REPLAY_INCOMPLETE` but exits
  1. Report "failed: incomplete capture" and ignore the stdout status (the same rule as the workflow CLIs).
- To run by `--account sf_<Id>` the ID query must be recorded first, even when the Id came from the name
  search; otherwise `REPLAY_INCOMPLETE` follows.
- Use `npm run -s` for commands whose stdout is parsed as JSON; the npm banner breaks parsing.
- `sharepoint_search` returns raw concatenated JSON text: append it with `--result-text-file`
  (see [MCP_CAPTURE.md](MCP_CAPTURE.md)).
- `source-rank` in capture mode with `--output json` prints the blocked or failed result on stdout
  (`data: null`). The S7 record was taken before that change, when stdout was empty; the expectations file
  stores no status for that run.

## How to rerun

The replay is opt-in and is not part of `npm test`. It reads an expectations JSON, reruns every recorded
command against its already recorded captures, compares the exit code and (when recorded) the stdout
status, and prints a payload-free table. It makes no connector call.

```text
npm run live-replay                                  # default: local/p5-live-acceptance.json (git-ignored)
npm run live-replay -- --expectations <path>
npm run live-replay -- --scenario S1,S5              # a subset
npm run live-replay -- --expectations reference/live-replay-expectations.example.json   # synthetic demo
```

- The table has one row per run: scenario id, run index (`r` for a run, `v` for a validate), npm script,
  expected versus actual exit code, expected versus actual status and `PASS`, `MISMATCH` or `SKIP` (the
  command still holds an unresolved `<placeholder>`). It exits 1 on any mismatch or invalid expectations,
  otherwise 0.
- Expectations: `{"scenarios": {"<id>": {"runs": [{"command", "exit_code", "status"?}], "validate":
  {"<name>": {"command", "exit_code"}}}}}`; other keys are ignored and recorded build steps (init and
  append) are never replayed. Paths inside commands are relative to the repository root (the replay runs
  from there).
- Commands are never run through a shell. Each must be `npm run [-s] <script> -- <args>` for the
  repository's own read-only scripts (`prepare-first-meeting`, `prepare-first-meeting-v2`,
  `opportunity-strategy`, `qualification`, `prepare-engagement`, `source-rank`) or, only with `--validate` or
  `--check-mapping`, `salesforce-capture-plan` or `m365-capture-plan`. Anything else is refused and nothing
  runs.
- To redo the live capture itself (new connector calls), follow [MCP_CAPTURE.md](MCP_CAPTURE.md); the replay only
  re-verifies recorded captures against the current code.
