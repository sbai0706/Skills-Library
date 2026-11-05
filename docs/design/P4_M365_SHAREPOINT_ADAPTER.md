# P4 design: Microsoft 365 SharePoint adapter

Status: design for implementation (sonnet). Date: 2026-11-05. Scope: phase P4 of the plan in
[ORCHESTRATOR_NOTES.md](../ORCHESTRATOR_NOTES.md). Design only. Template and conventions:
[P2_SALESFORCE_ADAPTERS.md](P2_SALESFORCE_ADAPTERS.md) (its §10 decisions still apply to Salesforce).

Implements the existing `EvidenceAdapter` and `ClaimExtractor` seams for source `internal_document`
without changing them. Records must pass `schemas/source-record.schema.json`, the `evidence.retrieve`
record checks and the `evidence.normalize` candidate checks. No new error codes, no contract change.

## 0. Fixed decisions and policy boundary

| # | Decision (user, 2026-11-05) | Consequence in this design |
|---|---|---|
| D1 | Scoping only by a human-maintained account→location mapping; never keyword-guessing. | §2. Unmapped account: no M365 call, empty result plus a `M365_NOT_MAPPED` diagnostic (§10.4), never a workflow failure. Post-filter by `webUrl` prefix is mandatory (§4). |
| D2 | Content = metadata + search snippet only. No `read_resource`, no document body. | §5. Snippet cleaned, bounded, labelled, never a claim. Claims from structured metadata only (§6). |
| D3 | **Personal OneDrive is EXCLUDED** (replaces the earlier inclusion decision). Only SharePoint site libraries (`https://{tenant}.sharepoint.com/sites/...`). | Hits on `{tenant}-my.sharepoint.com` or with a `/personal/` path segment are dropped even under a mapped prefix and only counted (§4). Mapping entries pointing at OneDrive are rejected (§2.2). No OneDrive classification option. |

- Mode A only: the host calls `sharepoint_search` and writes an `mcp-capture/1` file; the adapter
  depends only on an injected `McpToolClient` and calls exactly one tool, `sharepoint_search`.
  `read_resource`, `sharepoint_folder_search` (unreliable) and every write/send/move/delete tool are
  never referenced.
- **No business policy by inference.** The adapter does not decide which documents are relevant to a
  question, deal stage, offering or persona. v1 routes no question (§5.3, open question 1).

## 1. Module layout

New code under `adapters/m365/` (ESM, no new dependencies; `yaml` and `node:crypto` only).

| File | Exports | Purpose |
|---|---|---|
| `constants.js` | `M365_TOOL = "sharepoint_search"`, `SEARCH_QUERY = "*"`, `PAGE_LIMIT = 50`, `MAX_PAGES_PER_SEARCH = 4`, `MAX_OFFSET = 1000`, `MAX_LOCATIONS_PER_ACCOUNT = 10`, `DEFAULT_M365_LIMITS = {maxRecords: 50, maxClaimRecords: 10}`, `SNIPPET_MAX = 300`, `NAME_MAX = 300`, `LOCATION_MAX = 1000`, `PROVIDER = "m365_sharepoint"`, `M365_REDACT = ["details.graphRequestId", "details.uriPath"]`, `DEFAULT_MAPPING_PATH = "local/m365-account-mapping.yaml"` | Frozen constants. |
| `mapping.js` | `loadM365AccountMapping(path)`, `validateM365AccountMapping(doc)`, `normalizePrefix`, `isPersonalUrl(webUrl)`, `matchPrefix(webUrl, locations)` | Mapping file (§2), URL rules (§4). |
| `capture-plan.js` | `searchArgs(folderName, offset)`, `sharepointSearchPlan(accountId, mapping)` | Pure canonical-args builders shared by the adapter and the plan CLI (§3). |
| `search-result.js` | `parseSearchResult(result)` | Raw tool result → `{ok:true, hits, trailer}` or `{ok:false, error}` (§3.3). |
| `errors.js` | `classifyM365Error(payload)`, `toM365AdapterError(thrown)` | §8. |
| `format.js` | `cleanText`, `cleanSnippet`, `fileTypeOf`, `locationOf`, `headerLine`, `fieldLine`, `fieldClaim` | Single source of truth for content lines and claim text (§5, §6). |
| `record-mapper.js` | `mapHit(hit, ctx)` | Hit → source record (§5). |
| `evidence-adapter.js` | `createM365SharePointEvidenceAdapter(options)` | `EvidenceAdapter` for `internal_document`. |
| `claim-extractor.js` | `createM365StructuredClaimExtractor()` | `ClaimExtractor` (§6). |
| `index.js` | Re-exports the above public names. | |

Also new: `adapters/source-router-evidence-adapter.js` (`createSourceRouterEvidenceAdapter`, §10.2),
`bin/m365-capture-plan.js` (§9), `schemas/m365-account-mapping.schema.json` (validator name
`m365AccountMapping`, registered in `schemas/index.js`), `reference/m365-account-mapping.example.yaml`.

```js
createM365SharePointEvidenceAdapter({
  client,                    // required McpToolClient; assertMcpToolClient at construction
  mapping,                   // required, the object returned by loadM365AccountMapping/validateM365AccountMapping
  now = () => new Date(),    // retrieved_at; capture mode passes () => new Date(capture.created_at)
  limits = {},               // {maxRecords, maxClaimRecords}: may only LOWER the defaults (else TypeError)
  classification = "internal", // "internal" | "confidential" only (never public)
  onDiagnostic = () => {},   // receives {code, count?} objects (§10.4); never names, paths or snippets
})
```

