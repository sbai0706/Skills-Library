import test from "node:test";
import assert from "node:assert/strict";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { createSalesforceStructuredClaimExtractor, createCompositeClaimExtractor } from "../adapters/salesforce/claim-extractor.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { replay, sid } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, NORTHWIND_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

const NOW = () => new Date("2026-11-04T10:00:00Z");
async function records(rows = northwindRows) {
  const adapter = createSalesforceEvidenceAdapter({ client: replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, rows)), now: NOW });
  const result = await adapter.retrieve({ account_id: NORTHWIND_ACCOUNT_ID, questions: [], source_type: "crm", context: {} });
  assert.equal(result.ok, true);
  return result.records;
}
const extractor = createSalesforceStructuredClaimExtractor();
const find = (all, id) => all.find((r) => r.record_id === id);

test("golden claim and excerpt strings across value types", async () => {
  const all = await records();
  const pairs = (record) => extractor.extract(record).candidates.map((c) => [c.claim, c.excerpt]);
  const opp = pairs(find(all, `src_sf_${sid("006", 1)}`));
  assert.deepEqual(opp[0], ['Salesforce Opportunity "Phoenix Upgrade"', 'Salesforce Opportunity "Phoenix Upgrade"']);
  assert.deepEqual(opp[1], ['Opportunity "Phoenix Upgrade" Stage: Awareness', 'Opportunity "Phoenix Upgrade" - Stage [StageName]: Awareness']); // picklist
  assert.deepEqual(opp[2], ['Opportunity "Phoenix Upgrade" Amount: 50000', 'Opportunity "Phoenix Upgrade" - Amount: 50000']); // currency
  assert.deepEqual(opp[3], ['Opportunity "Phoenix Upgrade" Close Date: 2026-12-15', 'Opportunity "Phoenix Upgrade" - Close Date [CloseDate]: 2026-12-15']); // date
  assert.deepEqual(opp[4], ['Opportunity "Phoenix Upgrade" Probability: 10%', 'Opportunity "Phoenix Upgrade" - Probability: 10%']); // percent
  assert.ok(opp.some(([claim]) => claim === 'Opportunity "Phoenix Upgrade" Budget_Status__c: Approved')); // custom field
  const task = pairs(find(all, `src_sf_${sid("00T", 1)}`));
  assert.ok(task.some(([claim]) => claim === 'Task "Follow up call" Due Date: 2026-10-01'));
  const account = extractor.extract(find(all, `src_sf_${NORTHWIND_ID}`)).candidates;
  assert.ok(!account.some((c) => c.claim.startsWith("Salesforce Account"))); // no existence candidate for Account
  assert.ok(account.every((c) => c.completeness === "complete" && c.conflict_key === undefined && c.access_classification === undefined));
});

test("datetime fields use normalized UTC text", async () => {
  const rows = structuredClone(northwindRows);
  rows.Event = [{ Id: sid("00U", 1), Subject: "Kickoff", AccountId: NORTHWIND_ID, StartDateTime: "2026-03-01T10:00:00.000+0000", EndDateTime: "2026-03-01T11:00:00.000+0000", Location: "Room 1", Type: "Meeting", Owner: null, WhatId: null, WhoId: null }];
  const event = find(await records(rows), `src_sf_${sid("00U", 1)}`);
  assert.equal(event.occurred_at, "2026-03-01T10:00:00.000Z");
  const claims = extractor.extract(event).candidates.map((c) => c.claim);
  assert.ok(claims.includes('Event "Kickoff" Start: 2026-03-01T10:00:00.000Z'));
});

test("every candidate passes evidence.normalize with zero rejections", async () => {
  const all = await records();
  const result = await normalizeEvidence({ account_id: NORTHWIND_ACCOUNT_ID, records: all }, { extractor });
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.rejected_records ?? [], []);
  assert.deepEqual(result.data.rejected_candidates ?? [], []);
  const expected = all.reduce((sum, r) => sum + extractor.extract(r).candidates.length, 0);
  assert.equal(result.data.claims.length, expected);
});

