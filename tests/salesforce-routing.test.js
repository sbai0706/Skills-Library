import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import YAML from "yaml";
import { loadSalesforceRouting, questionIdsFor } from "../adapters/salesforce/routing.js";
import { OBJECTS } from "../adapters/salesforce/fields.js";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { createSalesforceAccountAdapter } from "../adapters/salesforce/account-adapter.js";
import { replay, sid } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

const routing = loadSalesforceRouting();
const questionsDoc = YAML.parse(readFileSync(new URL("../reference/first-meeting-questions.yaml", import.meta.url), "utf8"));
const questionIds = new Set(questionsDoc.categories.flatMap((c) => c.questions.map((q) => q.id)));
const RAW_FACT_FIELDS = ["StageName", "Qualification_Score__c", "Budget_Status__c", "Primary_Buyer_Authority__c", "Awareness_of_Pain__c", "What_s_the_Trigger_and_why_now__c", "Cost_of_Inaction__c", "Buying_Path__c"];

test("routing header follows reference conventions", () => {
  assert.match(routing.version, /^\d+\.\d+\.\d+$/);
  assert.equal(routing.status, "provisional");
  assert.equal(routing.business_owner, "TBD");
  assert.equal(routing.approver, "TBD");
  assert.equal(routing.approval_date, null);
  assert.equal(routing.effective_date, null);
  assert.deepEqual(routing.source_documents, []);
  assert.ok(Array.isArray(routing.change_history) && routing.change_history.length > 0);
  assert.equal(routing.source_system, "salesforce");
  assert.equal(routing.question_set, `first-meeting-questions@${questionsDoc.version}`);
});

test("every route references an existing question, object and allow-listed field", () => {
  for (const route of routing.routes) {
    assert.ok(questionIds.has(route.question_id), `${route.question_id} exists in the question reference`);
    assert.ok(OBJECTS[route.object], `${route.object} is an allow-listed object`);
    assert.ok(["record_exists", "any_populated"].includes(route.when));
    if (route.when === "any_populated") {
      assert.ok(route.fields.length > 0);
      for (const field of route.fields) assert.ok(OBJECTS[route.object].fields.some((f) => f.api === field), `${route.object}.${field}`);
    } else {
      assert.equal(route.fields, undefined);
    }
  }
});

test("no route uses StageName, Qualification_Score__c or the six raw qualification-like picklists", () => {
  const used = new Set(routing.routes.flatMap((r) => r.fields ?? []));
  for (const field of RAW_FACT_FIELDS) assert.ok(!used.has(field), `${field} must not be routed`);
  const text = readFileSync(new URL("../reference/salesforce-question-routing.yaml", import.meta.url), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  for (const field of RAW_FACT_FIELDS) assert.ok(!text.includes(field), `${field} not mentioned in routes`);
});

test("questionIdsFor semantics: record_exists, any_populated, requested filter, sorted dedupe", () => {
  const all = [...questionIds];
  assert.deepEqual(questionIdsFor(routing, "Account", ["Industry"], all), ["FM-CTX-001"]);
  assert.deepEqual(questionIdsFor(routing, "Account", ["Owner.Name", "AnnualRevenue", "Website"], all), ["FM-CTX-001", "FM-CTX-002", "FM-STK-002"]);
  assert.deepEqual(questionIdsFor(routing, "Account", [], all), []);
  assert.deepEqual(questionIdsFor(routing, "Contact", [], all), ["FM-STK-001"]);
  assert.deepEqual(questionIdsFor(routing, "Opportunity", ["StageName"], ["FM-CTX-001"]), []);
  assert.deepEqual(questionIdsFor(routing, "Opportunity", [], ["FM-REL-001", "FM-REL-001"]), ["FM-REL-001"]);
  assert.deepEqual(questionIdsFor(routing, "Lead", [], all), []);
});

test("raw qualification-like facts never change question routing", async () => {
  const withFacts = structuredClone(northwindRows);
  const without = structuredClone(northwindRows);
  for (const f of RAW_FACT_FIELDS.slice(1)) without.Opportunity[0][f] = null;
  without.Opportunity[0].StageName = null;
  const run = async (rows) => {
    const adapter = createSalesforceEvidenceAdapter({ client: replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, rows)) });
    const result = await adapter.retrieve({ account_id: NORTHWIND_ACCOUNT_ID, questions: [...questionIds].map((id) => ({ id, text: "q?" })), source_type: "crm", context: {} });
    return result.records.find((r) => r.record_id === `src_sf_${sid("006", 1)}`).question_ids;
  };
  assert.deepEqual(await run(withFacts), await run(without));
});

test("adapter sources contain no stage/qualification mapping and never name the write tool", () => {
  const dir = new URL("../adapters/salesforce/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const text = readFileSync(new URL(file, dir), "utf8");
    assert.ok(!/["'`]dispatch["'`]/.test(text), `${file} must not reference the "dispatch" tool`);
    assert.ok(!/\btoLabel\b/i.test(text), `${file}: no picklist label translation`);
    assert.ok(!/(Closed Won|Closed Lost|Negotiation|Prospecting|Qualified|B-FITT|bfitt)/i.test(text), `${file}: no stage/B-FITT values`);
  }
});

test("every call uses dispatch_readonly with GET, and never lists tools", async () => {
  const account = replay([]);
  await createSalesforceAccountAdapter({ client: account }).searchAccounts("Acme Co");
  const evidence = replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows));
  await createSalesforceEvidenceAdapter({ client: evidence }).retrieve({ account_id: NORTHWIND_ACCOUNT_ID, questions: [], source_type: "crm", context: {} });
  const calls = [...account.calls, ...evidence.calls];
  assert.ok(calls.length >= 6);
  for (const call of calls) {
    assert.equal(call.name, "dispatch_readonly");
    assert.equal(call.args.method, "GET");
    assert.ok(Object.values(call.args).every((v) => v !== undefined && v !== null));
  }
  const listing = { listTools: () => assert.fail("listTools must not be called"), callTool: async () => ({}) };
  await createSalesforceAccountAdapter({ client: listing }).searchAccounts("Acme Co");
});
