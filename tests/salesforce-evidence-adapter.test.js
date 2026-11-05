import test from "node:test";
import assert from "node:assert/strict";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { evidencePlan, nextPageArgs } from "../adapters/salesforce/capture-plan.js";
import { retrieveEvidence } from "../skills/evidence-retrieve/index.js";
import { validate } from "../schemas/index.js";
import { McpClientError } from "../adapters/mcp/index.js";
import { sfOk, sfError, replay, sid, textEnvelope } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, NORTHWIND_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

const QUESTIONS = [
  { id: "FM-CTX-001", text: "a?" }, { id: "FM-CTX-002", text: "b?" }, { id: "FM-STK-001", text: "c?" },
  { id: "FM-STK-002", text: "d?" }, { id: "FM-REL-001", text: "e?" }, { id: "FM-DEV-001", text: "f?" },
];
const NOW = () => new Date("2026-11-04T10:00:00Z");
const request = (extra = {}) => ({ account_id: NORTHWIND_ACCOUNT_ID, questions: QUESTIONS, source_type: "crm", context: {}, ...extra });
const adapterFor = (rows, options = {}, clientOptions) => {
  const client = replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, rows), clientOptions);
  return { client, adapter: createSalesforceEvidenceAdapter({ client, now: NOW, ...options }) };
};
const byObject = (records) => Object.fromEntries(records.map((r) => [r.record_id, r]));

test("construction validates options", () => {
  const client = replay([]);
  assert.throws(() => createSalesforceEvidenceAdapter({}), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, limits: { Opportunity: 500 } }), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, limits: { Lead: 5 } }), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, classification: "secret" }), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, classification: "confidential", objectClassification: { Contact: "internal" } }), TypeError);
  assert.throws(() => createSalesforceEvidenceAdapter({ client, instanceUrl: "http://x.example" }), TypeError);
  const ok = createSalesforceEvidenceAdapter({ client });
  assert.equal(ok.name, "salesforce-evidence-adapter(v66.0)");
  assert.deepEqual(ok.supportedSources, ["crm"]);
});

test("full record mapping is schema-valid and follows the design", async () => {
  const { adapter } = adapterFor(northwindRows);
  const result = await adapter.retrieve(request());
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 5);
  for (const record of result.records) {
    const { valid, errors } = validate("sourceRecord", record);
    assert.equal(valid, true, JSON.stringify(errors));
    assert.equal(record.account_id, NORTHWIND_ACCOUNT_ID);
    assert.equal(record.access_classification, "internal");
    assert.equal(record.source_uri, null);
    assert.equal(record.published_at, null);
    assert.equal(record.retrieved_at, "2026-11-04T10:00:00.000Z");
    assert.equal(record.metadata.provider, "salesforce");
  }
  const records = byObject(result.records);
  const account = records[`src_sf_${NORTHWIND_ID}`];
  assert.equal(account.source_type, "crm_record");
  assert.equal(account.title, "Account: Northwind Traders");
  assert.deepEqual(account.question_ids, ["FM-CTX-001", "FM-CTX-002", "FM-STK-002"]);
  assert.equal(account.content.split("\n")[0], 'Salesforce Account "Northwind Traders"');
  assert.ok(account.content.includes('Account "Northwind Traders" - Account Owner [Owner.Name]: Avery Example'));
  assert.ok(account.content.includes('Account "Northwind Traders" - Industry: Logistics'));

  const opp = records[`src_sf_${sid("006", 1)}`];
  assert.ok(opp.content.includes('Opportunity "Phoenix Upgrade" - Stage [StageName]: Awareness'));
  assert.ok(opp.content.includes('Opportunity "Phoenix Upgrade" - Probability: 10%'));
  assert.ok(opp.content.includes('- Close Date [CloseDate]: 2026-12-15'));
  assert.ok(opp.content.includes('- Budget_Status__c: Approved'));
  assert.deepEqual(opp.question_ids, ["FM-REL-001"]);
  assert.equal(opp.metadata.sf_what_id, undefined);
  assert.equal(opp.metadata.sf_created_date, "2026-01-05T09:00:00.000Z");
  assert.equal(opp.metadata.record_type, "opportunity");
  assert.equal(opp.occurred_at, "2026-10-20T12:30:00.000Z"); // LastModifiedDate (P4 design Decision 3)
  assert.ok(opp.content.endsWith('Opportunity "Phoenix Upgrade" - Last modified: 2026-10-20T12:30:00.000Z'));
  assert.deepEqual(JSON.parse(opp.metadata.sf_fields_json)[0], { api: "StageName", label: "Stage", value: "Awareness" });

  const task = records[`src_sf_${sid("00T", 1)}`];
  assert.equal(task.source_type, "crm_activity");
  assert.equal(task.occurred_at, "2026-10-01T15:00:00.000Z");
  assert.equal(task.metadata.sf_what_object, "Opportunity");
  assert.equal(task.metadata.sf_what_id, sid("006", 1));
  assert.equal(task.metadata.sf_who_id, sid("003", 1));
  assert.deepEqual(task.question_ids, ["FM-REL-001"]);
});

