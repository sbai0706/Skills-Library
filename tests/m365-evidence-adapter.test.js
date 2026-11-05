import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createM365SharePointEvidenceAdapter, searchArgs, validateM365AccountMapping } from "../adapters/m365/index.js";
import { McpClientError, ReplayMcpClient } from "../adapters/mcp/index.js";
import { retrieveEvidence } from "../skills/evidence-retrieve/index.js";
import { validate } from "../schemas/index.js";
import {
  DELIVERY_PREFIX, NORTHWIND_SF_ID, SALES_PREFIX, m365Entry, m365Error, m365Hit, m365Loaded, m365Page, m365Replay, moreTrailer,
  oneAccount,
} from "./helpers/m365-capture.js";

const NOW = () => new Date("2026-11-05T10:00:00Z");
const loc = (prefix, extra = {}) => ({ web_url_prefix: prefix, ...extra });
const MAPPING = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX), loc(DELIVERY_PREFIX, { search_folder_name: "Northwind" })]));
const SINGLE = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX)]));
const request = (extra = {}) => ({
  account_id: NORTHWIND_SF_ID, questions: [{ id: "FM-CTX-001", text: "a?" }], source_type: "internal_document", context: {}, ...extra,
});

function setup(entries, { mapping = SINGLE, options = {}, loaded = false } = {}) {
  const diagnostics = [];
  const client = loaded ? m365Loaded(entries) : m365Replay(entries);
  const adapter = createM365SharePointEvidenceAdapter({ client, mapping, now: NOW, onDiagnostic: (d) => diagnostics.push(d), ...options });
  return { client, adapter, diagnostics };
}
const page1 = (hits, trailer) => [m365Entry("Northwind Traders", 0, { result: m365Page(hits, trailer) })];
const retrieve = async (entries, config) => {
  const ctx = setup(entries, config);
  return { ...ctx, result: await ctx.adapter.retrieve(request()) };
};
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.records; };
const codes = (diagnostics) => diagnostics.map((d) => d.code);

// ---------------------------------------------------------------- construction

test("construction validates options", () => {
  const client = m365Replay([]);
  assert.throws(() => createM365SharePointEvidenceAdapter({}), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client }), TypeError, "mapping is required");
  assert.throws(() => createM365SharePointEvidenceAdapter({ mapping: SINGLE }), TypeError, "client is required");
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: {} }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, limits: { maxRecords: 51 } }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, limits: { maxRecords: 0 } }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, limits: { maxClaimRecords: 11 } }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, limits: { nope: 1 } }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, now: "yesterday" }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, onDiagnostic: 1 }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, classification: "public" }), TypeError);
  assert.throws(() => createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, classification: "secret" }), TypeError);
  const adapter = createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, limits: { maxRecords: 5, maxClaimRecords: 0 }, classification: "confidential" });
  assert.equal(adapter.name, "m365-sharepoint-evidence-adapter");
  assert.deepEqual(adapter.supportedSources, ["internal_document"]);
});

