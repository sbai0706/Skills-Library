import test from "node:test";
import assert from "node:assert/strict";
import { createSalesforceAccountAdapter } from "../adapters/salesforce/account-adapter.js";
import { resolveAccount } from "../skills/account-resolve/index.js";
import { buildAccountSearchSoql, buildAccountExactSoql, buildAccountByIdSoql } from "../adapters/salesforce/soql.js";
import { McpClientError } from "../adapters/mcp/index.js";
import { sfOk, sfError, replay, queryEntry, pageEntry, sid, textEnvelope } from "./helpers/salesforce-capture.js";

const row = (n, name, extra = {}) => ({ Id: sid("001", n), Name: name, Website: null, BillingCity: null, BillingState: null, BillingCountry: null, Owner: null, ...extra });
const search = (term, rows, outcome) => queryEntry(buildAccountSearchSoql(term), outcome ?? { result: sfOk("Account", rows) });
const adapterFor = (entries, options) => createSalesforceAccountAdapter({ client: replay(entries, options) });

test("constructor validates client and apiVersion; shape of the adapter", () => {
  assert.throws(() => createSalesforceAccountAdapter({}), TypeError);
  assert.throws(() => createSalesforceAccountAdapter({ client: replay([]), apiVersion: "66" }), TypeError);
  const adapter = adapterFor([]);
  assert.equal(adapter.name, "salesforce-account-adapter(v66.0)");
  assert.deepEqual(adapter.supportedSources, ["crm"]);
});

test("unique exact match resolves", async () => {
  const adapter = adapterFor([search("Northwind Traders", [row(1, "Northwind Traders", { Website: "https://www.NorthWind.example/x", BillingCity: "Columbus", BillingCountry: "USA", Owner: { Name: "Avery Example" } })])]);
  const result = await resolveAccount({ account_reference: "Northwind Traders" }, { adapter });
  assert.equal(result.status, "success");
  assert.equal(result.data.outcome, "resolved");
  assert.equal(result.data.account.account_id, `sf_${sid("001", 1)}`);
  const direct = await adapterFor([search("Northwind Traders", [row(1, "Northwind Traders", { Website: "https://www.NorthWind.example/x", BillingCity: "Columbus", BillingCountry: "USA", Owner: { Name: "Avery Example" } })])]).searchAccounts("Northwind Traders", { limit: 3 });
  assert.deepEqual(direct, { ok: true, accounts: [{ account_id: `sf_${sid("001", 1)}`, name: "Northwind Traders", domain: "northwind.example", location: "Columbus, USA", owner_name: "Avery Example" }] });
});

test("ambiguous: two similar accounts and two identical names block", async () => {
  const two = adapterFor([search("Northwind", [row(2, "Northwind Logistics"), row(1, "Northwind Traders")])]);
  const r1 = await resolveAccount({ account_reference: "Northwind" }, { adapter: two });
  assert.equal(r1.data.outcome, "ambiguous");
  const same = adapterFor([search("Northwind Traders", [row(1, "Northwind Traders"), row(3, "Northwind Traders")])]);
  const r2 = await resolveAccount({ account_reference: "Northwind Traders" }, { adapter: same });
  assert.equal(r2.data.outcome, "ambiguous");
});

test("single fuzzy candidate needs confirmation, then the exact ID resolves via the ID query", async () => {
  const id = `sf_${sid("001", 1)}`;
  const entries = [
    search("Northwind", [row(1, "Northwind Traders")]),
    queryEntry(buildAccountByIdSoql(sid("001", 1)), { result: sfOk("Account", [row(1, "Northwind Traders")]) }),
  ];
  const adapter = adapterFor(entries);
  const first = await resolveAccount({ account_reference: "Northwind" }, { adapter });
  assert.equal(first.data.outcome, "confirmation_required");
  const second = await resolveAccount({ account_reference: id }, { adapter });
  assert.equal(second.data.outcome, "resolved");
  assert.equal(second.data.match.method, "account_id");
});

test("no match returns not_found", async () => {
  const result = await resolveAccount({ account_reference: "Zyxwv Holdings" }, { adapter: adapterFor([search("Zyxwv Holdings", [])]) });
  assert.equal(result.data.outcome, "not_found");
});

