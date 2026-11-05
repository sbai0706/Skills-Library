# MCP capture and replay (Mode A)

In Mode A a host agent calls MCP connector tools with its own authentication and writes the raw
tool results to a capture file. The library replays that file deterministically through the
shared `McpToolClient` interface (`adapters/mcp/`). A future live Node MCP client (Mode B) will
implement the same `{ listTools(), callTool(name, args) }` interface.

## Where captures go

Raw live captures may contain **real customer data**. Keep them in `.captures/` (git-ignored) and
never commit them. Committed fixtures must be synthetic and clearly fictional
(see `fixtures/mcp-capture/`).

## Only read-only tools may be captured

- Salesforce: `dispatch_readonly` (GET) only. **Never capture or call `dispatch`.**
- Microsoft 365: for the library only `sharepoint_search`. Never capture `read_resource`,
  `sharepoint_folder_search` or any send/post/edit/create/move/delete/upload tool.

## Format (`schemas/mcp-capture.schema.json`, validator name `mcpCapture`)

```json
{
  "format_version": "mcp-capture/1",
  "capture": { "created_at": "<date-time>", "source_system": "salesforce|m365|...", "connector": "<label>", "note": "<optional>" },
  "entries": [
    { "tool": "<name>", "args": { }, "result": { }, "captured_at": "<date-time>" },
    { "tool": "<name>", "args": { }, "error":  { }, "captured_at": "<date-time>" }
  ]
}
```

Each entry has exactly one of `result` (any JSON value: raw MCP tool result or connector payload)
or `error` (an object, for example `{error_code: "API_ERROR", status_code, body}`). Entries are in
call order.

A connector result is an error only when `status_code >= 400` or `error_code` is a non-empty
string. A 2xx envelope such as `{status_code: 200, body: {totalSize, done, records}, url}` is a
success: `unwrapToolResult` returns `{ok: true, payload: body, meta: {status_code, url}}`.

## Replay semantics

Calls match on tool name plus canonicalized args (object keys sorted recursively; array order is
significant). Repeated identical calls consume matching entries in capture order. Replay is strict
by default: once the entries for a key are consumed, the next call raises `REPLAY_UNMATCHED` with
reason `replay_exhausted` (pass `{ reuseLast: true }` to keep serving the last entry).
`client.unconsumed()` lists entries never served (`{index, tool}`, no payloads). No match raises
`McpClientError` `REPLAY_UNMATCHED` (reason `replay_unmatched`); an unknown tool raises
`TOOL_NOT_FOUND`; a captured `error` raises `TOOL_ERROR` carrying its (redacted) `payload`.

Retries: the library never retries. Some failures are marked `retryable: true` (for example a 401
with `INVALID_AUTH_HEADER` or `INVALID_SCOPES`, which are transient); in Mode A retrying is the
host's job at capture time, so a good capture should contain the successful retry.
`mapMcpError` / `unwrapToolResult` convert these and isError results into the existing `ADAPTER_*`
codes (see `adapters/mcp/errors.js` for the table). No new error codes were added.

## Limits (enforced by `loadCapture`)

| Limit | Value |
| --- | --- |
| Entries per capture | 1000 |
| Serialized size per entry | 2 MB |
| Serialized size per file | 20 MB |

`loadCapture(source, { limits })` may only tighten these. Violations throw `CaptureError`
`CAPTURE_TOO_LARGE`; schema failures `CAPTURE_INVALID`; unreadable/non-JSON files `CAPTURE_UNREADABLE`.

## Redaction

`loadCapture(source, { redact: [...] })` replaces matching values with `"[REDACTED]"` in each
entry's `result` and `error` before use (args are left intact so matching still works). A pattern
without `.` matches that key at any depth (`"Email"`); a dotted pattern is a path from the
result/error root with `*` wildcards (`"structuredContent.records.*.Email"`). JSON embedded in MCP
text content blocks is redacted too, as is any JSON-string value under any key (for example the
double-encoded Salesforce error `body`). With `redactErrorMessages` (default `true`) all `message`
fields in `error` entries and error-shaped results are replaced as well, and plain-text `isError`
content is replaced wholesale. Consequence: a transient-auth hint that appears only in a message
(`INVALID_SCOPES`) is not detectable after redaction; `INVALID_AUTH_HEADER` is read from `errorCode`
and still works. `McpClientError.payload` holds the redacted payload.

Redaction is in-memory only. The capture file on disk stays raw, and `ReplayMcpClient.calls`
records the unredacted call arguments, so do not log or persist `calls` from live captures.

`loadCapture` options: `limits` values must be positive finite numbers; non-serializable input
(circular references, BigInt) raises `CAPTURE_INVALID`.