`name: "m365-sharepoint-evidence-adapter"`, `supportedSources: ["internal_document"]`. Never throws
after construction (catch everything → `{ok:false, error}`); never calls `listTools()`.

## 2. Account→location mapping

### 2.1 Files and how they are found

| File | Committed | Content |
|---|---|---|
| `reference/m365-account-mapping.example.yaml` | yes | Fictional only (`contoso.sharepoint.com`, `sf_001SYN0000000001AA` "Northwind Traders (fictional)"), `status: provisional`. |
| `local/m365-account-mapping.yaml` | **no** | Real mapping (customer names). Add `local/` to `.gitignore` (comment: "Local, human-maintained config that may contain customer names. NEVER commit."). |

The mapping is config, not a capture, so it lives in `local/`, not `.captures/`. CLIs take
`--m365-mapping PATH` (default `<repo root>/local/m365-account-mapping.yaml`). Missing/unreadable/invalid
→ exit 1, message with problem kind and entry index only, never a URL or name. CLIs call
`warnIfNotGitIgnored` on it ("mapping" instead of "capture" in the text). The library never writes it;
the host may edit it only with locations the user states, never guessed ones.

### 2.2 Format (YAML, validated against `m365-account-mapping.schema.json` plus code checks)

Header as in `reference/salesforce-question-routing.yaml` (`version`, `status: provisional`,
`business_owner: TBD`, `approver: TBD`, `approval_date: null`, `source_documents: []`,
`effective_date: null`, `change_history`) plus `mapping_kind: m365_sharepoint_account_locations`, then:

```yaml
accounts:
  - account_id: sf_001SYN0000000001AA
    label: Northwind Traders (fictional)          # human aid only; never emitted
    locations:
      - web_url_prefix: "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders"
      - web_url_prefix: "https://contoso.sharepoint.com/sites/ExampleDelivery/Shared Documents/Clients/Northwind"
        search_folder_name: "Northwind"          # optional override, see §3.1
        classification: confidential            # optional, may only raise the adapter default
```

| Rule | Reject when (whole file rejected, fail closed) |
|---|---|
| Header | Missing/extra top-level keys; `status` not `provisional`/`approved`; `mapping_kind` wrong. |
| `account_id` | Not `^sf_001[A-Za-z0-9]{15}$` and not `^acct_[a-z0-9_]{1,60}$`; duplicate. |
| `locations` | Empty, more than `MAX_LOCATIONS_PER_ACCOUNT` (10), duplicate prefix (case-insensitive) within an account, unknown keys. |
| `web_url_prefix` | Not `https:`; host not `^[a-z0-9-]+\.sharepoint\.com$` (case-insensitive); **host ends with `-my.sharepoint.com` (OneDrive)**; **any path segment equals `personal` (case-insensitive)**; path not `/sites/<site>/<library>[/<folder>...]` (at least 3 segments, first `sites`); query, fragment, `..` or empty segment; contains `%[0-9A-Fa-f]{2}` (must be the unencoded form exactly as `webUrl` shows it); longer than 1000 chars. |
| `search_folder_name` | Empty after trim or longer than 200 chars. |
| `classification` | Not `internal`/`confidential`. |

`normalizePrefix`: trim, strip trailing `/`, keep case for display, compare lower-cased. Note: root-site
libraries (`https://{tenant}.sharepoint.com/Shared Documents/...`, no `/sites/`) and `/teams/...` sites
are not accepted in v1 (open question 3).

## 3. Search contract (canonical args)

### 3.1 Searches per account

For a mapped account, `sharepointSearchPlan` derives one search per **distinct** folder name, in order
of first appearance in the account's `locations`:
`folderName = search_folder_name ?? last path segment of web_url_prefix` (decoded as written). Two
locations with the same folder name share one search (identical args would otherwise collide in
strict replay). The post-filter (§4) always runs against **all** prefixes of the account.

Why the last segment, verified by read-only probes (structure and counts only): `query:"*"` with
`folderName` returns the documents in that folder **including subfolders**; `folderName` is
case-insensitive; a truncated folder name returned zero hits (prefix/partial match did not work despite
the tool description); a multi-segment path value worked but returned fewer in-folder hits (5 vs 6) than
the single segment; the single-segment search also returned hits outside the folder (3 of 9: one in a
root-site library, two in personal OneDrive). Hence: broad single-segment search, mandatory post-filter.

### 3.2 Calls and pagination

Every call: tool `sharepoint_search`, args exactly (no other keys, no `fileType`/`author`/date filters):

```json
{"query": "*", "folderName": "<folderName>", "limit": 50, "offset": <n>}
```

`searchArgs(folderName, offset)` builds this. Page 1 uses `offset: 0`. After a page whose trailer has
`moreResults: true`, the next call uses `offset = trailer.nextOffset` exactly (it equals the number of
hits returned so far and may be less than `offset + 50`). Stop when the trailer lacks `moreResults`, the
result is empty, or `MAX_PAGES_PER_SEARCH` (4, i.e. ≤ 200 raw hits) pages were read; in the last case
the search is `truncated`. `nextOffset` must be an integer `> offset` and `≤ MAX_OFFSET` (1000), else
`ADAPTER_MALFORMED_RESPONSE`. Searches run sequentially; the first failing call fails the whole
source (fail closed, as in P2).