test("any other source is UNSUPPORTED_SOURCE and makes no call", async () => {
  const { adapter, client } = setup([]);
  const result = await adapter.retrieve(request({ source_type: "crm" }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNSUPPORTED_SOURCE");
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------- unmapped

test("an unmapped account makes no call, returns no records and reports M365_NOT_MAPPED once", async () => {
  const { adapter, client, diagnostics } = setup([]);
  const result = await adapter.retrieve(request({ account_id: "sf_001SYN0000000002AA" }));
  assert.deepEqual(result, { ok: true, records: [] });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(diagnostics, [{ code: "M365_NOT_MAPPED" }]);
});

test("an unmapped account is a clean empty source for evidence.retrieve, not a failure", async () => {
  const { adapter } = setup([]);
  const result = await retrieveEvidence(
    { account_id: "sf_001SYN0000000002AA", questions: [{ id: "FM-CTX-001", text: "a?" }], requested_sources: ["internal_document"], context: {} },
    { adapter },
  );
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.source_results.map((r) => [r.source, r.outcome, r.record_count]), [["internal_document", "empty", 0]]);
});

// ---------------------------------------------------------------- post-filter

test("hits outside every mapped prefix are dropped and counted; a sibling prefix is not matched", async () => {
  const inside = m365Hit({ n: 1 });
  const sibling = m365Hit({ n: 2, folder: `${SALES_PREFIX}2` });
  const rootSite = m365Hit({ n: 3, webUrl: "https://contoso.sharepoint.com/Shared Documents/Northwind Traders/Root.docx" });
  const other = m365Hit({ n: 4, folder: "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Other" });
  const folderItself = m365Hit({ n: 5, webUrl: SALES_PREFIX });
  const { result, diagnostics } = await retrieve(page1([inside, sibling, rootSite, other, folderItself]));
  const records = ok(result);
  assert.deepEqual(records.map((r) => r.metadata.m365_item_id), [inside.id]);
  assert.deepEqual(diagnostics, [{ code: "M365_OUTSIDE_MAPPING_EXCLUDED", count: 4 }]);
});

test("prefix matching is case-insensitive", async () => {
  const shouty = m365Hit({ n: 1, webUrl: `${SALES_PREFIX.toUpperCase().replace("HTTPS", "https")}/Shouting.docx` });
  const records = ok((await retrieve(page1([shouty]))).result);
  assert.equal(records.length, 1);
});

test("a percent-encoded webUrl matches the unencoded mapping prefix; source_uri is always encoded", async () => {
  const encoded = m365Hit({ n: 1, webUrl: `${SALES_PREFIX.replaceAll(" ", "%20")}/Example%20File.docx` });
  const [record] = ok((await retrieve(page1([encoded]))).result);
  assert.equal(record.source_uri, `${SALES_PREFIX.replaceAll(" ", "%20")}/Example%20File.docx`);
  assert.equal(record.metadata.m365_location, "/sites/ExampleSales/Shared Documents/Northwind Traders");
});

test("the post-filter runs against all prefixes of the account, whichever search returned the hit", async () => {
  const delivery = m365Hit({ n: 1, driveId: "b!SYNdrive0002", folder: `${DELIVERY_PREFIX}/Plans` });
  const entries = [
    m365Entry("Northwind Traders", 0, { result: m365Page([delivery]) }),
    m365Entry("Northwind", 0, { result: m365Page([]) }),
  ];
  const records = ok((await retrieve(entries, { mapping: MAPPING })).result);
  assert.equal(records.length, 1, "a hit under the second prefix returned by the first search is kept");
});

// ---------------------------------------------------------------- personal OneDrive

test("personal OneDrive hits are dropped and counted, with nothing identifying in the diagnostics", async () => {
  const personal = m365Hit({ n: 1, name: "Secret Personal File.docx", webUrl: "https://contoso-my.sharepoint.com/personal/someone_contoso_com/Documents/Northwind Traders/Secret Personal File.docx" });
  const personalSegment = m365Hit({ n: 2, name: "Segment Personal.docx", folder: `${SALES_PREFIX}/personal` });
  const fine = m365Hit({ n: 3 });
  const { result, diagnostics } = await retrieve(page1([personal, personalSegment, fine]));
  assert.deepEqual(ok(result).map((r) => r.metadata.m365_item_id), [fine.id]);
  assert.deepEqual(diagnostics, [{ code: "M365_PERSONAL_EXCLUDED", count: 2 }]);
  assert.ok(!JSON.stringify(diagnostics).match(/Secret|someone|contoso|Northwind/));
});

test("personal hits are dropped even when a (hand-built, unvalidated) location would match them", async () => {
  const prefix = "https://contoso-my.sharepoint.com/personal/someone_contoso_com/Documents/Northwind";
  const handBuilt = { status: "provisional", accounts: [{ account_id: NORTHWIND_SF_ID, locations: [{ prefix, key: prefix.toLowerCase(), folder_name: "Northwind", classification: null }] }] };
  const personal = m365Hit({ n: 1, webUrl: `${prefix}/Draft.docx` });
  const entries = [m365Entry("Northwind", 0, { result: m365Page([personal]) })];
  const { result, diagnostics } = await retrieve(entries, { mapping: handBuilt });
  assert.deepEqual(ok(result), []);
  assert.deepEqual(diagnostics, [{ code: "M365_PERSONAL_EXCLUDED", count: 1 }]);
});

// ---------------------------------------------------------------- pagination

test("moreResults continues with offset = nextOffset (which may be below offset + 50) and stops on a final trailer", async () => {
  const a = m365Hit({ n: 1 });
  const b = m365Hit({ n: 2 });
  const c = m365Hit({ n: 3 });
  const entries = [
    m365Entry("Northwind Traders", 0, { result: m365Page([a, b], moreTrailer(2)) }),
    m365Entry("Northwind Traders", 2, { result: m365Page([c]) }),
  ];
  const { result, client, diagnostics } = await retrieve(entries);
  assert.equal(ok(result).length, 3);
  assert.deepEqual(client.calls, [
    { name: "sharepoint_search", args: searchArgs("Northwind Traders", 0) },
    { name: "sharepoint_search", args: searchArgs("Northwind Traders", 2) },
  ]);
  assert.deepEqual(diagnostics, []);
});

test("an empty result ends a search; a trailer-less page is final", async () => {
  const empty = await retrieve([m365Entry("Northwind Traders", 0, { result: { content: [] } })]);
  assert.deepEqual(ok(empty.result), []);
  assert.equal(empty.client.calls.length, 1);
  const noTrailer = await retrieve(page1([m365Hit({ n: 1 })], null));
  assert.equal(ok(noTrailer.result).length, 1);
  assert.equal(noTrailer.client.calls.length, 1);
});

test("the page cap (4 pages) truncates the search: flags on every record and one diagnostic", async () => {
  const pages = [0, 1, 2, 3].map((p) => m365Entry("Northwind Traders", p * 50, {
    result: m365Page([m365Hit({ n: p + 1 })], moreTrailer((p + 1) * 50, 500)),
  }));
  const { result, client, diagnostics } = await retrieve(pages);
  const records = ok(result);
  assert.equal(client.calls.length, 4, "no fifth call");
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.metadata.m365_truncated === true));
  assert.deepEqual(diagnostics, [{ code: "M365_SEARCH_TRUNCATED", count: 1 }]);
});

test("four pages whose last trailer is final are not truncated", async () => {
  const pages = [0, 1, 2, 3].map((p) => m365Entry("Northwind Traders", p * 50, {
    result: p < 3 ? m365Page([m365Hit({ n: p + 1 })], moreTrailer((p + 1) * 50)) : m365Page([m365Hit({ n: 4 })]),
  }));
  const { result, diagnostics } = await retrieve(pages);
  assert.ok(ok(result).every((r) => r.metadata.m365_truncated === undefined));
  assert.deepEqual(diagnostics, []);
});

test("a bad nextOffset is malformed (not greater than offset, above 1000, non-integer, missing)", async () => {
  for (const trailer of [
    { moreResults: true, nextOffset: 0, totalResultCount: 9 },
    { moreResults: true, nextOffset: 1001, totalResultCount: 9 },
    { moreResults: true, nextOffset: 2.5, totalResultCount: 9 },
    { moreResults: true, nextOffset: "50", totalResultCount: 9 },
    { moreResults: true, totalResultCount: 9 },
  ]) {
    const { result, client } = await retrieve(page1([m365Hit({ n: 1 })], trailer));
    assert.equal(result.ok, false, JSON.stringify(trailer));
    assert.equal(result.error.code, "ADAPTER_MALFORMED_RESPONSE");
    assert.equal(result.error.details.reason, "invalid_next_offset");
    assert.equal(client.calls.length, 1);
  }
});

test("a missing page is a replay miss: ADAPTER_UNAVAILABLE with reason replay_unmatched", async () => {
  const { result } = await retrieve(page1([m365Hit({ n: 1 })], moreTrailer(1)));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.error.details.reason, "replay_unmatched");
  assert.equal(result.error.details.tool, "sharepoint_search");
});