## Usage

```js
import { loadCapture } from "../adapters/mcp/index.js";
const client = loadCapture(".captures/sf-2026-11-01.json", { redact: ["Email", "Phone"] });
```

## End-to-end host procedure (Salesforce, CLI capture mode)

The CLIs `prepare-first-meeting`, `prepare-first-meeting-v2`, `qualification`, `prepare-engagement`
(initial) and `opportunity-strategy` accept `--source capture --capture <path>` (default
`--source fixture`; no fallback between the two). `bin/salesforce-capture-plan.js` prints the exact
calls; it makes no network call.

1. `npm run salesforce-capture-plan -- --init-capture .captures/<slug>.json --source-system salesforce`
   writes an empty valid skeleton. The target must be a file under `<repo root>/.captures/`
   (anything else, including a directory, is refused with exit 1; there is no override flag), and
   an existing file is never overwritten.
2. Phase 1: `npm run salesforce-capture-plan -- --account "<name or sf_<Id>>"`. Output is JSON:
   `calls` is a list of `{step, tool:"dispatch_readonly", args}` (some with a `condition`), plus
   `pagination` and `host_rules` text. Call the Salesforce connector tool `dispatch_readonly` with
   exactly each `args` (never `dispatch`/`describe`/`discover`, never hand-written SOQL) and append
   `{"tool":"dispatch_readonly","args":<args>,"result":<raw result>,"captured_at":"<ISO>"}` (or
   `"error"`) to `entries` in call order. Retry a 401 `INVALID_AUTH_HEADER` once and record only the
   final attempt; follow and record `nextRecordsUrl` pages (validation fails on a missing page).
