# P2 design: Salesforce adapters (T2a)

Status: design for implementation (sonnet). Date: 2026-11-04. Scope: phase P2 of the plan in
[ORCHESTRATOR_NOTES.md](../ORCHESTRATOR_NOTES.md). Design only: no code, no live calls.

Implements the existing seams without changing them: `AccountAdapter`
([account-adapter.js](../../adapters/account-adapter.js)), `EvidenceAdapter`
([evidence-adapter.js](../../adapters/evidence-adapter.js)) and `ClaimExtractor`
([claim-extractor.js](../../adapters/claim-extractor.js)). Records must pass
`schemas/source-record.schema.json`, `evidence.retrieve` record checks and `evidence.normalize`
candidate checks (excerpt verbatim in `content`; every significant claim token present in the
excerpt; no classification downgrade).

## 0. Fixed decisions (from user/orchestrator) and the policy boundary

- Mode A: the host calls Salesforce `dispatch_readonly` and writes a T1 capture (`mcp-capture/1`);
  the adapters depend **only** on an injected `McpToolClient { listTools, callTool }`, so Mode B can
  reuse them. The adapters call exactly one tool, `dispatch_readonly`, always with `method: "GET"`.
  `dispatch` is never referenced.
- Claims v1: structured fields only, deterministic, no prose parsing, no model.
- `record_id = src_sf_<Id>`; `account_id = sf_<Id>`; CRM default classification `internal`.
- **No business policy by inference.** `StageName` values are org data, not an approved stage
  mapping. `Budget_Status__c`, `Primary_Buyer_Authority__c`, `Awareness_of_Pain__c`,
  `What_s_the_Trigger_and_why_now__c`, `Cost_of_Inaction__c`, `Buying_Path__c` and
  `Qualification_Score__c` are surfaced only as raw CRM field facts (API name + raw value). They are
  never mapped to B-FITT criteria, qualification criteria, compelling-event fields, stage gates,
  scores, offerings or personas, never routed to a question, and never interpreted. Tests enforce
  this (§8).

## 1. Module layout

All new code under `adapters/salesforce/` (ESM, no new dependencies; `yaml` is already used).

| File | Exports | Purpose |
|---|---|---|
| `constants.js` | `SF_TOOL = "dispatch_readonly"`, `DEFAULT_API_VERSION = "v66.0"`, `ACCOUNT_SEARCH_LIMIT = 50`, `DEFAULT_OBJECT_LIMITS`, `ID_PREFIX = {Account:"001", Opportunity:"006", Contact:"003", Task:"00T", Event:"00U"}`, `MAX_PAGES_PER_QUERY = 10` | Frozen constants. |
| `fields.js` | `OBJECTS` (frozen definitions, §3.2), `selectList(objectName)` | Fixed field allow-lists; the only fields ever requested or mapped. |
| `soql.js` | `escapeSoqlLiteral`, `escapeSoqlLike`, `searchTokens`, `buildAccountSearchSoql`, `buildAccountExactSoql`, `buildAccountByIdSoql`, `buildObjectSoql`, `parseSfAccountId` | Pure SOQL builders (§2, §3). |
| `capture-plan.js` | `queryArgs(apiVersion, soql)`, `nextPageArgs(url)`, `accountSearchPlan(term, opts)`, `evidencePlan(accountId, opts)` | Pure canonical-args builders used by the adapters **and** by the P3 CLI (§7). |
| `transport.js` | `runQuery(client, soql, {apiVersion, expectObject, maxRecords})` | One logical query incl. pagination; returns `{ok:true, records, truncated}` or `{ok:false, error}`. Never throws. |
| `errors.js` | `classifySalesforceError(payload)`, `toAdapterError(thrown)` | Salesforce-specific error classification (§6). |
| `format.js` | `formatValue(type, raw)`, `normalizeDateTime(raw)`, `headerLine`, `fieldLine`, `fieldClaim`, `cleanText` | Single source of truth for content lines and claim text (§3.4, §4). |
| `routing.js` | `loadSalesforceRouting()`, `questionIdsFor(routing, objectName, populatedApis, requestedIds)` | Reads `reference/salesforce-question-routing.yaml` (§5). |
| `record-mapper.js` | `mapRecord(objectDef, row, ctx)` | Salesforce row → source record (§3.3). |
| `account-adapter.js` | `createSalesforceAccountAdapter(options)` | `AccountAdapter`. |
| `evidence-adapter.js` | `createSalesforceEvidenceAdapter(options)` | `EvidenceAdapter` for source `crm`. |
| `claim-extractor.js` | `createSalesforceStructuredClaimExtractor()`, `createCompositeClaimExtractor(extractors)` | `ClaimExtractor`s (§4). |
| `index.js` | Re-exports the public factories, `accountSearchPlan`, `evidencePlan`, `escapeSoql*`. | |

T1 imports: `mapMcpError`, `assertMcpToolClient`, and the payload extractor required in §6.1, from
`adapters/mcp/index.js`. Domain helpers `looksLikeDomain` / `normalizeDomain` are imported from
`skills/account-resolve/normalize.js` (pure, no I/O) so the adapter and `account.resolve` agree.

### Constructor options