test("the same item returned by two searches is one record; each identity counts once in diagnostics", async () => {
  const shared = m365Hit({ n: 1 });
  const outside = m365Hit({ n: 2, folder: "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Other" });
  const entries = [
    m365Entry("Northwind Traders", 0, { result: m365Page([shared, outside]) }),
    m365Entry("Northwind", 0, { result: m365Page([shared, outside]) }),
  ];
  const { result, diagnostics } = await retrieve(entries, { mapping: MAPPING });
  assert.equal(ok(result).length, 1);
  assert.deepEqual(diagnostics, [{ code: "M365_OUTSIDE_MAPPING_EXCLUDED", count: 1 }]);
});

test("the first failing search fails the whole source (no partial record set)", async () => {
  const entries = [
    m365Entry("Northwind Traders", 0, { result: m365Page([m365Hit({ n: 1 })]) }),
    m365Entry("Northwind", 0, { error: m365Error(500) }),
  ];
  const { result } = await retrieve(entries, { mapping: MAPPING });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, "transient");
});

// ---------------------------------------------------------------- strict hit checks

test("a non-file item (page) under a mapped prefix is skipped and counted, not an error", async () => {
  const pageItem = m365Hit({ n: 1, uri: "page:///sites/ExampleSales/pages/01SYNPAGE0001", name: "Example Page.aspx" });
  const { result, diagnostics } = await retrieve(page1([pageItem, m365Hit({ n: 2 })]));
  assert.equal(ok(result).length, 1);
  assert.deepEqual(diagnostics, [{ code: "M365_UNSUPPORTED_ITEMS_SKIPPED", count: 1 }]);
});