### 3.3 Result parsing (`parseSearchResult`)

The tool returns one MCP text block per hit plus a final trailer block. `unwrapToolResult` cannot be
used for success (it requires a single JSON block); it is used only for the `isError` path (§8).

| Raw result | Outcome |
|---|---|
| `{isError: true, ...}` | error (§8). |
| `{content: []}` (observed for zero hits: no blocks, no trailer) | zero hits, final page. |
| `{content: [blocks]}`, each `{type:"text", text}` | `JSON.parse` each `text`; an object with a string `uri` is a hit; an object with integer `totalResultCount` and no `uri` is the trailer and must be the last block. |
| Hits present, no trailer | treated as final page. |
| Non-text block, unparsable text, object that is neither hit nor trailer, trailer not last, `structuredContent` present, anything else | `ADAPTER_MALFORMED_RESPONSE` (`reason: "malformed_search_result"`). |

Trailer shapes: last page `{"totalResultCount": N}`; otherwise
`{"moreResults": true, "nextOffset": N, "totalResultCount": N, "note": "..."}` (`note` ignored).

## 4. Hit filtering, deduplication, ordering, limits

Per hit, in this order (each hit identity `driveId/id`, falling back to `webUrl`, is counted once per
`retrieve` even if returned by several searches):

1. `webUrl` not a non-empty string → `ADAPTER_MALFORMED_RESPONSE` (`reason: "hit_without_web_url"`).
2. `isPersonalUrl(webUrl)`: host (from `new URL(webUrl)`, lower-cased) ends with `-my.sharepoint.com`, or
   any decoded path segment equals `personal` (case-insensitive) → **drop**, count `excluded_personal`.
   This applies even when the URL starts with a mapped prefix.
3. `matchPrefix(webUrl, locations)`: lower-cased `webUrl` starts with lower-cased `prefix + "/"`
   (segment boundary: `.../Northwind2/x` does not match `.../Northwind`) → keep, remember the matched
   locations; none → **drop**, count `excluded_outside_mapping`.
4. `uri` not starting with `file:///` → drop, count `unsupported_items` (pages/other kinds are out of
   v1 scope).