```js
createSalesforceAccountAdapter({
  client,                    // required McpToolClient; assertMcpToolClient(client) at construction
  apiVersion = "v66.0",      // must match /^v\d{2,3}\.\d$/ else TypeError
})
createSalesforceEvidenceAdapter({
  client,                    // required McpToolClient
  apiVersion = "v66.0",
  now = () => new Date(),    // retrieved_at; P3 passes () => new Date(capture.created_at) in capture mode
  limits = {},               // per-object overrides, may only LOWER DEFAULT_OBJECT_LIMITS (else TypeError)
  classification = "internal",
  objectClassification = {}, // e.g. {Contact: "confidential"}; may only RAISE above `classification` (else TypeError)
  instanceUrl = null,        // e.g. "https://<org>.lightning.force.com"; null => source_uri null
  routing,                   // parsed routing doc; default loadSalesforceRouting()
})
```

`name`: `"salesforce-account-adapter(<apiVersion>)"` / `"salesforce-evidence-adapter(<apiVersion>)"`.
`supportedSources: ["crm"]`. Both adapters catch everything and return `{ok:false, error}`; they
never throw after construction. Neither adapter calls `listTools()` (missing tools surface as T1
`TOOL_NOT_FOUND` on `callTool`).

## 2. AccountAdapter

### 2.1 SOQL vs SOSL: SOQL

SOQL is chosen: verified live (`LIKE` case-insensitive, `\'` escaping works), returns
`totalSize`/`done`, deterministic `ORDER BY`, no search-index latency. SOSL was verified to work but
returns relevance-ordered `searchRecords` without `totalSize/done`, rejects short wildcards
(`INVALID_SEARCH`), and its tokenisation/indexing is opaque, so results are less reproducible for
replay and tests. `account.resolve` already owns scoring, so the adapter only needs a deterministic,
permissive candidate set.

### 2.2 Query selection

`searchAccounts(query, options)` receives the term already reduced by `toSearchTerm` in
`account.resolve`. `options.limit` (resolve passes 25) is **ignored** so canonical args do not depend
on the caller; the adapter returns at most 50 (the contract cap). Term preparation: `cleanText`
(replace control chars and whitespace runs with one space, trim), then cut to 255 code points.

| Case (checked in order) | SOQL `WHERE` clause |
|---|---|
| Term matches `^sf_(001[A-Za-z0-9]{15})$` (exact account ID) | `Id = '<id>'` with `LIMIT 1` |
| `looksLikeDomain(term)` | `Name = '<escapeSoqlLiteral(term)>' OR Website LIKE '%<escapeSoqlLike(normalizeDomain(term))>%'` (§10 item 8) |
| Otherwise | `Name = '<escapeSoqlLiteral(term)>'` followed by ` OR Name LIKE '%<escapeSoqlLike(tok)>%'` for each search token |

`searchTokens(term)`: split on `/[^\p{L}\p{N}]+/u`; drop tokens shorter than 2 characters; drop
(case-insensitively) the legal-suffix list `inc incorporated llc llp ltd limited corp corporation co
company plc gmbh ag sa bv nv pty the`; dedupe case-insensitively keeping first occurrence; keep the
first 6. Zero tokens → the exact `Name =` clause alone. Diacritics are not folded (LIKE does not fold
them); `account.resolve` still scores normalised names.

Exact text (single spaces, this field order):

```text
SELECT Id, Name, Website, BillingCity, BillingState, BillingCountry, Owner.Name FROM Account WHERE <clause> ORDER BY Name ASC, Id ASC LIMIT 50
```

ID case: same SELECT, `WHERE Id = '<id>' LIMIT 1` (no ORDER BY). Example for term
`Northwind Traders, Inc.` → resolve sends `Northwind Traders`:
`... WHERE Name = 'Northwind Traders' OR Name LIKE '%Northwind%' OR Name LIKE '%Traders%' ORDER BY Name ASC, Id ASC LIMIT 50`.

**Truncation guard (name case only):** if the first query returns exactly 50 rows and none has
`Name.trim().toLowerCase() === term.toLowerCase()`, run one supplementary query
`... WHERE Name = '<lit>' ORDER BY Name ASC, Id ASC LIMIT 50`; result = supplementary rows first,
then first-query rows, deduped by `Id`, cut to 50. This keeps an exact name reachable when token
over-match fills the limit.

### 2.3 Escaping