test("kept hits that break the strict check make the source malformed", async () => {
  const bad = {
    "uri inconsistent with driveId/id": m365Hit({ n: 1, uri: "file:///b!SYNdrive0001/01SYNOTHER" }),
    "date without Z": m365Hit({ n: 1, lastModified: "2026-09-03T15:28:28+02:00" }),
    "date garbage": m365Hit({ n: 1, lastModified: "yesterday" }),
    "impossible date": m365Hit({ n: 1, lastModified: "2026-13-45T25:61:61Z" }),
    "date missing": m365Hit({ n: 1, lastModifiedDateTime: undefined }),
    "driveId missing": m365Hit({ n: 1, driveId: "" }),
    "id not a string": m365Hit({ n: 1, id: 5, uri: "file:///b!SYNdrive0001/5" }),
    "name blank": m365Hit({ n: 1, name: "  " }),
    "content a number": m365Hit({ n: 1, content: 7 }),
    "summary an object": m365Hit({ n: 1, summary: {} }),
  };
  for (const [label, hit] of Object.entries(bad)) {
    const { result } = await retrieve(page1([hit]));
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, "ADAPTER_MALFORMED_RESPONSE", label);
  }
});

test("a hit without a webUrl is malformed", async () => {
  for (const webUrl of [null, "", 5]) {
    const { result } = await retrieve(page1([{ ...m365Hit({ n: 1 }), webUrl }]));
    assert.equal(result.ok, false);
    assert.equal(result.error.details.reason, "hit_without_web_url");
  }
});

test("null content and summary (archives) are accepted", async () => {
  const [record] = ok((await retrieve(page1([m365Hit({ n: 1, content: null, summary: null })]))).result);
  assert.equal(record.metadata.m365_snippet, undefined);
});

// ---------------------------------------------------------------- hit -> record

test("a hit maps to a schema-valid record with every design field", async () => {
  const hit = m365Hit({ n: 1, name: "Example Proposal.pptx" });
  const [record] = ok((await retrieve(page1([hit]))).result);
  assert.deepEqual(validate("sourceRecord", record), { valid: true, errors: [] });
  assert.equal(record.record_id, "src_m365_656cd6dbd6111e99b80e1bad0532f479");
  assert.equal(record.account_id, NORTHWIND_SF_ID);
  assert.equal(record.source_type, "internal_document");
  assert.equal(record.title, "SharePoint document: Example Proposal.pptx");
  assert.equal(record.source_uri, "https://contoso.sharepoint.com/sites/ExampleSales/Shared%20Documents/Northwind%20Traders/Example%20Proposal.pptx");
  assert.equal(record.published_at, null);
  assert.equal(record.occurred_at, "2026-09-03T15:28:28.000Z");
  assert.equal(record.retrieved_at, "2026-11-05T10:00:00.000Z");
  assert.equal(record.access_classification, "internal");
  assert.deepEqual(record.question_ids, []);
  assert.deepEqual(record.metadata, {
    provider: "m365_sharepoint",
    record_type: "sharepoint_file",
    m365_drive_id: "b!SYNdrive0001",
    m365_item_id: "01SYNITEM0001",
    m365_file_name: "Example Proposal.pptx",
    m365_file_type: "pptx",
    m365_site: "ExampleSales",
    m365_location: "/sites/ExampleSales/Shared Documents/Northwind Traders",
    m365_last_modified: "2026-09-03T15:28:28.000Z",
    m365_snippet: true,
  });
  assert.equal(record.content, [
    'SharePoint document "Example Proposal.pptx"',
    'SharePoint document "Example Proposal.pptx" - File type: pptx',
    'SharePoint document "Example Proposal.pptx" - Location: /sites/ExampleSales/Shared Documents/Northwind Traders',
    'SharePoint document "Example Proposal.pptx" - Last modified: 2026-09-03T15:28:28.000Z',
    "Search snippet (free text from the search index; not a claim; may contain personal or customer data):",
    "Example outline 1 ...",
  ].join("\n"));
  assert.ok(Object.values(record.metadata).every((v) => ["string", "number", "boolean"].includes(typeof v)));
  assert.ok(!JSON.stringify(record.metadata).includes("outline"), "the snippet is never in metadata");
});

test("a /teams/ location works the same way and the site is the segment after /teams/", async () => {
  const teams = validateM365AccountMapping(oneAccount([loc("https://contoso.sharepoint.com/teams/ExampleTeam/Shared Documents/Northwind")]));
  const hit = m365Hit({ n: 1, folder: "https://contoso.sharepoint.com/teams/ExampleTeam/Shared Documents/Northwind/Sub" });
  const entries = [m365Entry("Northwind", 0, { result: m365Page([hit]) })];
  const [record] = ok((await retrieve(entries, { mapping: teams })).result);
  assert.equal(record.metadata.m365_site, "ExampleTeam");
  assert.equal(record.metadata.m365_location, "/teams/ExampleTeam/Shared Documents/Northwind/Sub");
});