test("question_ids only include requested IDs", async () => {
  const { adapter } = adapterFor(northwindRows);
  const result = await adapter.retrieve(request({ questions: [{ id: "FM-STK-001", text: "c?" }] }));
  const records = byObject(result.records);
  assert.deepEqual(records[`src_sf_${NORTHWIND_ID}`].question_ids, []);
  assert.deepEqual(records[`src_sf_${sid("003", 1)}`].question_ids, ["FM-STK-001"]);
});

test("sparse fields produce no lines and are listed in sf_null_fields", async () => {
  const { adapter } = adapterFor(northwindRows);
  const result = await adapter.retrieve(request());
  const sparse = byObject(result.records)[`src_sf_${sid("006", 2)}`];
  assert.equal(sparse.content, 'Salesforce Opportunity "Fleet Review"\nOpportunity "Fleet Review" - Stage [StageName]: Prospecting\nOpportunity "Fleet Review" - Close Date [CloseDate]: 2027-01-31\nOpportunity "Fleet Review" - Last modified: 2026-10-20T12:30:00.000Z');
  assert.ok(sparse.metadata.sf_null_fields.split(",").includes("Amount"));
  assert.ok(!sparse.metadata.sf_null_fields.split(",").includes("StageName"));
  assert.equal(sparse.metadata.sf_truncated, undefined);
});

test("a record with no populated field is still emitted", async () => {
  const rows = { ...northwindRows, Contact: [{ Id: sid("003", 9), Name: "Casey Blank", AccountId: NORTHWIND_ID, Title: null, Department: "  " }] };
  const { adapter } = adapterFor(rows);
  const result = await adapter.retrieve(request());
  const contact = byObject(result.records)[`src_sf_${sid("003", 9)}`];
  assert.equal(contact.content, 'Salesforce Contact "Casey Blank"');
  assert.equal(contact.metadata.sf_null_fields, "Title,Department");
});

test("no contacts and no activity: Event is still queried, no errors", async () => {
  const { adapter, client } = adapterFor({ Account: northwindRows.Account });
  const result = await adapter.retrieve(request());
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(client.calls.length, 5);
  assert.deepEqual(client.calls.map((c) => c.args), evidencePlan(NORTHWIND_ACCOUNT_ID).calls.map((c) => c.args));
});

test("Contact never selects or maps PII even when the row carries it", async () => {
  const { adapter, client } = adapterFor(northwindRows);
  const result = await adapter.retrieve(request());
  const contactCall = client.calls.find((c) => /FROM Contact/.test(c.args.queryParams.q));
  assert.ok(!/Email|Phone|Mailing/.test(contactCall.args.queryParams.q));
  const serialized = JSON.stringify(result.records);
  assert.ok(!serialized.includes("jordan.sample@") && !serialized.includes("555 0100"));
});

test("free-text fields in a row are ignored, never mapped", async () => {
  const rows = structuredClone(northwindRows);
  rows.Account[0].Description = "SECRET FREE TEXT";
  rows.Opportunity[0].NextStep = "SECRET NEXT STEP";
  rows.Task[0].Description = "SECRET COMMENT";
  const { adapter } = adapterFor(rows);
  const result = await adapter.retrieve(request());
  assert.ok(!JSON.stringify(result.records).includes("SECRET"));
});