test("50-row truncation without an exact name triggers the supplementary exact query", async () => {
  const filler = Array.from({ length: 50 }, (_, i) => row(i + 10, `Northwind Filler ${String(i).padStart(2, "0")}`));
  const adapter = adapterFor([
    search("Northwind Zed", filler),
    queryEntry(buildAccountExactSoql("Northwind Zed"), { result: sfOk("Account", [row(99, "Northwind Zed")]) }),
  ]);
  const result = await adapter.searchAccounts("Northwind Zed");
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 50);
  assert.equal(result.accounts[0].name, "Northwind Zed");
  // Exact name present in the first 50: no supplementary call.
  const client = replay([search("Northwind Zed", [...filler.slice(0, 49), row(99, "northwind zed ")])]);
  const r2 = await createSalesforceAccountAdapter({ client }).searchAccounts("Northwind Zed");
  assert.equal(r2.ok, true);
  assert.equal(client.calls.length, 1);
});

test("empty and whitespace optional fields are omitted", async () => {
  const adapter = adapterFor([search("Northwind Traders", [row(1, "Northwind Traders", { Website: "   ", BillingCity: " ", BillingState: "", Owner: { Name: "  " } }), row(2, "Northwind Traders Two", { Website: "not a domain", BillingState: "OH" })])]);
  const { accounts } = await adapter.searchAccounts("Northwind Traders");
  assert.deepEqual(accounts[0], { account_id: `sf_${sid("001", 1)}`, name: "Northwind Traders" });
  assert.deepEqual(accounts[1], { account_id: `sf_${sid("001", 2)}`, name: "Northwind Traders Two", location: "OH" });
});

test("malformed ID, blank name, wrong object type and bad body are ADAPTER_MALFORMED_RESPONSE", async () => {
  const cases = {
    badId: sfOk("Account", [row(1, "X")]),
    blankName: sfOk("Account", [row(1, "   ")]),
    wrongType: sfOk("Contact", [row(1, "X")]),
    noRecords: { status_code: 200, body: { totalSize: 0, done: true }, url: "/services/data/v66.0/query" },
  };
  cases.badId.body.records[0].Id = "001SHORT";
  for (const [label, payload] of Object.entries(cases)) {
    const result = await adapterFor([search("Acme Co", [], { result: payload })]).searchAccounts("Acme Co");
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, "ADAPTER_MALFORMED_RESPONSE", label);
  }
});

test("pagination follows nextRecordsUrl as a separate call; invalid next URL is malformed", async () => {
  const next = "/services/data/v66.0/query/01gSYN000000001-2000";
  const adapter = adapterFor([
    search("Acme Co", [], { result: sfOk("Account", [row(1, "Acme One")], { done: false, nextRecordsUrl: next }) }),
    pageEntry(next, { result: textEnvelope(sfOk("Account", [row(2, "Acme Two")])) }),
  ]);
  const result = await adapter.searchAccounts("Acme Co");
  assert.deepEqual(result.accounts.map((a) => a.name), ["Acme One", "Acme Two"]);
  const bad = await adapterFor([search("Acme Co", [], { result: sfOk("Account", [row(1, "Acme One")], { done: false, nextRecordsUrl: "https://evil.example/x" }) })]).searchAccounts("Acme Co");
  assert.equal(bad.error.code, "ADAPTER_MALFORMED_RESPONSE");
});

test("errors map to adapter errors without echoing Salesforce messages", async () => {
  const secret = "SELECT ... WHERE Name = 'Secret Customer'";
  const cases = [
    [{ error: sfError(401, "INVALID_AUTH_HEADER", secret) }, "ADAPTER_UNAUTHORIZED", true],
    [{ error: sfError(401, "INVALID_SESSION_ID", secret) }, "ADAPTER_UNAUTHORIZED", false],
    [{ result: sfError(503, "SERVER_UNAVAILABLE", secret) }, "ADAPTER_UNAVAILABLE", true],
  ];
  for (const [outcome, code, retryable] of cases) {
    const result = await adapterFor([search("Secret Customer", [], outcome)]).searchAccounts("Secret Customer");
    assert.equal(result.ok, false);
    assert.deepEqual([result.error.code, result.error.retryable], [code, retryable]);
    assert.ok(!JSON.stringify(result).includes("Secret Customer"));
  }
});

test("adapter never throws: client failures become adapter errors", async () => {
  const throwing = { listTools: async () => ({ tools: [] }), callTool: async () => { throw new McpClientError("TOOL_NOT_FOUND", "x", { tool: "dispatch_readonly" }); } };
  const result = await createSalesforceAccountAdapter({ client: throwing }).searchAccounts("Acme Co");
  assert.deepEqual([result.ok, result.error.code, result.error.retryable], [false, "ADAPTER_UNAVAILABLE", false]);
  const empty = await createSalesforceAccountAdapter({ client: throwing }).searchAccounts("   ");
  assert.deepEqual(empty, { ok: true, accounts: [] });
});