5. Strict check of kept hits, else `ADAPTER_MALFORMED_RESPONSE` for the source: `driveId`, `id`, `name`
   non-empty strings; `uri === "file:///" + driveId + "/" + id`; `lastModifiedDateTime` parses with
   `new Date()` and matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`; `content`/`summary` string or
   null. Other keys (`downloadUrl`, `size`, `isPartialContent`, `offset`) are ignored.

Deduplication (deterministic, documented in metadata and diagnostics):

- **Same item** (`driveId` + `id`) from several searches/pages → kept once.
- **Copies**: kept hits with equal `cleanText(name).toLowerCase()` **and** equal normalized
  `lastModifiedDateTime` are one document. The survivor is the copy with the smallest lower-cased
  `webUrl`, then smallest `record_id`. It gets `metadata.m365_copy_count` (total copies, only when > 1) and
  the highest classification of all copies (§11). Count `copies_merged` = removed copies.

Ordering of surviving records: `occurred_at` descending, then `record_id` ascending (input/relevance
order never matters). Limits:

| Limit | Value | On overflow |
|---|---|---|
| Pages per search | 4 × 50 | search `truncated`; diagnostic `M365_SEARCH_TRUNCATED` (count of searches). |
| Records per account (`maxRecords`) | 50 (≤ 500 contract cap) | keep first 50 by the order above; every kept record gets `m365_truncated: true`; diagnostic `M365_RECORDS_TRUNCATED`. Also set `m365_truncated` on all records when any search was truncated. |
| Records producing claims (`maxClaimRecords`) | 10 | others get `m365_claim_excluded: true` (content kept, no claims), as P2 §10.9. |
| Snippet | 300 code points | cut, append ` [truncated]`. |
| File name in lines | 300 code points | cut. |
| Location in lines | 1000 code points | cut. |
| Locations per account | 10 | mapping rejected. |

## 5. Hit → source record

### 5.1 Fields

| Field | Rule |
|---|---|
| `record_id` | `src_m365_` + first 32 hex chars of `sha256(driveId + "/" + id)` (UTF-8). Stable, matches `^src_[A-Za-z0-9_-]+$`, no raw IDs in the key. |
| `account_id` | `request.account_id` (scoping is the mapping; no foreign-account case exists). |
| `source_type` | `internal_document` (already in source-record, evidence and source-rank schemas). |
| `title` | `SharePoint document: <name>` (name = `cleanText(name)` cut to 300; ≤ 500 total). |
| `content` | §5.2. |
| `source_uri` | `new URL(webUrl).href` (percent-encodes spaces so ajv `format: uri` passes). |
| `published_at` | `null`. Last modified is not publication (§7). |
| `occurred_at` | `new Date(lastModifiedDateTime).toISOString()` (§7). |
| `retrieved_at` | `now().toISOString()`, one value per `retrieve`. |
| `access_classification` | §11. |
| `question_ids` | `[]` in v1 (no routing; open question 1). |
| `metadata` | Flat scalars: `provider: "m365_sharepoint"`, `record_type: "sharepoint_file"`, `m365_drive_id`, `m365_item_id`, `m365_file_name`, `m365_file_type` (if any), `m365_site` (decoded segment after `/sites/`), `m365_location` (as in content), `m365_last_modified` (= `occurred_at`), `m365_snippet: true` only when a snippet line exists; optional `m365_copy_count`, `m365_truncated`, `m365_claim_excluded`. The snippet itself and the mapping `label` are never in metadata. |

`fileTypeOf(name)`: lower-cased text after the last `.` if it matches `^[a-z0-9]{1,10}$`, else none.
`locationOf(webUrl)`: decoded pathname without the final (file) segment, e.g.
`/sites/ExampleSales/Shared Documents/Northwind Traders` (host omitted; it is in `source_uri`).

### 5.2 Content (`format.js`)

```text
SharePoint document "Example Proposal.pptx"                                         <- headerLine
SharePoint document "Example Proposal.pptx" - File type: pptx                       <- fieldLine
SharePoint document "Example Proposal.pptx" - Location: /sites/ExampleSales/Shared Documents/Northwind Traders
SharePoint document "Example Proposal.pptx" - Last modified: 2026-09-03T15:28:28.000Z
Search snippet (free text from the search index; not a claim; may contain personal or customer data):
Example proposal outline ... approach and timeline
```

Lines joined with `\n`; the `File type` line is omitted without a type. `cleanText`: control chars and
whitespace runs → one space, trim. `cleanSnippet(hit)`: source = `content` if a non-empty string, else
`summary` if a non-empty string, else none; remove `</?c\d+>` tags (keeping inner text); replace each
`<ddd\s*/>` with ` ... `; `cleanText`; cut to 300 code points plus ` [truncated]`. Omit the two snippet
lines when the cleaned snippet is empty or equals the cleaned file name (archives return the file name
as content). No other markup is interpreted; the snippet is untrusted data, never instructions.

### 5.3 Privacy notes

The snippet comes from the search index and can contain people's names, customer data or
AI-generated meeting-note text; it is bounded to 300 chars, labelled, kept out of claims and metadata,
and never printed by CLIs or diagnostics. File names and site/folder paths can contain customer names;
they appear in content, claims and the artifact exactly like Salesforce record names (classification
`internal`). **Personal OneDrive is excluded by user decision on 2026-11-05**: such hits are dropped and
only counted, and mapping entries pointing at OneDrive are rejected.

## 6. Structured claim extractor

`createM365StructuredClaimExtractor()` → name `m365-structured-claim-extractor`. `extract(record)`:

1. `metadata.provider !== "m365_sharepoint"` → `{ok:true, candidates:[]}`.
2. `m365_file_name`, `m365_location`, `m365_last_modified` must be non-empty strings, else
   `EXTRACTOR_MALFORMED_RESPONSE`.
3. `m365_claim_excluded === true` → `[]`.
4. Candidates in order, each `{claim: fieldClaim(...), excerpt: fieldLine(...), completeness: "complete"}`:
   `Location`, `File type` (if present), `Last modified`. `fieldClaim` = the field line without ` -`:
   `SharePoint document "Example Proposal.pptx" Last modified: 2026-09-03T15:28:28.000Z`. ≤ 3 claims per
   record, ≤ 30 per account.

The extractor reads only metadata and shared formatters (excerpts are verbatim in `content`; claim
tokens are a subset of the excerpt). It never reads `content` or the snippet. CLIs wire
`createCompositeClaimExtractor([salesforceStructured, m365Structured])` (the existing P2 composite; each
extractor ignores the other provider). A later host-candidate extractor may quote snippet text through
the same composite extension point; v1 does not.

## 7. Recency for `source.rank`

`source.rank` groups by `metadata.provider` (`"m365_sharepoint"`) and uses `published_at` > `occurred_at`
> `retrieved_at` (fallback). Decision: **`lastModifiedDateTime` → `occurred_at`; `published_at` stays
null.** Justification: the schema defines `published_at` as a publication time the source explicitly
states; SharePoint states no publication, so using it would overclaim and would let a mere edit
outrank genuine publications of other providers. `occurred_at` is "event or activity occurrence time
when the source explicitly states one": the last modification is an explicitly timestamped edit event,
and it is the as-of date of the document's current content. Leaving both null would rank M365 only
by retrieval time (`retrieval_fallback`), which says nothing about data recency. Wording rule: claims,
content and metadata say "Last modified", never "published" or "created". Known limitation: the
first-meeting brief's evidence reference line labels `occurred_at` as "Occurred" (renderer unchanged;
the claim text itself says "Last modified"; open question 2). Asymmetry to note in docs: Salesforce
Account/Opportunity/Contact records keep `occurred_at: null` (P2), so a Salesforce source without dated
activities ranks as `retrieval_fallback` behind M365; that is the documented data-honest outcome.

## 8. Errors and volatile fields

`toM365AdapterError(thrown)`: `TOOL_ERROR` with `payload` → `classifyM365Error(payload)`, else T1
`mapMcpError` (replay misses, tool not found, transport). Resolved `isError` results: parse the single
JSON text block if present and classify it; otherwise `unwrapToolResult(result).error`. Payload shape:
`{code: "INTERNAL_ERROR", message, details: {graphErrorCode, graphStatusCode, graphRequestId,
graphRetryAfterSeconds, driveId, itemId, uriPath, ...}}`; also accept these keys at top level.

| Condition (checked in order) | Code | retryable | `details.reason` |
|---|---|---|---|
| `graphStatusCode` 401 | ADAPTER_UNAUTHORIZED | false | `unauthenticated` |
| `graphStatusCode` 403 | ADAPTER_UNAUTHORIZED | false | `forbidden` |
| 429, or `graphRetryAfterSeconds` is a number | ADAPTER_UNAVAILABLE | true | `rate_limited` (+ `retry_after_seconds`) |
| 408 or ≥ 500 | ADAPTER_UNAVAILABLE | true | `transient` |
| 400 (incl. invalid drive) or 404 | ADAPTER_UNAVAILABLE | false | `request_rejected` / `not_found` |
| other status ≥ 400 | ADAPTER_UNAVAILABLE | false | `graph_error` |
| no usable status | `mapMcpError(payload)` | per T1 | per T1 |
| replay miss | ADAPTER_UNAVAILABLE | false | `replay_unmatched` / `replay_exhausted` (T1) |

`details` carries only `reason`, `status_code`, and `graph_error_code` when it matches
`^[A-Za-z][A-Za-z0-9_]{0,80}$`. Messages are fixed strings; Graph `message`, `driveId`, `itemId`,
`uriPath` and `graphRequestId` are never echoed. The library never retries (Mode A: the host retries at
capture time, §9.2).

**Volatile fields:** `graphRequestId` changes per call and `uriPath` may contain file paths. The M365
capture is loaded with `loadCapture(path, {redact: M365_REDACT})` (`details.graphRequestId`,
`details.uriPath`; dotted paths, so hit `driveId` values in results are untouched) plus the default
`redactErrorMessages: true`. Replay matching uses args only, so volatile error fields never affect
determinism; the capture on disk stays raw (git-ignored).

## 9. Capture plan CLI and host procedure

### 9.1 `bin/m365-capture-plan.js` (new; `npm run m365-capture-plan`)

Separate CLI (not an extension of `salesforce-capture-plan`): one `source_system` per capture file,
different tool, args and pagination rules; the Salesforce CLI and its tests stay unchanged. Extract the
`.captures/`-only skeleton writer from `bin/salesforce-capture-plan.js` into `cli/capture-files.js`
(`initCaptureFile(path, {sourceSystem, connector})`, same refusal rules and messages) and use it from
both CLIs. Makes no network call. Modes (cannot be combined except as noted):

| Mode | Output / behaviour |
|---|---|
| `--account-id <id> [--m365-mapping PATH]` | JSON `{phase:"m365_search", account_id, mapped, calls:[{step:"search_<n>", tool:"sharepoint_search", args}], max_pages_per_search: 4, pagination, host_rules, note}`. Unmapped: `mapped:false`, `calls:[]`, note "No M365 call is needed: the account has no SharePoint mapping." Exit 0. Output contains folder names from the local mapping: never paste it into chat. |
| `--init-capture PATH` | Skeleton with `source_system: "m365"`, `connector: "Microsoft 365 connector (sharepoint_search)"`; only under `.captures/`, never overwrites. |
| `--validate PATH [--account-id <id> --m365-mapping PATH]` | Payload-free summary `{valid, source_system, created_at, entries, recorded_errors, searches, pages, hits_total, planned_calls_checked?, problems}`; exit 1 on any problem: `source_system` ≠ `m365`; tool ≠ `sharepoint_search`; args keys ≠ exactly `query, folderName, limit, offset`, `query` ≠ `"*"`, `limit` ≠ 50, non-integer offset; a result `parseSearchResult` rejects; a page with `moreResults:true` (below the page cap) without a later entry with the same args and `offset = nextOffset`; a planned page-1 call missing. Never prints args, names, URLs or snippets. |
| `--check-mapping [--m365-mapping PATH]` | `{valid, accounts, locations, problems}` (counts and entry indexes only); exit 1 if invalid. |

`host_rules` text: call only `sharepoint_search` with exactly the printed args; never `read_resource`,
`sharepoint_folder_search` or any write/send/create/move/delete/upload tool; never add filters or change
`query`; record every call's raw result as `{"content":[{"type":"text","text":"<item JSON verbatim>"},
..., {"type":"text","text":"<trailer JSON verbatim>"}]}` (an empty result as `{"content":[]}`) or a tool
error as `"error": {code, message, details}` exactly as returned; follow `nextOffset` while
`moreResults` is true, up to 4 pages per search; on a rate-limit error wait `graphRetryAfterSeconds`,
retry the identical call once and record only the final attempt; keep the file under `.captures/`;
never paste raw results, snippets, file names or paths into chat.

### 9.2 Host procedure (add to `docs/MCP_CAPTURE.md` as "M365 SharePoint"; update the "Only read-only tools" list to: Microsoft 365 `sharepoint_search` only for the library)

1. Ensure `local/m365-account-mapping.yaml` exists (user-maintained, from the example);
   `npm run m365-capture-plan -- --check-mapping`.
2. Run the Salesforce procedure as today to resolve `sf_<Id>` and capture Phase 1/2 into
   `.captures/<slug>.json`.
3. `npm run m365-capture-plan -- --init-capture .captures/<slug>-m365.json`.
4. `npm run m365-capture-plan -- --account-id sf_<Id>`; make and record every printed call and its pages.
   Unmapped: record nothing (the empty skeleton is a valid M365 capture).
5. `npm run m365-capture-plan -- --validate .captures/<slug>-m365.json --account-id sf_<Id>`.
6. Run a workflow or `source-rank` with `--source capture --capture .captures/<slug>.json --capture-m365
   .captures/<slug>-m365.json` (§10).

Example entry (fictional):

```json
{"tool":"sharepoint_search","args":{"query":"*","folderName":"Northwind Traders","limit":50,"offset":0},"result":{"content":[{"type":"text","text":"{\"uri\":\"file:///b!SYNdrive0001/01SYNITEM0001\",\"driveId\":\"b!SYNdrive0001\",\"id\":\"01SYNITEM0001\",\"name\":\"Example Proposal.pptx\",\"content\":\"<c0>Example</c0> proposal outline<ddd/>\",\"summary\":\"<c0>Example</c0> proposal outline<ddd/>\",\"isPartialContent\":true,\"webUrl\":\"https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders/Example Proposal.pptx\",\"downloadUrl\":null,\"size\":null,\"lastModifiedDateTime\":\"2026-09-03T15:28:28.000Z\",\"offset\":0}"},{"type":"text","text":"{\"totalResultCount\":1}"}]},"captured_at":"2026-11-05T10:00:00Z"}
```

### 9.3 Wrappers and docs

- The four workflow wrappers in `.claude/skills/` (incl. the v2 section of `prepare-first-meeting`): add
  an "Optional M365 documents" subsection with the §9.2 steps, the two new flags, the §10.4 diagnostics to
  report, and the rules (only `sharepoint_search`; never `read_resource`, send or write tools; never guess
  a mapping; never paste raw results/snippets into chat). `source-rank` wrapper: add §10.5 capture mode.
- `README.md`/`docs/AGENT_SKILLS.md`: one line each; `package.json` script `m365-capture-plan`.

## 10. Multi-source capture mode

### 10.1 Decision: two capture files

`--capture <sf.json>` (unchanged, `source_system: salesforce`) plus new `--capture-m365 <m365.json>`
(`source_system: m365`). Rejected alternative: one mixed file. Reasons: the capture schema has one
`source_system`; each source has its own plan/validate CLI and host procedure; Salesforce validation
(only `dispatch_readonly`/GET) stays untouched; each file is loaded with its own redaction and its own
strict `ReplayMcpClient`, so the two sources cannot consume each other's entries.

### 10.2 `cli/capture-mode.js` changes

- `SOURCE_FLAGS` adds `--capture-m365`, `--m365-mapping`. `resolveSourceOptions` returns
  `{source, capturePath?, m365CapturePath?, m365MappingPath?}`: `--capture-m365`/`--m365-mapping` require
  `--source capture`; `--m365-mapping` requires `--capture-m365`; files must exist (exit 1). Workflow CLIs
  additionally require `--capture` whenever `--source capture` (account resolution uses Salesforce), so
  `--capture-m365` alone is invalid usage there.
- `createCaptureSession(capturePath)` keeps working (string = Salesforce only, identical behaviour). New
  form `createCaptureSession({capturePath, m365CapturePath, m365MappingPath})`:
  Salesforce capture as today (still must be `source_system: salesforce`); M365 capture via
  `loadCapture(path, {redact: M365_REDACT})`, must be `source_system: m365` (else exit 1, "The capture
  is not an M365 capture"); mapping via `loadM365AccountMapping`. Both clients are wrapped by the same
  miss tracker (misses record `tool`). Strict replay, no `reuseLast`, no fixture fallback.
- `deps.evidenceAdapter = createSourceRouterEvidenceAdapter({crm: sfEvidence, internal_document:
  m365Evidence})`: `supportedSources` = its keys; `retrieve` dispatches on `request.source_type`, unknown →
  `UNSUPPORTED_SOURCE`. With no M365 capture the session uses the Salesforce adapter directly (unchanged).
  M365 adapter options: `now: () => new Date(m365Client.capture.created_at)`, `onDiagnostic` → session.
- Session returns `{deps, misses, diagnostics, defaultSources}` with `defaultSources = ["crm"]` or
  `["crm", "internal_document"]` when an M365 capture is present.
- `assertCaptureSources(sources, session-or-options)`: allowed = `crm` (with `--capture`) and
  `internal_document` (with `--capture-m365`); `public_source` and `internal_document` without an M365
  capture are invalid usage (exit 1, message names the missing flag). `--sources internal_document`
  alone is allowed (account still resolved from Salesforce).
- `captureExitCode` prints each diagnostic (§10.4) to stderr, then the existing `REPLAY_INCOMPLETE`
  rule (exit 1); its re-capture hint names `m365-capture-plan` when a missed tool is `sharepoint_search`.

### 10.3 Workflow CLIs

`prepare-first-meeting`, `-v2`, `qualification`: `--sources` default in capture mode =
`session.defaultSources` (replaces `??= ["crm"]`). `prepare-engagement` (initial) and
`opportunity-strategy` (no `--sources`): `requested_sources = session.defaultSources` (replaces the
hard-coded `["crm"]`). Help texts list the two new flags. Exit codes unchanged; an unmapped account or a
mapped one with zero documents gives a clean `empty` `internal_document` source (no failure); an M365
call error makes that source `unavailable`/`unauthorized` and the run `partial`/`blocked` per
`evidence.retrieve`'s existing rules.

### 10.4 Diagnostics (stderr only, counts only, exit code unchanged)

Format `capture: <CODE>: <fixed text with count>`. Codes: `M365_NOT_MAPPED` (no mapping; no M365 call
made; `internal_document` returned no records), `M365_PERSONAL_EXCLUDED` (n hits in personal OneDrive
excluded, user decision 2026-11-05), `M365_OUTSIDE_MAPPING_EXCLUDED` (n), `M365_UNSUPPORTED_ITEMS_SKIPPED`
(n), `M365_COPIES_MERGED` (n), `M365_SEARCH_TRUNCATED` (n searches hit the page cap),
`M365_RECORDS_TRUNCATED` (kept 50 of n). Never names, paths, URLs or snippets. Workflow JSON results
are not modified (no contract change; same reasoning as `REPLAY_INCOMPLETE` in MCP_CAPTURE.md).

### 10.5 `source-rank` CLI capture mode

New options: `--source fixture|capture` (default `fixture`; fixture behaviour, output and tests
unchanged), `--capture PATH` (Salesforce), `--capture-m365 PATH`, `--m365-mapping PATH`,
`--classification public|internal|confidential` (default `internal`, capture mode only). In capture
mode: `--account` is required and must be a resolved id (`sf_001…` 18-char, or a mapped `acct_…` id when
only M365 is given); at least one of `--capture`/`--capture-m365`; `--fixture` is invalid. `--now`
default = the latest `capture.created_at` of the given captures (deterministic).

Flow: build the session (adapters as §10.2); `retrieveEvidence({account_id, questions:
loadDefaultQuestions() mapped to {id, text}, requested_sources: defaultSources-for-given-captures,
context: {permitted_classifications}}, {adapter})` where permitted = `public` → `["public"]`, `internal`
→ `["public","internal"]`, `confidential` → all three; then `rankSources({account_id, records:
data.records, now})`. No claims, no account search.

| Situation | stdout | Exit |
|---|---|---|
| Replay miss in either capture | rank JSON if produced | 1 + `REPLAY_INCOMPLETE` |
| `evidence.retrieve` `failed` | nothing; stderr `source.rank: RETRIEVAL_FAILED: <codes>` | 1 |
| `evidence.retrieve` `blocked` | nothing; stderr codes (e.g. `ADAPTER_UNAUTHORIZED`, `CLASSIFICATION_RESTRICTED`) | 3 |
| retrieval `partial` (one source failed/withheld) | rank result | max(rank exit, 2), stderr `source.rank: PARTIAL_SOURCES` |
| retrieval `success` | rank result | per rank status (0/2/3/1) |
| invalid usage, unreadable capture/mapping | nothing | 1 |

Retrieval errors/warnings and M365 diagnostics go to stderr as codes and counts. JSON and markdown
output formats as today. One provider only (e.g. unmapped account) is a valid ranking of one source.

## 11. Classification

Record classification = max(adapter `classification` (default `internal`), `classification` of every
mapping location the hit matched, and of every merged copy). `public` is never produced or accepted
(`TypeError` at construction / mapping rejected). Filtering stays in `evidence.retrieve`
(`permitted_classifications`; default `public`+`internal`): `confidential` records are withheld unless
explicitly permitted, giving `RECORDS_WITHHELD` / `CLASSIFICATION_RESTRICTED` and the existing
partial/blocked statuses; a `public` ceiling withholds all M365 records. Microsoft 365 permissions of the
host's signed-in user remain the read authorisation; the adapter does not add an ACL model.

## 12. Test plan

Synthetic only: tenant `contoso`, sites `ExampleSales`/`ExampleDelivery`, account
`sf_001SYN0000000001AA` "Northwind Traders (fictional)" (matches `fixtures/salesforce-northwind`),
`driveId` `b!SYN…`, item ids `01SYN…`. Fixtures `fixtures/m365-<scenario>/capture.json` (+ `mapping.yaml`,
`expected.json`); helper `tests/helpers/m365-capture.js` with `m365Hit({...})`, `m365Page(hits, trailer)`
(builds the multi-block `content` result), `m365Error(status, {retryAfter})`. Test files:
`m365-mapping.test.js`, `m365-search-result.test.js`, `m365-evidence-adapter.test.js`,
`m365-claim-extractor.test.js`, `m365-capture-cli.test.js`, `m365-workflow.test.js`,
`source-rank-capture.test.js`.

| Area | Cases |
|---|---|
| Mapping | example file validates, `status: provisional`, only `contoso`/`SYN` values; reject: OneDrive host `contoso-my.sharepoint.com`, a `/personal/` segment, root-site path (no `/sites/`), `http:`, query/fragment, `%20`-encoded prefix, `..`, duplicate account, duplicate prefix, 11 locations, bad account id, `classification: public`, unknown key; rejection messages contain no URL. |
| Plan/args | distinct folder names in order; two locations sharing a folder name → one search; `search_folder_name` override; exact args `{query:"*", folderName, limit:50, offset:0}`; plan calls === adapter `client.calls` for page 1; unmapped → no calls. |
| Unmapped | `retrieve` makes zero calls, `{ok:true, records:[]}`, one `M365_NOT_MAPPED` diagnostic; workflow stays non-failed. |
| Post-filter | hits outside every prefix dropped and counted; sibling-prefix (`Northwind2`) not matched; case-insensitive match; root-site hit dropped as outside. |
| Personal | `contoso-my.sharepoint.com/personal/...` hits dropped and counted as `M365_PERSONAL_EXCLUDED` even when a (hand-built, unvalidated) location would match; no name/path in diagnostics or stderr. |
| Pagination | `moreResults` → next call with `offset = nextOffset` (< offset+50 case); stop on final trailer; empty `{content:[]}`; page cap 4 → truncated flags + diagnostic; bad `nextOffset` (≤ offset, > 1000, non-integer) → malformed; missing page → `replay_unmatched` → CLI exit 1. |
| Result parsing | trailer not last, non-JSON block, unknown object, `structuredContent`, non-`file:///` uri (skipped and counted), `uri` inconsistent with `driveId/id`, bad date → malformed. |
| Mapping to records | every §5.1 field; schema-valid; `record_id` golden hash; `source_uri` encoded; `occurred_at` set, `published_at` null; metadata flat, no snippet; `question_ids: []`. |
| Snippet | `<c0>`/`</c0>` removed, `<ddd/>` → ` ... `, whitespace collapsed, 300-char cut with ` [truncated]`, `summary` fallback, null summary archive, snippet equal to file name omitted, label line present; snippet text never appears in claims, metadata, diagnostics. |
| Copies | same name + same timestamp under two ids → one record, survivor by smallest `webUrl`, `m365_copy_count: 2`, max classification; same name different timestamp → two records; same item from two searches → one record. |
| Limits/claims | 60 kept hits → 50 records + flags; 12 records → 10 with claims; claims golden strings; all candidates pass `evidence.normalize` with 0 rejections; non-M365 record → `[]`; incomplete metadata → `EXTRACTOR_MALFORMED_RESPONSE`; composite SF+M365 over mixed records. |
| Errors | each §8 row (401, 403, 429, retry-after on 503, 500, 400, 404, no status, replay miss) for both recorded `error` entries and `isError` results; messages fixed; `graphRequestId`/`uriPath` redacted in `McpClientError.payload`; `driveId` in hits not redacted. |
| Classification | default `internal` visible; location `confidential` → withheld by default, visible with confidential ceiling; `public` option throws. |
| Multi-source CLI | first-meeting with `--capture` + `--capture-m365` → both sources in `source_results`, M365 claims cited under "Additional permitted evidence"; without `--capture-m365` → output identical to today (existing tests untouched); `--sources internal_document` without M365 capture → exit 1; `--capture-m365` without `--capture` → exit 1; `--m365-mapping` without `--capture-m365` → exit 1; M365 capture with `source_system: salesforce` → exit 1; engagement/opportunity-strategy default sources include `internal_document`; M365 401 → `partial`/2 with SF ok. |
| source-rank | capture mode ranks `salesforce` and `m365_sharepoint` (M365 `occurred_at` field); SF-only and M365-only runs; unmapped → one source + `M365_NOT_MAPPED`; retrieval partial → exit ≥ 2; blocked → 3; default fixture run byte-identical to today. |
| Plan CLI | `--init-capture` outside `.captures/` refused; `--validate` problems (wrong tool e.g. `read_resource`, extra arg key, `query` not `*`, missing page, wrong `source_system`) → exit 1 with payload-free summary; `--check-mapping` counts only. |
| Policy/determinism | adapter/CLI sources reference no tool name other than `sharepoint_search` (`read_resource`, `sharepoint_folder_search`, send/write/move/delete absent); two runs over the same captures give identical `data` and records (`now` from `created_at`); shuffled hit order in the capture → identical records. |