test("a foreign AccountId row is rejected by evidence.retrieve", async () => {
  const rows = structuredClone(northwindRows);
  rows.Opportunity[1].AccountId = sid("001", 77);
  const { adapter } = adapterFor(rows);
  const raw = await adapter.retrieve(request());
  assert.equal(byObject(raw.records)[`src_sf_${sid("006", 2)}`].account_id, `sf_${sid("001", 77)}`);
  const { adapter: fresh } = adapterFor(rows); // replay is strict: entries were consumed above
  const skill = await retrieveEvidence({ account_id: NORTHWIND_ACCOUNT_ID, questions: QUESTIONS, requested_sources: ["crm"], context: {} }, { adapter: fresh });
  assert.ok(skill.data.records.every((r) => r.record_id !== `src_sf_${sid("006", 2)}`));
  assert.equal(skill.data.records.length, 4);
});

test("pagination: done:false triggers a second captured call and merges rows", async () => {
  const next = "/services/data/v66.0/query/01gSYN000000001-2000";
  const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
  const oppIndex = entries.findIndex((e) => /FROM Opportunity/.test(e.args.queryParams?.q ?? ""));
  entries[oppIndex] = { ...entries[oppIndex], result: sfOk("Opportunity", [northwindRows.Opportunity[0]], { done: false, nextRecordsUrl: next }) };
  entries.splice(oppIndex + 1, 0, { tool: "dispatch_readonly", args: nextPageArgs(next), result: textEnvelope(sfOk("Opportunity", [northwindRows.Opportunity[1]])) });
  const client = replay(entries);
  const result = await createSalesforceEvidenceAdapter({ client, now: NOW }).retrieve(request());
  assert.equal(result.ok, true);
  assert.equal(result.records.filter((r) => r.metadata.object_name === "Opportunity").length, 2);
  assert.equal(client.calls.length, 6);
  assert.deepEqual(client.unconsumed(), []);
});

test("a missing captured page is replay_unmatched and fails the source", async () => {
  const next = "/services/data/v66.0/query/01gSYN000000001-2000";
  const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
  const oppIndex = entries.findIndex((e) => /FROM Opportunity/.test(e.args.queryParams?.q ?? ""));
  entries[oppIndex] = { ...entries[oppIndex], result: sfOk("Opportunity", [northwindRows.Opportunity[0]], { done: false, nextRecordsUrl: next }) };
  const result = await createSalesforceEvidenceAdapter({ client: replay(entries), now: NOW }).retrieve(request());
  assert.equal(result.ok, false);
  assert.deepEqual([result.error.code, result.error.retryable, result.error.details.reason], ["ADAPTER_UNAVAILABLE", false, "replay_unmatched"]);
});

test("keep+1 truncation keeps `keep` records and flags them sf_truncated", async () => {
  const opps = [1, 2, 3].map((n) => ({ Id: sid("006", n), Name: `Opp ${n}`, AccountId: NORTHWIND_ID, StageName: "Awareness", CloseDate: "2026-12-01" }));
  const entries = evidencePlan(NORTHWIND_ACCOUNT_ID, { limits: { Opportunity: 2 } }).calls.map((c) => ({
    tool: "dispatch_readonly", args: c.args, result: sfOk(c.step, c.step === "Opportunity" ? opps : (northwindRows[c.step] ?? [])),
  }));
  const adapter = createSalesforceEvidenceAdapter({ client: replay(entries), now: NOW, limits: { Opportunity: 2 } });
  const result = await adapter.retrieve(request());
  const kept = result.records.filter((r) => r.metadata.object_name === "Opportunity");
  assert.equal(kept.length, 2);
  assert.ok(kept.every((r) => r.metadata.sf_truncated === true));
  assert.ok(result.records.filter((r) => r.metadata.object_name !== "Opportunity").every((r) => r.metadata.sf_truncated === undefined));
});

