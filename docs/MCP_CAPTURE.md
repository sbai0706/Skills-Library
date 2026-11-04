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
- Microsoft 365: search and `read_resource` only. Never capture send/post/edit tools.

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