`npm test` must stay green (585 baseline + new). No live calls in tests.

## 13. Non-goals and open questions

Non-goals: Mode B; `read_resource`/document bodies; SharePoint pages, list items, Teams, mail, OneDrive;
root-site and `/teams/` libraries; free-text (snippet) claims; question routing; adapter-side retries;
author/created metadata (not returned); permission/ACL modelling; account search via M365.

Open questions (business decisions, not design gaps):

1. **Question routing** for SharePoint documents (v1: none; claims appear under "Additional permitted
   evidence"). Which first-meeting questions, if any, may a document's existence answer?
2. **Brief date label**: should the renderer show "Last modified" instead of "Occurred" for
   `internal_document` evidence?
3. **Root-site and `/teams/` libraries**: allow them in the mapping (still excluding OneDrive)?
4. **Salesforce recency symmetry**: should CRM records expose `LastModifiedDate` as a data timestamp
   (a P2 decision change) so both providers are ranked on comparable fields?

## Decisions (2026-11-05) — override earlier sections where they conflict

1. **Personal OneDrive excluded** (user): only SharePoint site libraries. Hits on
   `{tenant}-my.sharepoint.com` or with a `/personal/` segment are dropped (counted, never echoed);
   mapping entries pointing at OneDrive are rejected.
2. **Allowed mapping locations** (user): `/sites/<site>/…` **and** `/teams/<site>/…`. Root-site
   libraries (no `/sites/` or `/teams/`) stay rejected. Hits are post-filtered the same way.
3. **Salesforce data timestamp** (user, changes a P2 decision): Account, Opportunity and Contact
   records set `occurred_at` from `LastModifiedDate`; Task uses `CompletedDateTime`, else
   `ActivityDate`, else `LastModifiedDate`; Event uses `StartDateTime`, else `LastModifiedDate`.
   No SOQL/select-list change (fields already selected), so existing captures stay valid. Content
   lines / labels say "Last modified" where `LastModifiedDate` is the source. This makes
   `source.rank` compare Salesforce and SharePoint on comparable last-modified data.
4. **Open question 1** (orchestrator): v1 routes SharePoint documents to no first-meeting question
   (`question_ids: []`), as designed.
5. **Open question 2** (orchestrator): no renderer change in P4; record content and claim text say
   "Last modified". Revisit renderer labels only if the brief misleads in P5.