test("a file without an extension has no File type line or metadata", async () => {
  const [record] = ok((await retrieve(page1([m365Hit({ n: 1, name: "README", content: null, summary: null })]))).result);
  assert.ok(!record.content.includes("File type"));
  assert.equal(record.metadata.m365_file_type, undefined);
  assert.equal(record.content.split("\n").length, 3);
});

test("file names and locations are cleaned and cut, the mapping label is never emitted", async () => {
  const longName = `${"A".repeat(400)}.docx`;
  const [record] = ok((await retrieve(page1([m365Hit({ n: 1, name: `  Odd\u0007\n  Name ${longName}  `, webUrl: `${SALES_PREFIX}/x.docx` })]))).result);
  assert.equal(record.metadata.m365_file_name.length, 300);
  assert.ok(record.metadata.m365_file_name.startsWith("Odd Name AAAA"));
  assert.ok(!/[\u0000-\u001f]/.test(record.metadata.m365_file_name));
  assert.ok(record.title.length <= 500);
  const labelled = validateM365AccountMapping({ ...oneAccount([loc(SALES_PREFIX)]), accounts: [{ account_id: NORTHWIND_SF_ID, label: "Secret Label Corp", locations: [loc(SALES_PREFIX)] }] });
  const [again] = ok((await retrieve(page1([m365Hit({ n: 1 })]), { mapping: labelled })).result);
  assert.ok(!JSON.stringify(again).includes("Secret Label"));
});

// ---------------------------------------------------------------- snippets

const snippetOf = async (hit) => {
  const [record] = ok((await retrieve(page1([hit]))).result);
  const lines = record.content.split("\n");
  return { record, snippet: lines.length > 4 ? lines.slice(5).join("\n") : null, lines };
};

test("snippets: highlight tags removed, <ddd/> becomes ' ... ', whitespace collapsed, label line present", async () => {
  const { snippet, lines, record } = await snippetOf(m365Hit({ n: 1, content: "<c0>Alpha</c0>\n\n  beta<ddd/>  <c12>gamma</c12><ddd />delta\t end" }));
  assert.equal(snippet, "Alpha beta ... gamma ... delta end");
  assert.equal(lines[4], "Search snippet (free text from the search index; not a claim; may contain personal or customer data):");
  assert.equal(record.metadata.m365_snippet, true);
});

test("snippets: cut at 300 code points plus ' [truncated]'", async () => {
  const { snippet } = await snippetOf(m365Hit({ n: 1, content: "x".repeat(301) }));
  assert.equal(snippet, `${"x".repeat(300)} [truncated]`);
  const exact = await snippetOf(m365Hit({ n: 1, content: "y".repeat(300) }));
  assert.equal(exact.snippet, "y".repeat(300));
  const emoji = await snippetOf(m365Hit({ n: 1, content: "\u{1F600}".repeat(301) }));
  assert.equal([...emoji.snippet].length, 300 + " [truncated]".length);
});

test("snippets: summary is the fallback, a null summary and a snippet equal to the file name give no snippet", async () => {
  const fallback = await snippetOf(m365Hit({ n: 1, content: null, summary: "from <c0>summary</c0>" }));
  assert.equal(fallback.snippet, "from summary");
  const blank = await snippetOf(m365Hit({ n: 1, content: "   ", summary: "from summary" }));
  assert.equal(blank.snippet, "from summary", "a blank content falls back to the summary");
  const none = await snippetOf(m365Hit({ n: 1, content: null, summary: null }));
  assert.equal(none.snippet, null);
  assert.equal(none.record.metadata.m365_snippet, undefined);
  const sameAsName = await snippetOf(m365Hit({ n: 1, name: "Archive File.zip", content: "Archive  File.zip", summary: null }));
  assert.equal(sameAsName.snippet, null);
  const onlyTags = await snippetOf(m365Hit({ n: 1, content: "<c0></c0>" }));
  assert.equal(onlyTags.snippet, null);
});

test("snippet text is a single line: it cannot forge field lines, and never reaches diagnostics", async () => {
  const forged = 'x\nSharePoint document "Fake.docx" - Location: /sites/Evil/Docs';
  const { record, lines } = await snippetOf(m365Hit({ n: 1, content: forged }));
  assert.equal(lines.length, 6);
  assert.ok(lines[5].includes("Fake.docx"), "stays inside the snippet line");
  assert.ok(!record.content.split("\n").slice(0, 5).some((line) => line.includes("Fake")));
});

