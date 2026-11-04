import test from "node:test";
import assert from "node:assert/strict";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import {
  createSalesforceStructuredClaimExtractor, DEFAULT_CLAIM_LIMITS, OPPORTUNITY_CLAIM_FIELDS,
} from "../adapters/salesforce/claim-extractor.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { replay, sid } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, NORTHWIND_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

// Brief-size limits; user decision 2026-11-04; selection is ordering only, not prioritisation policy.
const NOW = () => new Date("2026-11-04T10:00:00Z");
const extractor = createSalesforceStructuredClaimExtractor();
const pad = (n) => String(n).padStart(2, "0");
const find = (all, id) => all.find((r) => r.record_id === id);

async function records(rows, options = {}) {
  const adapter = createSalesforceEvidenceAdapter({ client: replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, rows)), now: NOW, ...options });
  const result = await adapter.retrieve({ account_id: NORTHWIND_ACCOUNT_ID, questions: [], source_type: "crm", context: {} });
  assert.equal(result.ok, true);
  return result.records;
}

function bigRows() {
  const rows = structuredClone(northwindRows);
  const opp = (n, closeDate, modified = "2026-10-20T12:30:00.000+0000") => ({
    ...northwindRows.Opportunity[0], Id: sid("006", n), Name: `Deal ${pad(n)}`, CloseDate: closeDate, LastModifiedDate: modified,
  });
  rows.Opportunity = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => opp(n, `2027-01-${pad(n)}`)),
    opp(9, "2027-01-05", "2026-10-25T00:00:00.000+0000"),
    opp(10, "2027-01-05", "2026-10-25T00:00:00.000+0000"),
    opp(11, "2027-01-01", "2026-01-01T00:00:00.000+0000"), // ties n=1 on CloseDate, older LastModifiedDate
    opp(12, null),
    opp(13, "2020-01-01"),
    opp(14, "2020-01-01"),
  ];
  rows.Contact = Array.from({ length: 25 }, (_, n) => ({
    ...northwindRows.Contact[0], Id: sid("003", n + 1), Name: `Person ${pad(n + 1)}`, LastModifiedDate: `2026-09-${pad(n + 1)}T00:00:00.000+0000`,
  }));
  rows.Task = Array.from({ length: 14 }, (_, n) => ({
    ...northwindRows.Task[0], Id: sid("00T", n + 1), ActivityDate: n < 12 ? `2026-10-${pad(n + 1)}` : null,
  }));
  rows.Event = Array.from({ length: 14 }, (_, n) => ({
    Id: sid("00U", n + 1), AccountId: NORTHWIND_ID, StartDateTime: `2026-05-${pad(n + 1)}T10:00:00.000+0000`,
    EndDateTime: `2026-05-${pad(n + 1)}T11:00:00.000+0000`, Type: "Meeting", Owner: null, WhatId: null, WhoId: null,
    LastModifiedDate: "2026-10-20T12:30:00.000+0000",
  }));
  return rows;
}

const claimed = (all, objectName) => all
  .filter((r) => r.metadata.object_name === objectName && extractor.extract(r).candidates.length > 0)
  .map((r) => r.metadata.sf_id).sort();

test("Opportunities claim only Stage/Amount/Close Date; exactly 10, chosen by the ordering", async () => {
  const all = await records(bigRows());
  const opps = all.filter((r) => r.metadata.object_name === "Opportunity");
  assert.equal(opps.length, 14);
  // CloseDate desc: 08 07 06, then the 01-05 trio (09 and 10 newer than 05; 09 before 10 by Id),
  // 04 03 02, then 01 beats 11 on LastModifiedDate. Null and 2020 dates fall outside the cap.
  const ids = [8, 7, 6, 9, 10, 5, 4, 3, 2, 1].map((n) => sid("006", n)).sort();
  assert.deepEqual(claimed(all, "Opportunity"), ids);
  for (const record of opps.filter((r) => ids.includes(r.metadata.sf_id))) {
    const claims = extractor.extract(record).candidates.map((c) => c.claim);
    assert.equal(claims.length, 4); // existence header + 3 fields
    assert.ok(claims.slice(1).every((c) => /(Stage|Amount|Close Date):/.test(c)));
  }
});

test("excluded records keep full content and every candidate still normalizes", async () => {
  const all = await records(bigRows());
  const dropped = find(all, `src_sf_${sid("006", 11)}`);
  assert.equal(dropped.metadata.sf_claim_excluded, true);
  assert.deepEqual(extractor.extract(dropped), { ok: true, candidates: [] });
  for (const label of ["Stage [StageName]", "Probability", "Forecast Category", "Cluster__c", "Qualification_Score__c"]) {
    assert.ok(dropped.content.includes(label), label);
  }
  const kept = find(all, `src_sf_${sid("006", 1)}`);
  assert.equal(kept.metadata.sf_claim_excluded, undefined);
  assert.ok(kept.content.includes("Probability"));
  const result = await normalizeEvidence({ account_id: NORTHWIND_ACCOUNT_ID, records: all }, { extractor });
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.rejected_records ?? [], []);
  assert.deepEqual(result.data.rejected_candidates ?? [], []);
  assert.equal(result.data.claims.length, all.reduce((sum, r) => sum + extractor.extract(r).candidates.length, 0));
});

test("per-object caps: Contact 20, Task 10, Event 10; Account unchanged", async () => {
  const all = await records(bigRows());
  assert.deepEqual(claimed(all, "Contact"), Array.from({ length: 20 }, (_, i) => sid("003", i + 6)).sort());
  assert.deepEqual(claimed(all, "Task"), Array.from({ length: 10 }, (_, i) => sid("00T", i + 3)).sort());
  assert.deepEqual(claimed(all, "Event"), Array.from({ length: 10 }, (_, i) => sid("00U", i + 5)).sort());
  assert.ok(extractor.extract(find(all, `src_sf_${NORTHWIND_ID}`)).candidates.length > 0);
});

test("deterministic, independent of row order; limits can only be lowered", async () => {
  const rows = bigRows();
  const reversed = structuredClone(rows);
  for (const key of ["Opportunity", "Contact", "Task", "Event"]) reversed[key].reverse();
  const a = await records(rows);
  const b = await records(reversed);
  for (const objectName of ["Opportunity", "Contact", "Task", "Event"]) {
    assert.deepEqual(claimed(a, objectName), claimed(b, objectName), objectName);
  }

  const lowered = await records(rows, { claimLimits: { Opportunity: 3, Task: 0 } });
  assert.equal(claimed(lowered, "Opportunity").length, 3);
  assert.equal(claimed(lowered, "Task").length, 0);
  assert.equal(claimed(lowered, "Contact").length, 20);
  for (const bad of [{ Opportunity: 11 }, { Contact: 21 }, { Opportunity: -1 }, { Account: 1 }, { Task: 1.5 }]) {
    assert.throws(() => createSalesforceEvidenceAdapter({ client: replay([]), claimLimits: bad }), TypeError);
  }
});

test("defaults are the documented constants", () => {
  assert.deepEqual({ ...DEFAULT_CLAIM_LIMITS }, { Opportunity: 10, Contact: 20, Task: 10, Event: 10 });
  assert.deepEqual([...OPPORTUNITY_CLAIM_FIELDS], ["StageName", "Amount", "CloseDate"]);
});