`escapeSoqlLiteral(s)`: replace in this order `\` → `\\`, `'` → `\'`, `"` → `\"`, `\n` → `\n`
(literal backslash-n), `\r` → `\r`, `\t` → `\t`, then remove other C0 controls. `escapeSoqlLike(s)`:
`escapeSoqlLiteral(s)` then `%` → `\%`, `_` → `\_`. Tokens cannot contain `'`, `\`, `%`, `_` (they
split on non-letters/digits), but escaping is applied everywhere as defence in depth. IDs are never
escaped; they are inserted only after the regex check.

### 2.4 Ambiguity semantics

The adapter over-matches and never decides. `account.resolve` keeps its rules unchanged: only exact
ID, exact stored name, normalised name or authoritative domain resolves; a single fuzzy candidate →
`confirmation_required`; several credible (including two identical names) → `ambiguous`; none →
`not_found`. The confirmation path ("call again with the exact account ID") works because
`sf_<Id>` triggers the ID query and `exact_id` matches. Only 18-character IDs are accepted (a
15-character ID falls through to name search and will not resolve).

### 2.5 Row → `AdapterAccount`

| AdapterAccount | Source | Rule |
|---|---|---|
| `account_id` | `Id` | `sf_${Id}`; `Id` must match `^001[A-Za-z0-9]{15}$` else whole result `ADAPTER_MALFORMED_RESPONSE`. |
| `name` | `Name` | As stored (no trim/rewrite). Non-string or blank → `ADAPTER_MALFORMED_RESPONSE`. |
| `domain` | `Website` | `normalizeDomain(Website)` if `looksLikeDomain` of it is true; else omitted. |
| `location` | `BillingCity`, `BillingState`, `BillingCountry` | Non-blank parts (after `cleanText`) joined with `", "`; omitted if none. |
| `owner_name` | `Owner.Name` | `cleanText`; omitted if null/blank or `Owner` null. |
| `active` | — | Always omitted (no standard field; custom `InActive_Customer__c` is not interpreted). |

Null, `undefined`, `""` and whitespace-only are all "absent": the property is omitted, never set to
`""` or `null`. Result order = SOQL order. Empty result → `{ok:true, accounts:[]}`.
`body.records[*].attributes.type` must be `"Account"`.

## 3. EvidenceAdapter (`source_type: "crm"` only)

`retrieve(request)`: `request.source_type !== "crm"` → `{ok:false, error:{code:"UNSUPPORTED_SOURCE",
retryable:false}}`. `parseSfAccountId(request.account_id)` must match `^sf_(001[A-Za-z0-9]{15})$`
else `{code:"ADAPTER_UNAVAILABLE", retryable:false, details:{reason:"invalid_account_id"}}` with no
call made. Then run the five object queries **sequentially in the fixed order Account, Opportunity,
Contact, Task, Event**. The first failing query fails the whole source with that error (fail closed:
no partial record set that silently hides a failure). Classification filtering stays in
`evidence.retrieve` (no adapter-side filter); Salesforce sharing/FLS of the connector user is the
read authorisation.

### 3.1 Scoping and SOQL

`<sel>` is the object's select list (§3.2), `<id>` the validated Account Id.

| Object | SOQL (exact) | Keep | source_type |
|---|---|---|---|
| Account | `SELECT <sel> FROM Account WHERE Id = '<id>' LIMIT 1` | 1 | `crm_record` |
| Opportunity | `SELECT <sel> FROM Opportunity WHERE AccountId = '<id>' ORDER BY CloseDate DESC, Id ASC LIMIT 201` | 200 | `crm_record` |
| Contact | `SELECT <sel> FROM Contact WHERE AccountId = '<id>' ORDER BY Name ASC, Id ASC LIMIT 101` | 100 | `crm_record` |
| Task | `SELECT <sel> FROM Task WHERE AccountId = '<id>' ORDER BY ActivityDate DESC NULLS LAST, Id ASC LIMIT 101` | 100 | `crm_activity` |
| Event | `SELECT <sel> FROM Event WHERE AccountId = '<id>' ORDER BY StartDateTime DESC NULLS LAST, Id ASC LIMIT 51` | 50 | `crm_activity` |

Task/Event scoping decision: **`AccountId` only**. Salesforce derives `Task.AccountId`/`Event.AccountId`
from `WhatId` (Account or Opportunity) or `WhoId` (Contact); live, both Tasks have `WhatId` → an
Opportunity and `AccountId` populated. This needs one call per object, no semi-join on the
polymorphic `WhatId`, and covers activities logged on the account's Opportunities. Activities
attached only to custom objects without a contact are out of scope (non-goal).
`LIMIT keep+1` detects truncation: if more than `keep` rows arrive, keep the first `keep` and set
`metadata.sf_truncated = true` on each kept record of that object. Total ≤ 451 < 500 (contract cap).
`limits` overrides lower `keep` (SOQL `LIMIT keep+1` changes accordingly; P3 plan must use the same
limits).

Pagination: if `body.done === false`, `nextRecordsUrl` must match
`^/services/data/v\d+\.\d+/query/[A-Za-z0-9-]+$` (else `ADAPTER_MALFORMED_RESPONSE`); call
`dispatch_readonly` with `nextPageArgs(url)` = `{url, method:"GET"}` (no `queryParams` key). Stop when
`done` is true, `keep+1` rows are accumulated, or `MAX_PAGES_PER_QUERY` pages are read (then
`truncated = true`). In Mode A **each page is a separate captured call**. Response checks per page:
`body` object (if a string, `JSON.parse` once), `records` array, `done` boolean; each row
`attributes.type === <object>`, `Id` matching `^<prefix>[A-Za-z0-9]{15}$`; violations →
`ADAPTER_MALFORMED_RESPONSE` for the source. Keys not in the select list are ignored, never mapped.

### 3.2 Field allow-lists

Roles: **C** structured claim field (content line + claim), **F** free text (content only, no claim
in v1), **M** metadata only, **K** key/identity. Custom fields use the API name as label (no invented
labels). Types drive formatting (§3.4). Only fields verified to exist in `relevantz--newuat` are listed.

Notation `API "Label" type`; `(api)` = label is the API name. Every object also selects `Id`,
`CreatedDate`, `LastModifiedDate` (M, datetime); non-Account objects select `AccountId` (K).

| Object | K (record name) | C fields | F fields | Extra M |
|---|---|---|---|---|
| Account | `Name` | `Industry "Industry" picklist`, `Type "Account Type" picklist`, `Website "Website" url`, `NumberOfEmployees "Employees" int`, `AnnualRevenue "Annual Revenue" currency`, `BillingCity "Billing City" string`, `BillingState "Billing State/Province" string`, `BillingCountry "Billing Country" string`, `Owner.Name "Account Owner" string` | `Description "Description"` | — |
| Opportunity | `Name` | `StageName "Stage" picklist` (raw org value), `Amount "Amount" currency`, `CloseDate "Close Date" date`, `Probability "Probability" percent`, `ForecastCategoryName "Forecast Category" picklist`, `Type "Opportunity Type" picklist`, `LeadSource "Lead Source" picklist`, `Owner.Name "Opportunity Owner" string`, `Cluster__c (api) picklist`; raw facts per §0: `Qualification_Score__c (api) double`, `Budget_Status__c`, `Primary_Buyer_Authority__c`, `Awareness_of_Pain__c`, `What_s_the_Trigger_and_why_now__c`, `Cost_of_Inaction__c`, `Buying_Path__c` (all `(api) picklist`) | `NextStep "Next Step"`, `Description "Description"` | — |
| Contact | `Name` | `Title "Title" string`, `Department "Department" string` | — | — |
| Task | `Subject` | `Status "Status" picklist`, `Priority "Priority" picklist`, `Type "Task Type" picklist`, `ActivityDate "Due Date" date`, `Owner.Name "Assigned To" string` | `Description "Comments"` | `WhatId`, `WhoId`, `CompletedDateTime` |
| Event | `Subject` | `StartDateTime "Start" datetime`, `EndDateTime "End" datetime`, `Location "Location" string`, `Type "Event Type" picklist`, `Owner.Name "Assigned To" string` | `Description "Description"` | `WhatId`, `WhoId` |

Select-list order (exact): `Id`, record name, `AccountId` (non-Account), C fields in table order, F
fields, extra M fields, `CreatedDate`, `LastModifiedDate`. Account search uses its own list (§2.2).

Fields are joined with `", "`.
**Contact minimisation:** Email, Phone, MobilePhone, HomePhone, OtherPhone, AssistantPhone,
AssistantName, Fax, Mailing\*/Other\* address fields, Birthdate, Description, ReportsToId,
HasOptedOutOfEmail, Salutation are never selected, even if populated. Booleans (mostly
default-`false` custom flags) and the ~100 sparse custom Account fields are excluded in v1.
**"Field not permitted"** is expressed structurally: anything outside this table is never requested
or mapped. If the connector user cannot see an allow-listed field, Salesforce answers
`400 INVALID_FIELD`, which fails the `crm` source as `ADAPTER_UNAUTHORIZED` with
`details.reason = "field_not_accessible"` and the field/object names (§6). No silent field dropping
and no runtime describe (payloads are 150–320 KB).

### 3.3 Row → source record

| Source record field | Rule |
|---|---|
| `record_id` | `src_sf_${Id}` |
| `account_id` | `request.account_id` when the row belongs to the account (Account: `Id` = requested Id; others: `AccountId` = requested Id); otherwise `sf_${row.AccountId ?? "missing"}` so `evidence.retrieve` rejects it visibly as foreign. |
| `source_type` | Per §3.1 table. |
| `title` | `"<Object>: <record name>"`, record name = `cleanText(Name or Subject)`, fallback `(no name)` / `(no subject)`; cut to 500 chars. |
| `content` | §3.4. Always non-empty (header line). |
| `source_uri` | `instanceUrl ? \`${instanceUrl}/lightning/r/<Object>/<Id>/view\` : null` |
| `published_at` | `null` (CRM records are not publications). |
| `occurred_at` | Task: `normalizeDateTime(CompletedDateTime)` or `null`; Event: `normalizeDateTime(StartDateTime)` or `null`; others `null`. Dates are never promoted to date-times. |
| `retrieved_at` | `now().toISOString()`, same value for every record of one `retrieve` call. |
| `access_classification` | `objectClassification[Object] ?? classification` (default `internal`). |
| `question_ids` | `questionIdsFor(...)` (§5), only IDs present in `request.questions`. |
| `metadata` | Flat scalars: `provider:"salesforce"`, `object_name`, `record_type` (lower-case object), `sf_id`, `sf_api_version`, `sf_record_name`, `sf_fields_json` (JSON string of `[{api,label,value}]` for C fields with values, content order), `sf_null_fields` (comma-joined API names of C/F fields that were absent), `sf_created_date`, `sf_last_modified_date` (normalised), Task/Event: `sf_what_id`, `sf_what_object` (from ID prefix: Account/Opportunity/Contact else `other`), `sf_who_id`; `sf_truncated:true` only when truncated. Null metadata values are omitted. |