// ---------------------------------------------------------------- copies and ordering

test("copies (same name + same timestamp) merge: survivor by smallest webUrl, count and max classification", async () => {
  const deliveryMapping = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX), loc(DELIVERY_PREFIX, { search_folder_name: "Northwind", classification: "confidential" })]));
  const copyB = m365Hit({ n: 2, id: "01SYNITEMBBB", name: "Example Proposal.pptx", folder: DELIVERY_PREFIX });
  const copyA = m365Hit({ n: 1, id: "01SYNITEMAAA", name: "example proposal.PPTX", folder: SALES_PREFIX });
  const entries = [
    m365Entry("Northwind Traders", 0, { result: m365Page([copyB, copyA]) }),
    m365Entry("Northwind", 0, { result: m365Page([]) }),
  ];
  const { result, diagnostics } = await retrieve(entries, { mapping: deliveryMapping });
  const records = ok(result);
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.m365_item_id, "01SYNITEMBBB", "contoso.../exampledelivery sorts before .../examplesales");
  assert.equal(records[0].metadata.m365_copy_count, 2);
  assert.equal(records[0].access_classification, "confidential");
  assert.deepEqual(diagnostics, [{ code: "M365_COPIES_MERGED", count: 1 }]);
});

test("same name with a different timestamp stays two records; the survivor tie-break is deterministic", async () => {
  const older = m365Hit({ n: 1, name: "Same Name.docx", lastModified: "2026-01-01T00:00:00.000Z" });
  const newer = m365Hit({ n: 2, name: "Same Name.docx", lastModified: "2026-02-01T00:00:00.000Z" });
  const records = ok((await retrieve(page1([older, newer]))).result);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.occurred_at), ["2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"], "newest first");
  assert.ok(records.every((r) => r.metadata.m365_copy_count === undefined));
});

test("equal timestamps order by record_id; hit order in the capture never matters", async () => {
  const hits = [1, 2, 3, 4, 5].map((n) => m365Hit({ n, lastModified: "2026-03-03T03:03:03.000Z" }));
  const a = ok((await retrieve(page1(hits))).result);
  const b = ok((await retrieve(page1([...hits].reverse()))).result);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((r) => r.record_id), [...a.map((r) => r.record_id)].sort());
});

// ---------------------------------------------------------------- limits

test("60 kept hits give 50 records with truncation flags, a diagnostic, and only 10 with claims", async () => {
  const hits = Array.from({ length: 60 }, (_, i) => m365Hit({ n: i + 1, lastModified: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, name: `Doc ${i + 1}.docx` }));
  const { result, diagnostics } = await retrieve(page1(hits));
  const records = ok(result);
  assert.equal(records.length, 50);
  assert.ok(records.every((r) => r.metadata.m365_truncated === true));
  assert.deepEqual(diagnostics, [{ code: "M365_RECORDS_TRUNCATED", count: 60, kept: 50 }]);
  assert.equal(records.filter((r) => r.metadata.m365_claim_excluded !== true).length, 10);
  assert.ok(records.slice(0, 10).every((r) => r.metadata.m365_claim_excluded === undefined), "the newest ten keep claims");
  assert.ok(records.slice(10).every((r) => r.metadata.m365_claim_excluded === true));
});

test("limits may only lower the defaults", async () => {
  const hits = [1, 2, 3, 4].map((n) => m365Hit({ n, lastModified: `2026-0${n}-01T00:00:00.000Z` }));
  const { result, diagnostics } = await retrieve(page1(hits), { options: { limits: { maxRecords: 3, maxClaimRecords: 1 } } });
  const records = ok(result);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.metadata.m365_claim_excluded === true), [false, true, true]);
  assert.deepEqual(diagnostics, [{ code: "M365_RECORDS_TRUNCATED", count: 4, kept: 3 }]);
});

// ---------------------------------------------------------------- errors

const ERROR_ROWS = [
  [401, undefined, "ADAPTER_UNAUTHORIZED", false, "unauthenticated"],
  [403, undefined, "ADAPTER_UNAUTHORIZED", false, "forbidden"],
  [429, undefined, "ADAPTER_UNAVAILABLE", true, "rate_limited"],
  [503, 7, "ADAPTER_UNAVAILABLE", true, "rate_limited"],
  [500, undefined, "ADAPTER_UNAVAILABLE", true, "transient"],
  [502, undefined, "ADAPTER_UNAVAILABLE", true, "transient"],
  [408, undefined, "ADAPTER_UNAVAILABLE", true, "transient"],
  [400, undefined, "ADAPTER_UNAVAILABLE", false, "request_rejected"],
  [404, undefined, "ADAPTER_UNAVAILABLE", false, "not_found"],
  [418, undefined, "ADAPTER_UNAVAILABLE", false, "graph_error"],
];