test("unsupported source and invalid account id", async () => {
  const { adapter, client } = adapterFor(northwindRows);
  const unsupported = await adapter.retrieve(request({ source_type: "public_source" }));
  assert.deepEqual([unsupported.ok, unsupported.error.code, unsupported.error.retryable], [false, "UNSUPPORTED_SOURCE", false]);
  const invalid = await adapter.retrieve(request({ account_id: "acct_123" }));
  assert.deepEqual([invalid.ok, invalid.error.code, invalid.error.details.reason], [false, "ADAPTER_UNAVAILABLE", "invalid_account_id"]);
  assert.equal(client.calls.length, 0);
});

test("malformed values fail the source: wrong type, bad date, bad datetime", async () => {
  const mutate = (fn) => { const rows = structuredClone(northwindRows); fn(rows); return rows; };
  for (const rows of [
    mutate((r) => { r.Account[0].NumberOfEmployees = "250"; }),
    mutate((r) => { r.Opportunity[0].CloseDate = "15/12/2026"; }),
    mutate((r) => { r.Task[0].CompletedDateTime = "yesterday"; }),
    mutate((r) => { r.Contact[0].Title = { x: 1 }; }),
  ]) {
    const result = await adapterFor(rows).adapter.retrieve(request());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ADAPTER_MALFORMED_RESPONSE");
  }
});

// --- error classification (design 6.2 + decision 6) ------------------------------------------

const MATRIX = [
  [sfError(401, "INVALID_AUTH_HEADER"), "ADAPTER_UNAUTHORIZED", true, "transient_auth"],
  [sfError(401, "INVALID_SESSION_ID"), "ADAPTER_UNAUTHORIZED", false, "unauthenticated"],
  [sfError(403, "REQUEST_LIMIT_EXCEEDED"), "ADAPTER_UNAVAILABLE", true, "rate_limited"],
  [sfError(403, "INSUFFICIENT_ACCESS"), "ADAPTER_UNAUTHORIZED", false, "forbidden"],
  [sfError(400, "INVALID_FIELD", "No such column 'Secret__c' on entity 'Contact'. SELECT Name FROM Account WHERE Name = 'Secret Customer'"), "ADAPTER_UNAUTHORIZED", false, "field_not_accessible"],
  [sfError(400, "INVALID_TYPE"), "ADAPTER_UNAUTHORIZED", false, "object_not_accessible"],
  [sfError(400, "MALFORMED_QUERY"), "ADAPTER_UNAVAILABLE", false, "query_rejected"],
  [sfError(400, "INVALID_SEARCH"), "ADAPTER_UNAVAILABLE", false, "query_rejected"],
  [sfError(404, "NOT_FOUND"), "ADAPTER_UNAVAILABLE", false, "endpoint_not_found"],
  [sfError(429, "REQUEST_LIMIT_EXCEEDED"), "ADAPTER_UNAVAILABLE", true, "transient"],
  [sfError(503, "SERVER_UNAVAILABLE"), "ADAPTER_UNAVAILABLE", true, "transient"],
];

test("error classification: thrown recorded errors and resolved error payloads", async () => {
  for (const [payload, code, retryable, reason] of MATRIX) {
    for (const mode of ["thrown", "resolved", "enveloped"]) {
      const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
      const contact = entries.findIndex((e) => /FROM Contact/.test(e.args.queryParams.q));
      const { result: _ignored, ...base } = entries[contact];
      entries[contact] = mode === "thrown" ? { ...base, error: payload } : { ...base, result: mode === "resolved" ? payload : textEnvelope(payload) };
      const result = await createSalesforceEvidenceAdapter({ client: replay(entries), now: NOW }).retrieve(request());
      const label = `${mode} ${payload.status_code} ${reason}`;
      assert.equal(result.ok, false, label);
      assert.deepEqual([result.error.code, result.error.retryable, result.error.details.reason], [code, retryable, reason], label);
      const text = JSON.stringify(result.error);
      assert.ok(!text.includes("Secret Customer") && !text.includes("SELECT"), "no SOQL or message echo");
    }
  }
});

test("INVALID_FIELD keeps only field and object names", async () => {
  const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
  entries[0] = { tool: entries[0].tool, args: entries[0].args, captured_at: entries[0].captured_at, error: MATRIX[4][0] };
  const result = await createSalesforceEvidenceAdapter({ client: replay(entries), now: NOW }).retrieve(request());
  assert.equal(result.error.details.field, "Secret__c");
  assert.equal(result.error.details.object, "Contact");
  assert.equal(result.error.details.sf_error_code, "INVALID_FIELD");
});

