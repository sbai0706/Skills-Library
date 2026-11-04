import test from "node:test";
import assert from "node:assert/strict";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { createSalesforceStructuredClaimExtractor, CLAIM_EXCLUDED_FIELDS } from "../adapters/salesforce/claim-extractor.js";
import { loadCapture } from "../adapters/mcp/index.js";
import { replay, sid, sfError } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, NORTHWIND_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

const NOW = () => new Date("2026-11-04T10:00:00Z");
const extractor = createSalesforceStructuredClaimExtractor();
const find = (all, id) => all.find((r) => r.record_id === id);
const request = { account_id: NORTHWIND_ACCOUNT_ID, questions: [], source_type: "crm", context: {} };
async function records(rows = northwindRows) {
  const adapter = createSalesforceEvidenceAdapter({ client: replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, rows)), now: NOW });
  const result = await adapter.retrieve(request);
  assert.equal(result.ok, true);
  return result.records;
}

const RAW_FACT_APIS = ["Qualification_Score__c", "Budget_Status__c", "Primary_Buyer_Authority__c", "Awareness_of_Pain__c", "What_s_the_Trigger_and_why_now__c", "Cost_of_Inaction__c", "Buying_Path__c"];

test("raw qualification-like facts stay in record content but never become claim candidates", async () => {
  assert.deepEqual([...CLAIM_EXCLUDED_FIELDS], RAW_FACT_APIS);
  const rows = structuredClone(northwindRows);
  for (const api of RAW_FACT_APIS) rows.Opportunity[0][api] = api === "Qualification_Score__c" ? 77 : `value of ${api}`;
  const opp = find(await records(rows), `src_sf_${sid("006", 1)}`);
  for (const api of RAW_FACT_APIS) assert.ok(opp.content.includes(`- ${api}: `), `${api} line is in content`);
  const candidates = extractor.extract(opp).candidates;
  for (const api of RAW_FACT_APIS) {
    assert.ok(!candidates.some((c) => c.claim.includes(api) || c.excerpt.includes(api)), `${api} yields no candidate`);
  }
  assert.ok(candidates.some((c) => c.claim === 'Opportunity "Phoenix Upgrade" Stage: Awareness'));
  assert.ok(candidates.some((c) => c.claim.includes("Cluster__c")));
});

test("Task and Event names are fixed-label composites; Subject and Location are never selected or mapped", async () => {
  const rows = structuredClone(northwindRows);
  rows.Task[0].Subject = "SECRET SUBJECT";
  rows.Event = [
    { Id: sid("00U", 1), Subject: "SECRET EVENT", AccountId: NORTHWIND_ID, Location: "SECRET ROOM", StartDateTime: "2026-03-01T10:00:00.000+0000", Type: "Meeting" },
    { Id: sid("00U", 2), AccountId: NORTHWIND_ID },
  ];
  const all = await records(rows);
  const task = find(all, `src_sf_${sid("00T", 1)}`);
  assert.equal(task.title, "Task: Call / Completed");
  assert.ok(task.content.includes('Task "Call / Completed" - Assigned To [Owner.Name]: Avery Example'), "Owner with attributes.type Name is read by path");
  assert.equal(find(all, `src_sf_${sid("00U", 1)}`).title, "Event: Meeting / 2026-03-01");
  assert.equal(find(all, `src_sf_${sid("00U", 2)}`).title, "Event: Event / (no date)");
  assert.ok(!JSON.stringify(all).includes("SECRET"));
  const noType = structuredClone(northwindRows);
  noType.Task[0].Type = null;
  noType.Task[0].Status = null;
  assert.equal(find(await records(noType), `src_sf_${sid("00T", 1)}`).title, "Task: Activity / (no status)");
});

test("owner is read by path for any attributes.type (User, Name, absent)", async () => {
  for (const attributes of [{ type: "User" }, { type: "Name" }, undefined]) {
    const rows = structuredClone(northwindRows);
    rows.Account[0].Owner = { ...(attributes ? { attributes } : {}), Name: "Avery Example" };
    const account = find(await records(rows), `src_sf_${NORTHWIND_ID}`);
    assert.ok(account.content.includes("Account Owner [Owner.Name]: Avery Example"));
  }
});

test("through loadCapture default redaction, INVALID_FIELD loses field/object but keeps code and reason", async () => {
  const entries = evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows);
  entries[0] = { tool: entries[0].tool, args: entries[0].args, captured_at: entries[0].captured_at, error: sfError(400, "INVALID_FIELD", "No such column 'Secret__c' on entity 'Account'. SELECT secret") };
  const client = loadCapture({
    format_version: "mcp-capture/1",
    capture: { created_at: "2026-11-04T10:00:00Z", source_system: "salesforce", connector: "synthetic" },
    entries,
  });
  const result = await createSalesforceEvidenceAdapter({ client, now: NOW }).retrieve(request);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAUTHORIZED");
  assert.equal(result.error.details.reason, "field_not_accessible");
  assert.equal(result.error.details.sf_error_code, "INVALID_FIELD");
  assert.equal(result.error.details.field, undefined);
  assert.equal(result.error.details.object, undefined);
});