for (const [status, retryAfter, code, retryable, reason] of ERROR_ROWS) {
  for (const mode of ["recorded error", "isError result"]) {
    test(`error ${status}${retryAfter ? ` (retry-after ${retryAfter})` : ""} as ${mode} -> ${code}/${reason}`, async () => {
      const payload = m365Error(status, { retryAfter });
      const outcome = mode === "recorded error"
        ? { error: payload }
        : { result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] } };
      const { result } = await retrieve([m365Entry("Northwind Traders", 0, outcome)], { loaded: true });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.equal(result.error.retryable, retryable);
      assert.equal(result.error.details.reason, reason);
      assert.equal(result.error.details.status_code, status);
      assert.equal(result.error.details.graph_error_code, "synthetic_error");
      if (reason === "rate_limited" && retryAfter) assert.equal(result.error.details.retry_after_seconds, retryAfter);
      const text = JSON.stringify(result.error);
      assert.ok(!/secret-file|req-synthetic|SYNdrive|SYNITEM|Synthetic Graph failure|\/sites\//.test(text), `an error echoed a Graph value: ${text}`);
    });
  }
}

test("an error without a usable status falls back to the shared T1 mapping", async () => {
  const noStatus = { code: "INTERNAL_ERROR", message: "boom", details: { graphErrorCode: "x" } };
  const { result } = await retrieve([m365Entry("Northwind Traders", 0, { error: noStatus })]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.error.details.reason, "tool_error");
});

test("top-level Graph keys are accepted as well as details.*", async () => {
  const flat = { code: "INTERNAL_ERROR", message: "x", graphStatusCode: 403, graphErrorCode: "accessDenied" };
  const { result } = await retrieve([m365Entry("Northwind Traders", 0, { error: flat })]);
  assert.equal(result.error.code, "ADAPTER_UNAUTHORIZED");
  assert.equal(result.error.details.graph_error_code, "accessDenied");
});

test("a graph error code that is not identifier-shaped is not echoed", async () => {
  const payload = m365Error(500, { graphErrorCode: "has spaces / and a path.docx" });
  const { result } = await retrieve([m365Entry("Northwind Traders", 0, { error: payload })]);
  assert.equal(result.error.details.graph_error_code, undefined);
});

test("replay misses: unmatched and exhausted calls are ADAPTER_UNAVAILABLE, never thrown", async () => {
  const unmatched = await retrieve([m365Entry("Some Other Folder", 0, { result: { content: [] } })]);
  assert.equal(unmatched.result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(unmatched.result.error.details.reason, "replay_unmatched");
  const noTool = await retrieve([]);
  assert.equal(noTool.result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(noTool.result.error.details.reason, "tool_not_found");
  const { adapter } = setup(page1([m365Hit({ n: 1 })]));
  assert.equal((await adapter.retrieve(request())).ok, true);
  const exhausted = await adapter.retrieve(request());
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.error.details.reason, "replay_exhausted");
});

test("a client that is not a replay client (transport failure) is reported, not thrown", async () => {
  const client = { listTools: async () => ({ tools: [] }), callTool: async () => { throw new Error("socket hang up"); } };
  const adapter = createM365SharePointEvidenceAdapter({ client, mapping: SINGLE, now: NOW });
  const result = await adapter.retrieve(request());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.error.details.reason, "transport_error");
  assert.equal(result.error.retryable, true);
});

test("volatile fields are redacted in the loaded capture's error payload; hit driveIds are not", async () => {
  const entries = [
    m365Entry("Northwind Traders", 0, { error: m365Error(500) }),
    m365Entry("Northwind", 0, { result: m365Page([m365Hit({ n: 1 })]) }),
  ];
  const client = m365Loaded(entries);
  await assert.rejects(client.callTool("sharepoint_search", searchArgs("Northwind Traders", 0)), (error) => {
    assert.ok(error instanceof McpClientError);
    assert.equal(error.payload.details.graphRequestId, "[REDACTED]");
    assert.equal(error.payload.details.uriPath, "[REDACTED]");
    assert.equal(error.payload.details.graphStatusCode, 500);
    assert.equal(error.payload.details.driveId, "b!SYNdrive0001");
    assert.equal(error.payload.message, "[REDACTED]");
    return true;
  });
  const hit = await client.callTool("sharepoint_search", searchArgs("Northwind", 0));
  assert.ok(hit.content[0].text.includes("b!SYNdrive0001"), "driveId in a hit result is untouched");
});

