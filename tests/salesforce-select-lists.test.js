import test from "node:test";
import assert from "node:assert/strict";
import { OBJECTS, selectList } from "../adapters/salesforce/fields.js";
import {
  buildAccountSearchSoql, buildAccountExactSoql, buildObjectSoql, searchTokens, prepareTerm, accountSearchKind,
} from "../adapters/salesforce/soql.js";
import { accountSearchPlan, evidencePlan } from "../adapters/salesforce/capture-plan.js";
import { resolveLimits } from "../adapters/salesforce/limits.js";
import { createSalesforceAccountAdapter } from "../adapters/salesforce/account-adapter.js";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { replay, sid } from "./helpers/salesforce-capture.js";

const ID = sid("001", 1);
const SEL = "SELECT Id, Name, Website, BillingCity, BillingState, BillingCountry, Owner.Name FROM Account";
const TAIL = "ORDER BY Name ASC, Id ASC LIMIT 50";

// Explicit allow-list: adding a field anywhere must fail this test, even after fixtures are regenerated.
const ALLOWED = {
  Account: ["Industry", "Type", "Website", "NumberOfEmployees", "AnnualRevenue", "BillingCity", "BillingState", "BillingCountry", "Owner.Name"],
  Opportunity: ["StageName", "Amount", "CloseDate", "Probability", "ForecastCategoryName", "Type", "LeadSource", "Owner.Name", "Cluster__c", "Qualification_Score__c", "Budget_Status__c", "Primary_Buyer_Authority__c", "Awareness_of_Pain__c", "What_s_the_Trigger_and_why_now__c", "Cost_of_Inaction__c", "Buying_Path__c"],
  Contact: ["Title", "Department"],
  Task: ["Status", "Priority", "Type", "ActivityDate", "Owner.Name"],
  Event: ["StartDateTime", "EndDateTime", "Type", "Owner.Name"],
};
const ALLOWED_EXTRA = { Account: [], Opportunity: [], Contact: [], Task: ["WhatId", "WhoId", "CompletedDateTime"], Event: ["WhatId", "WhoId"] };
const ALLOWED_NAME_FIELD = { Account: "Name", Opportunity: "Name", Contact: "Name", Task: null, Event: null };

test("field lists in fields.js equal the explicit allow-list", () => {
  assert.deepEqual(Object.keys(OBJECTS), Object.keys(ALLOWED));
  for (const [name, def] of Object.entries(OBJECTS)) {
    assert.deepEqual(def.fields.map((f) => f.api), ALLOWED[name], `${name} fields`);
    assert.deepEqual([...def.extra], ALLOWED_EXTRA[name], `${name} extra`);
    assert.equal(def.nameField, ALLOWED_NAME_FIELD[name], `${name} name field`);
  }
});

const GOLDEN = {
  Account: `SELECT Id, Name, Industry, Type, Website, NumberOfEmployees, AnnualRevenue, BillingCity, BillingState, BillingCountry, Owner.Name, CreatedDate, LastModifiedDate FROM Account WHERE Id = '${ID}' LIMIT 1`,
  Opportunity: `SELECT Id, Name, AccountId, StageName, Amount, CloseDate, Probability, ForecastCategoryName, Type, LeadSource, Owner.Name, Cluster__c, Qualification_Score__c, Budget_Status__c, Primary_Buyer_Authority__c, Awareness_of_Pain__c, What_s_the_Trigger_and_why_now__c, Cost_of_Inaction__c, Buying_Path__c, CreatedDate, LastModifiedDate FROM Opportunity WHERE AccountId = '${ID}' ORDER BY CloseDate DESC, Id ASC LIMIT 201`,
  Contact: `SELECT Id, Name, AccountId, Title, Department, CreatedDate, LastModifiedDate FROM Contact WHERE AccountId = '${ID}' ORDER BY Name ASC, Id ASC LIMIT 101`,
  Task: `SELECT Id, AccountId, Status, Priority, Type, ActivityDate, Owner.Name, WhatId, WhoId, CompletedDateTime, CreatedDate, LastModifiedDate FROM Task WHERE AccountId = '${ID}' ORDER BY ActivityDate DESC NULLS LAST, Id ASC LIMIT 101`,
  Event: `SELECT Id, AccountId, StartDateTime, EndDateTime, Type, Owner.Name, WhatId, WhoId, CreatedDate, LastModifiedDate FROM Event WHERE AccountId = '${ID}' ORDER BY StartDateTime DESC NULLS LAST, Id ASC LIMIT 51`,
};

