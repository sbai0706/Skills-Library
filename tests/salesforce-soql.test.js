import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeSoqlLiteral, escapeSoqlLike, searchTokens, buildAccountSearchSoql, buildAccountExactSoql,
  buildAccountByIdSoql, buildObjectSoql, parseSfAccountId, prepareTerm,
} from "../adapters/salesforce/soql.js";
import { accountSearchPlan, evidencePlan, queryArgs, nextPageArgs } from "../adapters/salesforce/capture-plan.js";
import { createSalesforceAccountAdapter } from "../adapters/salesforce/account-adapter.js";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { sfOk, replay, queryEntry, sid } from "./helpers/salesforce-capture.js";

const SEL = "SELECT Id, Name, Website, BillingCity, BillingState, BillingCountry, Owner.Name FROM Account";
const ID = sid("001", 1);

test("literal and LIKE escaping", () => {
  assert.equal(escapeSoqlLiteral("O'Brien\\Co_50%"), "O\\'Brien\\\\Co_50%");
  assert.equal(escapeSoqlLike("O'Brien\\Co_50%"), "O\\'Brien\\\\Co\\_50\\%");
  assert.equal(escapeSoqlLiteral("a\nb\tc\r\"d\u0001"), 'a\\nb\\tc\\r\\"d');
});

test("token rules: short, legal suffix, dedupe, cap 6, Unicode", () => {
  assert.deepEqual(searchTokens("Northwind Traders, Inc."), ["Northwind", "Traders"]);
  assert.deepEqual(searchTokens("A B Acme the LLC acme"), ["Acme"]);
  assert.deepEqual(searchTokens("one two three four five six seven eight").length, 6);
  assert.deepEqual(searchTokens("Müller-Écoute 3M"), ["Müller", "Écoute", "3M"]);
  assert.deepEqual(searchTokens("Inc. LLC"), []);
});

test("term preparation cleans whitespace and caps at 255 code points", () => {
  assert.equal(prepareTerm("  a \n\t b  "), "a b");
  assert.equal([...prepareTerm("x".repeat(400))].length, 255);
});

test("exact account SOQL strings: name, ID, domain, supplementary", () => {
  assert.equal(
    buildAccountSearchSoql("Northwind Traders"),
    `${SEL} WHERE Name = 'Northwind Traders' OR Name LIKE '%Northwind%' OR Name LIKE '%Traders%' ORDER BY Name ASC, Id ASC LIMIT 50`,
  );
  assert.equal(buildAccountSearchSoql("Inc."), `${SEL} WHERE Name = 'Inc.' ORDER BY Name ASC, Id ASC LIMIT 50`);
  assert.equal(buildAccountSearchSoql(`sf_${ID}`), `${SEL} WHERE Id = '${ID}' LIMIT 1`);
  assert.equal(buildAccountByIdSoql(ID), `${SEL} WHERE Id = '${ID}' LIMIT 1`);
  assert.equal(
    buildAccountSearchSoql("https://www.Northwind-Traders.example/about"),
    `${SEL} WHERE Website LIKE '%northwind-traders.example%' ORDER BY Name ASC, Id ASC LIMIT 50`,
  );
  assert.equal(buildAccountExactSoql("O'Brien"), `${SEL} WHERE Name = 'O\\'Brien' ORDER BY Name ASC, Id ASC LIMIT 50`);
  assert.throws(() => buildAccountByIdSoql("001'; DROP"), TypeError);
  assert.equal(parseSfAccountId("sf_001SHORT"), null);
  assert.equal(parseSfAccountId(`sf_${ID}`), ID);
});

test("injection attempts stay inside the literal", () => {
  const soql = buildAccountSearchSoql("x' OR Name != '");
  assert.ok(soql.includes("Name = 'x\\' OR Name != \\''"));
  assert.ok(!/Name = 'x' OR/.test(soql));
});

test("exact evidence SOQL for all five objects", () => {
  const a = (q) => q.replace(/^SELECT .*? FROM /, "SELECT <sel> FROM ");
  assert.equal(a(buildObjectSoql("Account", ID)), `SELECT <sel> FROM Account WHERE Id = '${ID}' LIMIT 1`);
  assert.equal(a(buildObjectSoql("Opportunity", ID)), `SELECT <sel> FROM Opportunity WHERE AccountId = '${ID}' ORDER BY CloseDate DESC, Id ASC LIMIT 201`);
  assert.equal(a(buildObjectSoql("Contact", ID)), `SELECT <sel> FROM Contact WHERE AccountId = '${ID}' ORDER BY Name ASC, Id ASC LIMIT 101`);
  assert.equal(a(buildObjectSoql("Task", ID)), `SELECT <sel> FROM Task WHERE AccountId = '${ID}' ORDER BY ActivityDate DESC NULLS LAST, Id ASC LIMIT 101`);
  assert.equal(a(buildObjectSoql("Event", ID)), `SELECT <sel> FROM Event WHERE AccountId = '${ID}' ORDER BY StartDateTime DESC NULLS LAST, Id ASC LIMIT 51`);
  assert.match(buildObjectSoql("Opportunity", ID, { limits: { Opportunity: 5 } }), /LIMIT 6$/);
  assert.equal(
    buildObjectSoql("Contact", ID).split(" FROM ")[0],
    "SELECT Id, Name, AccountId, Title, Department, CreatedDate, LastModifiedDate",
  );
});

test("no select list contains free text or contact PII fields", () => {
  for (const object of ["Account", "Opportunity", "Contact", "Task", "Event"]) {
    const select = buildObjectSoql(object, ID);
    for (const banned of ["Description", "NextStep", "Comments", "Lead_Source_Notes__c", "Email", "Phone", "Mailing", "Birthdate"]) {
      assert.ok(!select.includes(banned), `${object} must not select ${banned}`);
    }
  }
});

test("plan builders produce the adapters' canonical call args", async () => {
  const searchPlan = accountSearchPlan("Northwind Traders");
  assert.equal(searchPlan.tool, "dispatch_readonly");
  assert.equal(searchPlan.calls.length, 2);
  assert.equal(accountSearchPlan(`sf_${ID}`).calls.length, 1);
  assert.equal(accountSearchPlan("northwind.example").calls.length, 1);
  assert.deepEqual(searchPlan.calls[0].args, queryArgs("v66.0", buildAccountSearchSoql("Northwind Traders")));
  assert.deepEqual(nextPageArgs("/services/data/v66.0/query/01gSYN-2000"), { url: "/services/data/v66.0/query/01gSYN-2000", method: "GET" });

  const client = replay([queryEntry(buildAccountSearchSoql("Northwind Traders"), { result: sfOk("Account", []) })]);
  await createSalesforceAccountAdapter({ client }).searchAccounts("Northwind Traders");
  assert.deepEqual(client.calls.map((c) => c.args), [searchPlan.calls[0].args]);

  const evPlan = evidencePlan(`sf_${ID}`);
  assert.deepEqual(evPlan.calls.map((c) => c.step), ["Account", "Opportunity", "Contact", "Task", "Event"]);
  const entries = evPlan.calls.map((c) => ({ tool: "dispatch_readonly", args: c.args, result: sfOk(c.step, []) }));
  const evClient = replay(entries);
  const result = await createSalesforceEvidenceAdapter({ client: evClient }).retrieve({ account_id: `sf_${ID}`, questions: [], source_type: "crm", context: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(evClient.calls.map((c) => c.args), evPlan.calls.map((c) => c.args));
  assert.throws(() => evidencePlan("acct_1"), TypeError);
});