// ---------------------------------------------------------------- classification

const fromAdapter = (adapter, ceiling) => retrieveEvidence(
  { account_id: NORTHWIND_SF_ID, questions: [{ id: "FM-CTX-001", text: "a?" }], requested_sources: ["internal_document"], context: ceiling ? { permitted_classifications: ceiling } : {} },
  { adapter },
);

test("records are internal by default and visible at the default ceiling", async () => {
  const { adapter } = setup(page1([m365Hit({ n: 1 })]));
  const result = await fromAdapter(adapter);
  assert.equal(result.status, "success");
  assert.equal(result.data.records[0].access_classification, "internal");
});

test("a public ceiling withholds every M365 record", async () => {
  const { adapter } = setup(page1([m365Hit({ n: 1 })]));
  const result = await fromAdapter(adapter, ["public"]);
  assert.equal(result.data.records.length, 0);
  assert.ok(result.errors.some((e) => e.code === "CLASSIFICATION_RESTRICTED"));
});

test("a confidential location withholds its documents by default and shows them under a confidential ceiling", async () => {
  const confidential = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX, { classification: "confidential" })]));
  const config = { mapping: confidential };
  const withheld = await fromAdapter(setup(page1([m365Hit({ n: 1 })]), config).adapter);
  assert.equal(withheld.data.records.length, 0);
  assert.equal(withheld.status, "blocked");
  assert.ok(withheld.errors.some((e) => e.code === "CLASSIFICATION_RESTRICTED"));
  assert.ok(withheld.warnings.some((w) => w.code === "RECORDS_WITHHELD"));
  const visible = await fromAdapter(setup(page1([m365Hit({ n: 1 })]), config).adapter, ["public", "internal", "confidential"]);
  assert.equal(visible.status, "success");
  assert.equal(visible.data.records[0].access_classification, "confidential");
});

test("an adapter-level confidential classification raises every record; locations may only raise", async () => {
  const mapping = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX, { classification: "internal" })]));
  const [record] = ok((await retrieve(page1([m365Hit({ n: 1 })]), { mapping, options: { classification: "confidential" } })).result);
  assert.equal(record.access_classification, "confidential");
});

// ---------------------------------------------------------------- policy and determinism

test("adapter sources reference no tool other than sharepoint_search", () => {
  const dirs = ["../adapters/m365/", "../cli/", "../adapters/"];
  const files = [];
  for (const dir of dirs) {
    for (const name of readdirSync(new URL(dir, import.meta.url))) {
      if (name.endsWith(".js") && (dir !== "../adapters/" || name === "source-router-evidence-adapter.js")) files.push(new URL(`${dir}${name}`, import.meta.url));
    }
  }
  assert.ok(files.length > 10);
  const forbidden = /read_resource|sharepoint_folder_search|sharepoint_(upload|update|create|delete|move|copy|rename)|outlook_|teams_|search_people|\bdispatch\b(?!_readonly)/;
  for (const file of files) {
    const text = readFileSync(fileURLToPath(file), "utf8");
    assert.ok(!forbidden.test(text), `${fileURLToPath(file)} mentions a forbidden tool`);
  }
  const callSites = readFileSync(fileURLToPath(new URL("../adapters/m365/evidence-adapter.js", import.meta.url)), "utf8").match(/callTool\(.*\)/g);
  assert.equal(callSites.length, 1);
  assert.ok(callSites[0].startsWith("callTool(M365_TOOL, searchArgs(folderName, offset)"));
});

test("two runs over the same capture give identical records, and the adapter never lists tools", async () => {
  const entries = () => [
    m365Entry("Northwind Traders", 0, { result: m365Page([m365Hit({ n: 1 }), m365Hit({ n: 2, lastModified: "2026-10-01T00:00:00.000Z" })]) }),
    m365Entry("Northwind", 0, { result: m365Page([m365Hit({ n: 3, driveId: "b!SYNdrive0002", folder: DELIVERY_PREFIX })]) }),
  ];
  const run = async () => {
    const client = new ReplayMcpClient({ entries: entries() });
    let listed = false;
    const spy = { listTools: async () => { listed = true; return client.listTools(); }, callTool: (name, args) => client.callTool(name, args) };
    const adapter = createM365SharePointEvidenceAdapter({ client: spy, mapping: MAPPING, now: NOW });
    const result = await adapter.retrieve(request());
    assert.equal(listed, false);
    return result;
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b);
  assert.equal(a.records.length, 3);
});