test("golden full SELECT strings for all five evidence queries", () => {
  for (const [name, soql] of Object.entries(GOLDEN)) assert.equal(buildObjectSoql(name, ID), soql, name);
  assert.deepEqual(evidencePlan(`sf_${ID}`).calls.map((c) => c.args.queryParams.q), Object.values(GOLDEN));
  assert.equal(selectList("Task").includes("Subject"), false);
  assert.equal(selectList("Event").includes("Location"), false);
});

test("golden account-search variants (name, domain, ID, supplementary)", () => {
  assert.equal(buildAccountSearchSoql("Northwind Traders"), `${SEL} WHERE Name = 'Northwind Traders' OR Name LIKE '%Northwind%' OR Name LIKE '%Traders%' ${TAIL}`);
  assert.equal(buildAccountSearchSoql("northwind-traders.example"), `${SEL} WHERE Name = 'northwind-traders.example' OR Website LIKE '%northwind-traders.example%' ${TAIL}`);
  assert.equal(buildAccountSearchSoql(`sf_${ID}`), `${SEL} WHERE Id = '${ID}' LIMIT 1`);
  assert.equal(buildAccountExactSoql("Northwind Traders"), `${SEL} WHERE Name = 'Northwind Traders' ${TAIL}`);
  const plan = accountSearchPlan("northwind-traders.example");
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].args.queryParams.q, buildAccountSearchSoql("northwind-traders.example"));
});

test("tokens split on letters, digits and combining marks (decomposed accents stay whole)", () => {
  assert.deepEqual(searchTokens("Café Müller"), ["Café", "Müller"]);
});

test("evidencePlan shares the adapter's limits validation", () => {
  assert.throws(() => evidencePlan(`sf_${ID}`, { limits: { Opportunity: 500 } }), TypeError);
  assert.throws(() => evidencePlan(`sf_${ID}`, { limits: { Lead: 1 } }), TypeError);
  assert.throws(() => evidencePlan(`sf_${ID}`, { limits: { Contact: 0 } }), TypeError);
  assert.equal(resolveLimits({ Contact: 5 }).Contact, 5);
  const plan = evidencePlan(`sf_${ID}`, { limits: { Contact: 5 } });
  assert.ok(plan.calls[2].args.queryParams.q.endsWith("LIMIT 6"));
  assert.throws(() => createSalesforceEvidenceAdapter({ client: replay([]), limits: { Contact: 500 } }), TypeError);
});

test("classification is restricted to internal or confidential", () => {
  const client = replay([]);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, classification: "public" }), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, classification: "secret" }), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, objectClassification: { Contact: "public" } }), TypeError);
  assert.doesNotThrow(() => createSalesforceEvidenceAdapter({ client, classification: "confidential" }));
  assert.doesNotThrow(() => createSalesforceEvidenceAdapter({ client, classification: "internal", objectClassification: { Contact: "confidential" } }));
});

test("malformed sf_ references are a no-match with no call; no broad %sf% search", async () => {
  assert.equal(accountSearchKind("sf_001SHORT"), "invalid_id");
  assert.throws(() => buildAccountSearchSoql("sf_001SHORT"), TypeError);
  assert.deepEqual(accountSearchPlan("sf_001SHORT").calls, []);
  assert.deepEqual(accountSearchPlan("   ").calls, []);
  const client = replay([]);
  const result = await createSalesforceAccountAdapter({ client }).searchAccounts("sf_001SHORT");
  assert.deepEqual(result, { ok: true, accounts: [] });
  assert.equal(client.calls.length, 0);
  assert.equal(accountSearchKind("sf_ abc"), "name"); // whitespace: an ordinary name
});

test("term is trimmed again after the 255 code-point cut", () => {
  const term = `${"a".repeat(254)} b`;
  assert.equal(prepareTerm(term), "a".repeat(254));
});