Null/empty handling: null, missing, `""` or whitespace-only values are absent: no content line, no
claim, listed in `sf_null_fields`. The adapter never emits a gap; `gap.detect` derives gaps from
missing claims. A record with no populated C/F field is still emitted (its existence is evidence).

### 3.4 Content and value formatting (`format.js`)

```text
Salesforce Opportunity "Phoenix Upgrade"                        <- headerLine
Opportunity "Phoenix Upgrade" - Stage [StageName]: Awareness    <- fieldLine, standard field
Opportunity "Phoenix Upgrade" - Budget_Status__c: Approved      <- fieldLine, custom (label == api)
Free text (no structured claims):                               <- only if an F field has a value
Description [Description]: <cleanText(value), max 4000 chars, then " [truncated]" if cut>
```

Lines are joined with `\n`. `fieldLine = <Object> "<name>" - <label>[ [<api>]]: <value>` (the
`[api]` part only when label ≠ api). `cleanText`: control chars and whitespace runs → one space, trim.
If the whole content would exceed 20,000 chars, free-text values are cut further (structured lines
are never cut; they are bounded by field lengths).

| Type | Formatting of `value` |
|---|---|
| string, picklist, combobox, url, textarea | `cleanText(raw)`; raw picklist API value (no `toLabel`, no mapping). |
| multipicklist | raw `a;b` string, `cleanText`. |
| int, double, currency | `String(raw)` for finite numbers (no grouping, no currency symbol/code: the org has no `CurrencyIsoCode`; currency is not inferred). |
| percent | `` `${String(raw)}%` `` |
| date | raw `YYYY-MM-DD` (validated by regex). |
| datetime | `normalizeDateTime`: Salesforce `2026-03-01T10:00:00.000+0000` → `new Date(raw).toISOString()` (`2026-03-01T10:00:00.000Z`); invalid → `ADAPTER_MALFORMED_RESPONSE`. |