test("tool not found, replay miss, success body without records", async () => {
  const noTool = { listTools: async () => ({ tools: [] }), callTool: async () => { throw new McpClientError("TOOL_NOT_FOUND", "x", { tool: "dispatch_readonly" }); } };
  const a = await createSalesforceEvidenceAdapter({ client: noTool }).retrieve(request());
  assert.deepEqual([a.error.code, a.error.retryable, a.error.details.reason], ["ADAPTER_UNAVAILABLE", false, "tool_not_found"]);
  const other = [{ tool: "dispatch_readonly", args: { url: "/other", method: "GET" }, result: {} }];
  const b = await createSalesforceEvidenceAdapter({ client: replay(other) }).retrieve(request());
  assert.deepEqual([b.error.code, b.error.retryable, b.error.details.reason], ["ADAPTER_UNAVAILABLE", false, "replay_unmatched"]);
  const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
  entries[0] = { ...entries[0], result: { status_code: 200, body: { totalSize: 0, done: true }, url: "/q" } };
  const c = await createSalesforceEvidenceAdapter({ client: replay(entries), now: NOW }).retrieve(request());
  assert.deepEqual([c.error.code, c.error.details.reason], ["ADAPTER_MALFORMED_RESPONSE", "malformed_body"]);
});

test("strict replay: an exhausted entry fails instead of being reused", async () => {
  const { adapter } = adapterFor(northwindRows);
  assert.equal((await adapter.retrieve(request())).ok, true);
  const again = await adapter.retrieve(request());
  assert.deepEqual([again.ok, again.error.details.reason], [false, "replay_exhausted"]);
});

test("error in the Contact query fails the whole crm source (no partial records)", async () => {
  const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
  const contact = entries.findIndex((e) => /FROM Contact/.test(e.args.queryParams.q));
  entries[contact] = { tool: entries[contact].tool, args: entries[contact].args, error: sfError(403, "INSUFFICIENT_ACCESS") };
  const result = await createSalesforceEvidenceAdapter({ client: replay(entries), now: NOW }).retrieve(request());
  assert.equal(result.ok, false);
  assert.equal(result.records, undefined);
});

// --- classification --------------------------------------------------------------------------

test("default internal is visible by default; public ceiling withholds everything", async () => {
  const { adapter } = adapterFor(northwindRows);
  const visible = await retrieveEvidence({ account_id: NORTHWIND_ACCOUNT_ID, questions: QUESTIONS, requested_sources: ["crm"], context: {} }, { adapter });
  assert.equal(visible.data.records.length, 5);
  const { adapter: again } = adapterFor(northwindRows);
  const publicOnly = await retrieveEvidence({ account_id: NORTHWIND_ACCOUNT_ID, questions: QUESTIONS, requested_sources: ["crm"], context: { permitted_classifications: ["public"] } }, { adapter: again });
  assert.equal(publicOnly.status, "blocked");
  assert.equal(publicOnly.data?.records?.length ?? 0, 0);
});

test("objectClassification confidential withholds Contacts only", async () => {
  const { adapter } = adapterFor(northwindRows, { objectClassification: { Contact: "confidential" } });
  const result = await retrieveEvidence({ account_id: NORTHWIND_ACCOUNT_ID, questions: QUESTIONS, requested_sources: ["crm"], context: {} }, { adapter });
  const objects = result.data.records.map((r) => r.metadata.object_name);
  assert.ok(!objects.includes("Contact"));
  assert.equal(objects.length, 4);
});

test("instanceUrl builds record links; default is null", async () => {
  const { adapter } = adapterFor(northwindRows, { instanceUrl: "https://example-org.lightning.force.com/" });
  const result = await adapter.retrieve(request());
  const account = byObject(result.records)[`src_sf_${NORTHWIND_ID}`];
  assert.equal(account.source_uri, `https://example-org.lightning.force.com/lightning/r/Account/${NORTHWIND_ID}/view`);
  assert.equal(validate("sourceRecord", account).valid, true);
});