test("tricky names and values still pass evidence.normalize", async () => {
  const rows = structuredClone(northwindRows);
  rows.Opportunity[0].Name = 'The "Big" Deal -  [A] & B: 50% off';
  rows.Contact[0].Title = "Chief Q&A   Officer";
  const all = await records(rows);
  const result = await normalizeEvidence({ account_id: NORTHWIND_ACCOUNT_ID, records: all }, { extractor });
  assert.deepEqual(result.data.rejected_records ?? [], []);
  assert.deepEqual(result.data.rejected_candidates ?? [], []);
});

test("free-text fields never produce claims", async () => {
  const rows = structuredClone(northwindRows);
  rows.Opportunity[0].Description = "Unique free text sentence";
  rows.Opportunity[0].NextStep = "Unique next step";
  const all = await records(rows);
  const claims = all.flatMap((r) => extractor.extract(r).candidates.map((c) => c.claim)).join("\n");
  assert.ok(!/free text|next step/i.test(claims));
});

test("non-Salesforce records yield no candidates", () => {
  assert.deepEqual(extractor.extract({ record_id: "src_x", metadata: { provider: "other" } }), { ok: true, candidates: [] });
  assert.deepEqual(extractor.extract({ record_id: "src_x", metadata: {} }), { ok: true, candidates: [] });
  assert.deepEqual(extractor.extract({ record_id: "src_x" }), { ok: true, candidates: [] });
});

test("bad sf_fields_json is EXTRACTOR_MALFORMED_RESPONSE", async () => {
  const [record] = await records();
  for (const bad of ["not json", '{"a":1}', '[{"api":"A","label":"B"}]', '[{"api":"A","label":"B","value":3}]']) {
    const result = extractor.extract({ ...record, metadata: { ...record.metadata, sf_fields_json: bad } });
    assert.deepEqual([result.ok, result.error.code, result.error.retryable], [false, "EXTRACTOR_MALFORMED_RESPONSE", false]);
  }
  const { sf_record_name, ...rest } = record.metadata;
  assert.equal(extractor.extract({ ...record, metadata: rest }).ok, false);
});

test("composite extractor: concatenates, first failure wins, throw maps to unavailable, 100-cap", async () => {
  const [record] = await records();
  const one = { name: "one", extract: () => ({ ok: true, candidates: [{ claim: "A x", excerpt: "A x" }] }) };
  const two = { name: "two", extract: async () => ({ ok: true, candidates: [{ claim: "B y", excerpt: "B y" }] }) };
  const composite = createCompositeClaimExtractor([one, two]);
  assert.equal(composite.name, "composite-claim-extractor(one+two)");
  assert.deepEqual((await composite.extract(record)).candidates.map((c) => c.claim), ["A x", "B y"]);

  const failing = { extract: () => ({ ok: false, error: { code: "EXTRACTOR_UNAVAILABLE", message: "down", retryable: true } }) };
  const r1 = await createCompositeClaimExtractor([one, failing, two]).extract(record);
  assert.equal(r1.error.code, "EXTRACTOR_UNAVAILABLE");
  const throwing = { extract: () => { throw new Error("boom secret"); } };
  const r2 = await createCompositeClaimExtractor([one, throwing]).extract(record);
  assert.deepEqual([r2.ok, r2.error.code], [false, "EXTRACTOR_UNAVAILABLE"]);
  assert.ok(!JSON.stringify(r2).includes("boom"));
  const many = { extract: () => ({ ok: true, candidates: Array.from({ length: 60 }, (_, i) => ({ claim: `c${i}`, excerpt: `c${i}` })) }) };
  assert.equal((await createCompositeClaimExtractor([many, many]).extract(record)).error.code, "EXTRACTOR_MALFORMED_RESPONSE");
  assert.throws(() => createCompositeClaimExtractor([]), TypeError);
});