3. Choose the account: take the Id directly only when exactly one row matched AND its `Name`
   equals the term case-insensitively (after the adapter's trimming). Otherwise run the CLI once
   after Phase 1 as an ambiguity/confirmation check only: exit 3 with `CONFIRMATION_REQUIRED` or
   candidates present means the user must choose an Id; then re-run Phase 1 with
   `--account sf_<Id>` and record that ID query. A `REPLAY_INCOMPLETE` failure at that point is
   expected when the account resolves, because Phase 2 is not captured yet.
4. Phase 2: `npm run salesforce-capture-plan -- --account-id sf_<Id>`: five calls (Account,
   Opportunity, Contact, Task, Event) recorded the same way. One capture file holds Phase 1 and
   Phase 2 entries, so both `--account "<name>"` and `--account sf_<Id>` replay from it.
5. `npm run salesforce-capture-plan -- --validate .captures/<slug>.json --account "<ref>" --account-id sf_<Id>`
   runs `loadCapture` and prints a payload-free summary (entry counts, recorded error count,
   problems); exit 1 on any problem: missing planned calls, a tool other than `dispatch_readonly`
   or a non-GET method, a successful `done:false` result without a recorded later
   `{url: nextRecordsUrl, method: "GET"}` page (`entry N: missing pagination page`; a recorded
   error is not a page), or `capture.source_system` other than `salesforce`.
6. `npm run <workflow> -- --account "<ref>" --source capture --capture .captures/<slug>.json --output json`.
   Exit codes are unchanged (0 success, 2 partial, 3 blocked, 1 failed or invalid usage). Exit 3 is
   "blocked": read `status` and `errors`; only `CONFIRMATION_REQUIRED` or ambiguity (candidates)
   means the user picks an Id, while evidence/authorization errors (`NO_RECORDS_RETRIEVED`,
   `PARTIAL_SOURCES`, `ADAPTER_UNAUTHORIZED`, `EVIDENCE_RETRIEVAL_BLOCKED`) are reported as they
   are. A call the capture does not cover (`replay_unmatched` / `replay_exhausted`) forces exit 1
   and prints `REPLAY_INCOMPLETE` on stderr only. The JSON result is not modified (it typically
   shows a generic code such as `ADAPTER_UNAVAILABLE`): adding a `REPLAY_INCOMPLETE` entry would
   alter the status/artifact consistency of the workflow result contracts, and a stdout line would
   break `--output json`. Report "failed: incomplete capture" and ignore the stdout status and
   artifact. A capture whose `source_system` is not `salesforce` is rejected (exit 1).

Capture mode serves the `crm` source from the Salesforce capture (and, with an M365 capture, the
`internal_document` source: see "M365 SharePoint" below; any other `--sources` value is invalid
usage) and uses the no-mapping paths; options that reference fixture evidence IDs (`--fixture`, `--mapping-fixture`,
`--assessment-fixture`, `--mode follow_up`) are rejected. Keep captures under `.captures/`
(git-ignored); `--init-capture` enforces it, and `--validate` and every capture-mode run print a
stderr WARNING (no payload content, exit code unchanged) when the capture file is not git-ignored
(`git check-ignore`; skipped silently if git is unavailable). Workflow artifact content may be
shown to the user (citations are the bracketed `[clm_...]` markers in `artifact.markdown` plus
`evidence_ids`; there is no separate list), but raw captures, connector payloads and Salesforce
records must never be pasted or committed.

## M365 SharePoint (second capture file)

Design: [design/P4_M365_SHAREPOINT_ADAPTER.md](design/P4_M365_SHAREPOINT_ADAPTER.md) (its final
"Decisions (2026-11-05)" section overrides earlier sections). SharePoint documents are a second,
optional source (`internal_document`). Content is search metadata only (file name, folder location,
file type, last-modified time); the search snippet is bounded context, never a claim; there is no
`read_resource` and no document body. Personal OneDrive is excluded; mapped locations are SharePoint
`/sites/<site>/<library>...` or `/teams/<site>/<library>...` libraries, never root-site libraries.

It uses its own capture file (`capture.source_system: m365`, only `sharepoint_search` entries),
validated by `bin/m365-capture-plan.js`, and a human-maintained account-to-location mapping
(`local/m365-account-mapping.yaml`, git-ignored; example: `reference/m365-account-mapping.example.yaml`).
An account without a mapping makes no M365 call: `internal_document` is a clean empty source and the
run reports `M365_NOT_MAPPED`. Each capture is replayed by its own strict client, so the two sources
cannot consume each other's entries.

Host procedure for one account (Salesforce + M365 + `source-rank`):

1. `npm run m365-capture-plan -- --check-mapping` (counts only; needs the local mapping file).
2. Salesforce, exactly as in the procedure above: resolve `sf_<Id>` and capture Phase 1 and Phase 2 into
   `.captures/<slug>.json` (`dispatch_readonly` only).
3. `npm run m365-capture-plan -- --init-capture .captures/<slug>-m365.json`
4. `npm run m365-capture-plan -- --account-id sf_<Id>` and make every printed call with the connector tool
   `sharepoint_search` only (exact args; never `read_resource`, `sharepoint_folder_search` or a write/send
   tool), following `nextOffset` while `moreResults` is true (at most 4 pages per search), recording each
   raw result as `{"content":[<item text blocks>, <trailer text block>]}` (empty: `{"content":[]}`) or the
   tool error as `"error"`. On a rate-limit error wait `graphRetryAfterSeconds`, retry once, record the final
   attempt. Unmapped: record nothing. The plan output contains folder names: do not paste it into chat.
5. `npm run m365-capture-plan -- --validate .captures/<slug>-m365.json --account-id sf_<Id>`
6. `npm run source-rank -- --source capture --account sf_<Id> --capture .captures/<slug>.json --capture-m365 .captures/<slug>-m365.json --output json`
   or a workflow, e.g. `npm run prepare-first-meeting -- --account "<ref>" --source capture --capture .captures/<slug>.json --capture-m365 .captures/<slug>-m365.json --output json`.

Flags (all capture mode only): `--capture-m365 PATH`, `--m365-mapping PATH` (requires `--capture-m365`;
default `local/m365-account-mapping.yaml`). The workflow CLIs still need `--capture` (account
resolution uses Salesforce) and default `--sources` to `crm,internal_document`; `source-rank` also takes
`--capture` and/or `--capture-m365`, `--classification public|internal|confidential` (default
`internal`) and defaults `--now` to the latest `capture.created_at`. Without `--capture-m365`,
behaviour is unchanged.

Stderr diagnostics (`capture: <CODE>: <count and fixed text>`; counts only; exit code unchanged):
`M365_NOT_MAPPED`, `M365_PERSONAL_EXCLUDED`, `M365_OUTSIDE_MAPPING_EXCLUDED`,
`M365_UNSUPPORTED_ITEMS_SKIPPED`, `M365_COPIES_MERGED`, `M365_SEARCH_TRUNCATED`, `M365_RECORDS_TRUNCATED`.
An M365 error makes the `internal_document` source unavailable or unauthorized (`partial`/2, or blocked/3
when nothing else works); a missing capture entry (including an empty skeleton for a mapped account)
forces exit 1 with `REPLAY_INCOMPLETE` naming `m365-capture-plan`. M365 error captures are loaded with
`details.graphRequestId` and `details.uriPath` redacted (volatile or path-bearing). Keep captures under
`.captures/` and the mapping under `local/`; never commit either, never paste raw results, snippets, file
names or paths into chat.
