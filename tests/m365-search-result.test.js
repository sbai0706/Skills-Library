import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchResult, searchArgs, searchFolderNames, sharepointSearchPlan, validateM365AccountMapping,
} from "../adapters/m365/index.js";
import { SALES_PREFIX, DELIVERY_PREFIX, m365Error, m365Hit, m365Page, moreTrailer, oneAccount } from "./helpers/m365-capture.js";

const reason = (parsed) => parsed.error?.details?.detail;
const loc = (prefix, extra = {}) => ({ web_url_prefix: prefix, ...extra });

test("an empty content array is zero hits on a final page", () => {
  assert.deepEqual(parseSearchResult({ content: [] }), { ok: true, hits: [], trailer: null });
  assert.deepEqual(parseSearchResult(m365Page([])), { ok: true, hits: [], trailer: null });
});

test("hit blocks and a final trailer are parsed; the note is ignored by consumers", () => {
  const hits = [m365Hit({ n: 1 }), m365Hit({ n: 2 })];
  const parsed = parseSearchResult(m365Page(hits));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.hits, hits);
  assert.deepEqual(parsed.trailer, { totalResultCount: 2 });
  const more = parseSearchResult(m365Page(hits, moreTrailer(2, 9)));
  assert.equal(more.trailer.moreResults, true);
  assert.equal(more.trailer.nextOffset, 2);
});

test("hits without a trailer are a final page", () => {
  const parsed = parseSearchResult(m365Page([m365Hit({ n: 1 })], null));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.trailer, null);
  assert.equal(parsed.hits.length, 1);
});

test("malformed results are ADAPTER_MALFORMED_RESPONSE", () => {
  const hit = JSON.stringify(m365Hit({ n: 1 }));
  const trailer = JSON.stringify({ totalResultCount: 1 });
  const text = (value) => ({ type: "text", text: value });
  const cases = {
    "trailer not last": { content: [text(trailer), text(hit)] },
    "two trailers": { content: [text(hit), text(trailer), text(trailer)] },
    "non-JSON block": { content: [text("this is not json")] },
    "unknown object": { content: [text(JSON.stringify({ hello: "world" }))] },
    "array block": { content: [text("[1,2]")] },
    "scalar block": { content: [text("7")] },
    "structuredContent present": { content: [text(hit), text(trailer)], structuredContent: { records: [] } },
    "non-text block": { content: [{ type: "image", data: "x" }] },
    "block without text": { content: [{ type: "text" }] },
    "content not an array": { content: "nope" },
    "no content": { something: "else" },
    "negative total": { content: [text(JSON.stringify({ totalResultCount: -1 }))] },
    "fractional total": { content: [text(JSON.stringify({ totalResultCount: 1.5 }))] },
    "moreResults not boolean": { content: [text(JSON.stringify({ totalResultCount: 1, moreResults: "yes" }))] },
    "not an object": "a string",
    "array result": [],
  };
  for (const [label, raw] of Object.entries(cases)) {
    const parsed = parseSearchResult(raw);
    assert.equal(parsed.ok, false, label);
    assert.equal(parsed.error.code, "ADAPTER_MALFORMED_RESPONSE", label);
    assert.equal(parsed.error.details.reason, "malformed_search_result", label);
    assert.equal(parsed.error.retryable, false);
  }
  assert.equal(reason(parseSearchResult(cases["trailer not last"])), "trailer_not_last");
  assert.equal(reason(parseSearchResult(cases["structuredContent present"])), "structured_content_present");
});

test("an isError result is classified as an M365 error, never parsed as hits", () => {
  const raw = { isError: true, content: [{ type: "text", text: JSON.stringify(m365Error(401)) }] };
  const parsed = parseSearchResult(raw);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "ADAPTER_UNAUTHORIZED");
  assert.equal(parsed.error.details.reason, "unauthenticated");
  const plain = parseSearchResult({ isError: true, content: [{ type: "text", text: "something failed" }] });
  assert.equal(plain.ok, false);
  assert.equal(plain.error.code, "ADAPTER_UNAVAILABLE");
});

// ---------------------------------------------------------------- canonical args and the plan

test("searchArgs builds exactly the four canonical keys", () => {
  assert.deepEqual(searchArgs("Northwind Traders", 0), { query: "*", folderName: "Northwind Traders", limit: 50, offset: 0 });
  assert.deepEqual(Object.keys(searchArgs("x", 150)).sort(), ["folderName", "limit", "offset", "query"]);
  assert.equal(searchArgs("x", 150).offset, 150);
  assert.equal(searchArgs("x").offset, 0);
});

test("the plan has one search per distinct folder name, in order of first appearance", () => {
  const mapping = validateM365AccountMapping(oneAccount([
    loc(SALES_PREFIX), loc(DELIVERY_PREFIX), loc(`${SALES_PREFIX}/Meetings`), loc("https://contoso.sharepoint.com/teams/ExampleTeam/Docs/Northwind"),
  ]));
  const [entry] = mapping.accounts;
  assert.deepEqual(searchFolderNames(entry), ["Northwind Traders", "Northwind", "Meetings"]);
  const plan = sharepointSearchPlan(entry.account_id, mapping);
  assert.equal(plan.mapped, true);
  assert.deepEqual(plan.calls.map((call) => call.step), ["search_1", "search_2", "search_3"]);
  assert.deepEqual(plan.calls.map((call) => call.args), ["Northwind Traders", "Northwind", "Meetings"].map((name) => searchArgs(name, 0)));
  assert.equal(plan.max_pages_per_search, 4);
});

test("search_folder_name overrides the last path segment and shares a search when equal", () => {
  const mapping = validateM365AccountMapping(oneAccount([
    loc(SALES_PREFIX, { search_folder_name: "Northwind" }), loc(DELIVERY_PREFIX),
  ]));
  assert.deepEqual(searchFolderNames(mapping.accounts[0]), ["Northwind"], "two locations with the same folder name share one search");
});

test("an unmapped account has a plan without calls", () => {
  const mapping = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX)]));
  const plan = sharepointSearchPlan("sf_001SYN0000000002AA", mapping);
  assert.equal(plan.mapped, false);
  assert.deepEqual(plan.calls, []);
});