A value of the wrong JSON type for its declared type (e.g. object for string) →
`ADAPTER_MALFORMED_RESPONSE` for the source (no repair).

## 4. Structured claim extractor

`createSalesforceStructuredClaimExtractor()` → `ClaimExtractor` named
`salesforce-structured-claim-extractor`. `extract(record)`:

1. `record.metadata?.provider !== "salesforce"` → `{ok:true, candidates:[]}`.
2. `JSON.parse(metadata.sf_fields_json)` must be an array of `{api,label,value}` strings; otherwise
   `{ok:false, error:{code:"EXTRACTOR_MALFORMED_RESPONSE", retryable:false}}`.
3. Candidates, in order: for non-Account objects one existence candidate
   `{claim: headerLine, excerpt: headerLine}`; then per field
   `{claim: fieldClaim(...), excerpt: fieldLine(...)}`. All with `completeness:"complete"`
   (→ confidence `high`), no `conflict_key` (different records are not conflicts), no
   `access_classification` (inherits the record's).

`fieldClaim = <Object> "<name>" <label>: <value>` — the field line minus ` -` and `[api]`, e.g.
`Opportunity "Phoenix Upgrade" Stage: Awareness`. Why `evidence.normalize` accepts it: the excerpt is
built by the same `format.js` functions that built `content`, so it occurs verbatim; the claim's
significant tokens are a subset of the excerpt's tokens (only `-` and `[api]` are removed). The
skill still verifies both; any formatter drift shows up as `excerpt_not_found`/`unsupported_claim`
rejections, never as silent acceptance. The extractor reads only `metadata` + shared formatters; it
does not parse `content`, and it never reads F fields.

**Extension point (not implemented in v1):** `createCompositeClaimExtractor([a, b, ...])` calls each
extractor in order, concatenates candidates, returns the first `ok:false` (or thrown error mapped to
`EXTRACTOR_UNAVAILABLE`), and returns `EXTRACTOR_MALFORMED_RESPONSE` if the total exceeds 100. v1
wires `[structured]`. A later host-candidate extractor (host-proposed `{claim, excerpt}` per
`record_id`, typically quoting F-field text that is already in `content`) is appended to this list;
`evidence.normalize` validates those verbatim exactly as today, so no contract change is needed.

## 5. Question → field routing reference

Path `reference/salesforce-question-routing.yaml`, loaded by `adapters/salesforce/routing.js` with the
`yaml` package (same pattern as `reference/account-intelligence.js`). Header follows the existing
reference conventions (`offerings.yaml`): `version` semver, `status: provisional`,
`business_owner: TBD`, `approver: TBD`, `approval_date: null`, `source_documents: []`,
`effective_date: null`, `change_history`. Initial content:

```yaml
# Provisional routing of Salesforce objects/fields to first-meeting reference questions.
# Relevance hints only: a route is not an answer, a finding, or business policy.
version: 0.1.0
status: provisional
business_owner: TBD
approver: TBD
approval_date: null
source_documents: []
effective_date: null
question_set: first-meeting-questions@0.1.0
source_system: salesforce
change_history:
  - version: 0.1.0
    date: 2026-11-04
    change: Initial provisional routing for the P2 Salesforce adapters; pending business review.
routes:
  - question_id: FM-CTX-001
    object: Account
    when: any_populated
    fields: [Industry, Website, BillingCity, BillingState, BillingCountry, Description]
  - question_id: FM-CTX-002
    object: Account
    when: any_populated
    fields: [NumberOfEmployees, AnnualRevenue]
  - question_id: FM-STK-002
    object: Account
    when: any_populated
    fields: [Owner.Name]
  - question_id: FM-REL-001
    object: Opportunity
    when: record_exists
  - question_id: FM-REL-001
    object: Task
    when: record_exists
  - question_id: FM-REL-001
    object: Event
    when: record_exists
  - question_id: FM-STK-001
    object: Contact
    when: record_exists
```

Semantics: a record gets `question_id` when a route for its object matches (`record_exists`, or
`any_populated` with at least one listed field having a value) **and** the ID is in
`request.questions`; result sorted and deduped. Unrouted questions (e.g. FM-DEV-\*, FM-SVC-\*,
FM-REL-002/003, FM-CTX-003) stay unanswered — that is correct, not a defect. No route may reference
the §0 raw-fact fields or `StageName`. Bumping the file requires a `change_history` entry.
Note: `question_ids` are record-level, so every claim of a record inherits all its record's IDs
(e.g. an Account `Industry` claim also carries FM-STK-002 if the owner is populated). See open
question 1.

## 6. Error handling

### 6.1 Requirements on T1 (`adapters/mcp/`)

Checked against the T1 worktree (commit `636c47a`); T1 must provide:

- **R1** A non-classifying payload extractor, e.g. `extractToolPayload(result) → {ok:true, payload,
  isError} | {ok:false, error: ADAPTER_MALFORMED_RESPONSE}` (structuredContent, else single JSON text
  block, else the bare object). Alternatively fix `unwrapToolResult`: today `connectorErrorShape`
  matches any integer `status_code`, so a successful `{status_code:200, body, url}` (bare or
  text-embedded) is mapped to an error. 2xx without `error_code` must be success.
- **R2** Recorded capture errors are thrown as `McpClientError("TOOL_ERROR")` with the raw `payload`
  (present).
- **R3** `mapMcpError` keeps: `REPLAY_UNMATCHED`/`TOOL_NOT_FOUND` → `ADAPTER_UNAVAILABLE`,
  `retryable:false`; other transport errors → `ADAPTER_UNAVAILABLE`, `retryable:true` (present).
- **R4** Replay matching = tool name + `canonicalize(args)` (sorted keys, `undefined` dropped);
  capture `tool` is the bare name `dispatch_readonly`; repeated identical calls reuse the last
  entry (present). The Salesforce adapters never put `undefined`/`null` keys into args.

### 6.2 Salesforce classification (`errors.js`)

Per call: `callTool` throws → if `code === "TOOL_ERROR"` and `payload` exists, classify the payload
below; else `mapMcpError(thrown)`. Resolved → R1 payload; if `isError`, `error_code` present, or
`status_code` not 2xx → classify; else read `body`. Error `body` is a **JSON string** and is parsed
again (`[{message, errorCode}]`); parse failure → `errorCode` unknown.

| HTTP | Salesforce `errorCode` | Adapter code | retryable | `details.reason` |
|---|---|---|---|---|
| 401 | `INVALID_AUTH_HEADER` (seen transiently, "INVALID_SCOPES") | ADAPTER_UNAVAILABLE | true | `transient_auth` |
| 401 | any other (`INVALID_SESSION_ID`, …) | ADAPTER_UNAUTHORIZED | false | `unauthenticated` |
| 403 | `REQUEST_LIMIT_EXCEEDED` | ADAPTER_UNAVAILABLE | true | `rate_limited` |
| 403 | any other (`INSUFFICIENT_ACCESS`, `API_DISABLED_FOR_ORG`, …) | ADAPTER_UNAUTHORIZED | false | `forbidden` |
| 400 | `INVALID_FIELD` | ADAPTER_UNAUTHORIZED | false | `field_not_accessible` (+ `field`, `object` parsed from `No such column '<f>' on entity '<o>'`) |
| 400 | `INVALID_TYPE` | ADAPTER_UNAUTHORIZED | false | `object_not_accessible` |
| 400 | `MALFORMED_QUERY`, `INVALID_SEARCH`, any other | ADAPTER_UNAVAILABLE | false | `query_rejected` |
| 404 | `NOT_FOUND` / any | ADAPTER_UNAVAILABLE | false | `endpoint_not_found` |
| 408, 429, 5xx | any | ADAPTER_UNAVAILABLE | true | `transient` |
| other / no status | — | `mapMcpError(payload)` | per T1 | per T1 |
| 2xx, unusable body | — | ADAPTER_MALFORMED_RESPONSE | false | `malformed_body` |
| replay miss | — | ADAPTER_UNAVAILABLE | false | `replay_unmatched` (capture incomplete; re-capture) |

`details` also carries `status_code`, `sf_error_code`, `object`. **Messages never echo Salesforce
`message` text** (it contains the SOQL, i.e. the searched account name); they are fixed strings plus
the parsed field/object name. No adapter-side retries in v1: in Mode A the host retries a transient
401 at capture time and records only the final outcome for that call (§7). Known contract quirk
(unchanged): `account.resolve` marks every `ADAPTER_UNAVAILABLE` as retryable.

## 7. Capture contract for the host (canonical args)

Every call: tool `dispatch_readonly`; args exactly `{url, method:"GET", queryParams:{q}}` with
`url = "/services/data/v66.0/query"` and `q` byte-identical to the builders' output; pagination calls
are `{url: <nextRecordsUrl>, method: "GET"}`. The host must **not** hand-write SOQL: P3 exposes the
pure builders (`accountSearchPlan`, `evidencePlan`) as a CLI subcommand that prints the args JSON to
copy verbatim. Host rules: record every call's raw result (success or error payload) as one entry in
call order; on a transient 401 retry the identical call and keep only the final attempt; follow and
record every `nextRecordsUrl` immediately after its query; record `captured_at`; never call
`dispatch`, `describe`, or any other tool for the library.

Phase 1 — account search for reference `R` (term `t = toSearchTerm(R)`):

1. `queryArgs("v66.0", buildAccountSearchSoql(t))` (ID, domain or name variant per §2.2).
2. Only if call 1 returned exactly 50 rows and none equals `t` by trimmed case-insensitive name:
   `queryArgs("v66.0", buildAccountExactSoql(t))`.
3. Any `nextRecordsUrl` pages (not expected below 2,000 rows).

If `account.resolve` returns `confirmation_required`/`ambiguous`, the user picks an ID; the host then
captures the ID query for `sf_<Id>` (step 1, ID variant) before re-running.

Phase 2 — evidence for resolved `sf_<Id>` (same limits as the adapter run): the five §3.1 queries in
order Account, Opportunity, Contact, Task, Event, each followed by its pages. Event is always
queried (0 rows today). Example (fictional):

```json
{"tool":"dispatch_readonly","args":{"url":"/services/data/v66.0/query","method":"GET","queryParams":{"q":"SELECT Id, Name, Website, BillingCity, BillingState, BillingCountry, Owner.Name FROM Account WHERE Name = 'Northwind Traders' OR Name LIKE '%Northwind%' OR Name LIKE '%Traders%' ORDER BY Name ASC, Id ASC LIMIT 50"}},"result":{"status_code":200,"body":{"totalSize":1,"done":true,"records":[{"attributes":{"type":"Account","url":"/services/data/v66.0/sobjects/Account/001SYN0000000001AA"},"Id":"001SYN0000000001AA","Name":"Northwind Traders","Website":null,"BillingCity":null,"BillingState":null,"BillingCountry":null,"Owner":{"attributes":{"type":"User"},"Name":"Avery Example"}}]},"url":"/services/data/v66.0/query"},"captured_at":"2026-11-04T10:00:00Z"}
```

## 8. Test plan

Synthetic only: fictional names (Northwind Traders, Northwind Logistics, Fabrikam Example, Avery
Example), IDs `001SYN…`, `006SYN…`, `003SYN…`, `00TSYN…`, `00USYN…` (18 chars). Fixtures:
`fixtures/salesforce-<scenario>/capture.json` (`mcp-capture/1`, loaded with T1 `loadCapture`) +
`expected.json`; mix of bare connector payloads and MCP text envelopes. Helper
`tests/helpers/salesforce-capture.js` builds `sfOk(object, rows, {done, nextRecordsUrl})` and
`sfError(status, errorCode, message)` (body as JSON **string**). Test files:
`tests/salesforce-soql.test.js`, `salesforce-account-adapter.test.js`,
`salesforce-evidence-adapter.test.js`, `salesforce-claim-extractor.test.js`,
`salesforce-routing.test.js`, `salesforce-workflow.test.js`.

| Area | Cases |
|---|---|
| SOQL/escaping | `O'Brien\Co_50%` → literal `O\'Brien\\Co_50%`, LIKE `O\'Brien\\Co\_50\%`; newline/tab; token rules (short, suffix, dedupe, cap 6, Unicode); exact SOQL strings for name/ID/domain/supplementary and all five evidence queries; plan output === adapter `client.calls` args. |
| Account | unique exact match → resolve `success`; ambiguous (Northwind Traders/Logistics, and two identical names) → `blocked ambiguous`; single fuzzy → `confirmation_required`, then `sf_<Id>` → ID query resolves; no match (0 rows) → `not_found`; 50-row truncation triggers supplementary query; empty/whitespace optional fields omitted; malformed Id/blank Name → `ADAPTER_MALFORMED_RESPONSE`. |
| Evidence | full record mapping (all §3.3 fields, schema-valid); sparse/null fields → no lines, `sf_null_fields`; no contacts; no activity (Task/Event 0 rows, Event always called); Task with `WhatId` 006… and `AccountId` → included, `sf_what_object:"Opportunity"`; foreign `AccountId` row → rejected by `evidence.retrieve`; pagination `done:false` → second captured call, merged; missing page → `replay_unmatched`; `keep+1` truncation flag; Contact never selects Email/Phone even if present in the row; `public_source` → `UNSUPPORTED_SOURCE`; invalid account id → no call. |
| Errors | each §6.2 row (401 transient vs other, 403, 400 INVALID_FIELD with field name and no SOQL in message, INVALID_TYPE, MALFORMED_QUERY, INVALID_SEARCH, 404, 429/503, TOOL_NOT_FOUND, REPLAY_UNMATCHED, success-shaped body without `records`); both thrown (`TOOL_ERROR`) and resolved error payloads; error in Contact query fails whole source. |
| Claims | every candidate passes `evidence.normalize` (0 rejections) for each fixture; claim text/excerpt golden strings incl. percent, currency, date, datetime, picklist, custom field; non-Salesforce record → `[]`; bad `sf_fields_json` → `EXTRACTOR_MALFORMED_RESPONSE`; composite concatenation/error/100-cap. |
| Classification | default `internal` visible with default permissions; `permitted_classifications:["public"]` → all withheld, `blocked`; `objectClassification:{Contact:"confidential"}` → Contacts withheld only; downgrade option throws at construction. |
| Routing/policy | YAML header (`status: provisional`, `business_owner: TBD`, semver, change_history); every `question_id` exists in `first-meeting-questions.yaml`; every object/field is in `OBJECTS`; no route uses StageName, Qualification_Score__c or the six §0 picklists; adapter source contains no stage/picklist value mapping and no `"dispatch"` tool name; all `client.calls` use `dispatch_readonly` + `GET`. |
| End to end | `prepareFirstMeeting` with Salesforce adapters + structured extractor on replay: `success`/`partial` with cited `[clm_…]`, deterministic across two runs (`now` fixed); ambiguous → `blocked`; capture missing Phase 2 → `failed`, no fixture fallback. |

`npm test` must stay green (369 baseline + new). No live calls in tests.

## 9. Non-goals

Mode B live client; adapter-side retries; SOSL; runtime describe; free-text claim extraction;
Leads, Cases, custom objects, activities linked only via custom objects; currency conversion or
picklist label translation; any CRM write; any B-FITT/qualification/event/stage/offering/persona
mapping; P3 CLI flags and wrapper text (only the plan builders are provided here); M365.

Verification items for P5 (not user decisions): `Owner.Name` traversal on Account/Opportunity and
polymorphic Task/Event owners, `ORDER BY Name` on Contact and `StartDateTime … NULLS LAST` on Event
were not exercised live; if any is rejected, adjust the builder and capture plan together.

## 10. Decisions (2026-11-04) — these override earlier sections where they conflict

1. **Record-level question IDs:** accepted for v1 (over-association documented as a known
   limitation). No field-group split, no contract change.
2. **Contacts:** default classification `internal`, fields minimised to Name, Title, Department
   (user decision). `objectClassification` override stays available.
3. **Raw qualification-like fields** (`Qualification_Score__c` + six picklists): **included as raw
   facts only** (user decision) — never routed, never mapped to B-FITT/qualification/event/stage;
   tests enforce this. Final (M1, 2026-11-04): raw facts in record content only; excluded from
   claims and the brief (explicit `CLAIM_EXCLUDED_FIELDS` list in the claim extractor, pending
   approved B-FITT policy).
4. **Free text excluded in v1** (user decision, pending privacy review): do NOT select or emit
   `Description` (Account, Opportunity, Contact, Task "Comments", Event), `NextStep`,
   `Lead_Source_Notes__c`, `Comments__c`, or any other textarea/long-text field. The free-text
   column in §3 and the `Description` line in §3.4 and the routing YAML are dropped. Keep the
   composite-extractor extension point so free text can be added later.
5. **`instanceUrl`:** constructor option stays, default `null` (no URL committed); P3 may pass it.
6. **T1 status (supersedes §6.1):** merged on `main` (8649b22). `unwrapToolResult` now returns
   `{ok:true, payload: body, meta:{status_code,url}}` for a 2xx connector envelope (R1 satisfied —
   use it, don't add a separate extractor). Replay is **strict by default** (exhausted entries throw
   `REPLAY_UNMATCHED`, reason `replay_exhausted`; `reuseLast` is opt-in) — R4's "reuse last" no
   longer holds. T1 maps 401 `INVALID_AUTH_HEADER` to `ADAPTER_UNAUTHORIZED`, `retryable:true`;
   the Salesforce layer follows T1 for that row (reason `transient_auth`) instead of §6.2's
   `ADAPTER_UNAVAILABLE`. Recorded error messages are redacted by default in replay.
7. **Short free text (v1 privacy mitigation, pending privacy review):** `Task.Subject`,
   `Event.Subject` and `Event.Location` are not selected. Task record name is
   `<Type or "Activity"> / <Status or "(no status)">`; Event record name is
   `<Type or "Event"> / <StartDateTime date or "(no date)">`. `Opportunity.Name` stays.
8. **Review follow-ups:** select lists are pinned by golden SELECT tests; `Owner.Name` is read by
   path (polymorphic `Owner.attributes.type` may be `Name`); `classification` is `internal` or
   `confidential` only; a domain-shaped term also ORs `Name = '<term>'`; name tokens split on
   `[^\p{L}\p{N}\p{M}]+`; `evidencePlan` shares the adapter's limits validation; a malformed
   `sf_...` reference is a no-match with no call (account.resolve then reports `not_found`); the
   term is trimmed after the 255-code-point cut. The AccountAdapter contract has no warning
   field, so hitting the 50-row cap without an exact name (even after the supplementary query)
   is not surfaced; account.resolve still scores only what is returned.
9. **Brief-size claim limits (user decision 2026-11-04; selection is ordering only, not
   prioritisation policy):** Opportunity claims are limited to `StageName`, `Amount`, `CloseDate`
   (other fields stay in content); claims are capped per object at Opportunity 10, Contact 20,
   Task 10, Event 10 (Account unchanged). Order: primary date desc, nulls last (Opportunity
   `CloseDate`, Task `ActivityDate`, Event `StartDateTime`, Contact none), then `LastModifiedDate`
   desc, then `Id` asc; no stage/status interpretation. The extractor sees one record per call, so
   `createSalesforceEvidenceAdapter` ranks all rows of an object and stamps over-cap records with
   `metadata.sf_claim_excluded: true`; the extractor then returns no candidates for them. Limits
   are `DEFAULT_CLAIM_LIMITS` (constants.js, re-exported by the extractor) and the adapter option
   `claimLimits` (lowering only). No SOQL, select list or contract change.
10. **Data timestamp (user decision 2026-11-05, supersedes the `occurred_at` row of §3.3):** `occurred_at` is
    LastModifiedDate-based; see Decision 3 in [P4_M365_SHAREPOINT_ADAPTER.md](P4_M365_SHAREPOINT_ADAPTER.md).
