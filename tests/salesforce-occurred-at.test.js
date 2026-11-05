import test from "node:test";
import assert from "node:assert/strict";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/evidence-adapter.js";
import { createSalesforceStructuredClaimExtractor } from "../adapters/salesforce/claim-extractor.js";
import { rankSources } from "../skills/source-rank/index.js";
import { validate } from "../schemas/index.js";
import { replay, sid } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, NORTHWIND_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

// P4 design, Decision 3: Salesforce `occurred_at` is LastModifiedDate-based (changes P2 section 3.3).

const NOW = () => new Date("2026-11-04T10:00:00Z");
const request = { account_id: NORTHWIND_ACCOUNT_ID, questions: [{ id: "FM-CTX-001", text: "a?" }], source_type: "crm", context: {} };
const MODIFIED = "2026-10-20T12:30:00.000Z";

async function retrieve(rows) {
  const client = replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, rows));
  const result = await createSalesforceEvidenceAdapter({ client, now: NOW }).retrieve(request);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return Object.fromEntries(result.records.map((record) => [record.record_id, record]));
}

const taskRow = (patch) => ({
  Id: sid("00T", 7), AccountId: NORTHWIND_ID, Status: "Open", Priority: "Normal", Type: "Call", Owner: null, WhatId: null, WhoId: null,
  CreatedDate: "2026-01-05T09:00:00.000+0000", LastModifiedDate: "2026-10-22T08:00:00.000+0000", ActivityDate: null, CompletedDateTime: null,
  ...patch,
});
const eventRow = (patch) => ({
  Id: sid("00U", 7), AccountId: NORTHWIND_ID, StartDateTime: null, EndDateTime: null, Type: "Meeting", Owner: null, WhatId: null, WhoId: null,
  CreatedDate: "2026-01-05T09:00:00.000+0000", LastModifiedDate: "2026-10-23T09:00:00.000+0000",
  ...patch,
});

test("Account, Opportunity and Contact use LastModifiedDate with a content line and a source marker", async () => {
  const records = await retrieve(northwindRows);
  for (const [id, label, name] of [
    [NORTHWIND_ID, "Account", "Northwind Traders"],
    [sid("006", 1), "Opportunity", "Phoenix Upgrade"],
    [sid("003", 1), "Contact", "Jordan Sample"],
  ]) {
    const record = records[`src_sf_${id}`];
    assert.equal(record.occurred_at, MODIFIED, label);
    assert.equal(record.published_at, null);
    assert.equal(record.metadata.sf_occurred_at_source, "LastModifiedDate");
    assert.ok(record.content.endsWith(`\n${label} "${name}" - Last modified: ${MODIFIED}`), label);
    assert.equal(validate("sourceRecord", record).valid, true);
  }
});

test("a record with no LastModifiedDate has occurred_at null and no Last modified line", async () => {
  const rows = structuredClone(northwindRows);
  rows.Contact[0].LastModifiedDate = null;
  const contact = (await retrieve(rows))[`src_sf_${sid("003", 1)}`];
  assert.equal(contact.occurred_at, null);
  assert.equal(contact.metadata.sf_occurred_at_source, undefined);
  assert.ok(!contact.content.includes("Last modified"));
});

test("Task: CompletedDateTime wins and no Last modified line is written", async () => {
  const rows = { ...northwindRows, Task: [taskRow({ CompletedDateTime: "2026-10-01T15:00:00.000+0000", ActivityDate: "2026-09-30" })] };
  const task = (await retrieve(rows))[`src_sf_${sid("00T", 7)}`];
  assert.equal(task.occurred_at, "2026-10-01T15:00:00.000Z");
  assert.equal(task.metadata.sf_occurred_at_source, "CompletedDateTime");
  assert.ok(!task.content.includes("Last modified"));
});

test("Task: without CompletedDateTime ActivityDate is used as UTC midnight", async () => {
  const rows = { ...northwindRows, Task: [taskRow({ ActivityDate: "2026-09-30" })] };
  const task = (await retrieve(rows))[`src_sf_${sid("00T", 7)}`];
  assert.equal(task.occurred_at, "2026-09-30T00:00:00.000Z");
  assert.equal(task.metadata.sf_occurred_at_source, "ActivityDate");
  assert.ok(!task.content.includes("Last modified"));
  assert.equal(validate("sourceRecord", task).valid, true);
});

test("Task: without CompletedDateTime and ActivityDate LastModifiedDate is used", async () => {
  const rows = { ...northwindRows, Task: [taskRow({})] };
  const task = (await retrieve(rows))[`src_sf_${sid("00T", 7)}`];
  assert.equal(task.occurred_at, "2026-10-22T08:00:00.000Z");
  assert.equal(task.metadata.sf_occurred_at_source, "LastModifiedDate");
  assert.ok(task.content.endsWith('Task "Call / Open" - Last modified: 2026-10-22T08:00:00.000Z'));
});

test("Task: a malformed ActivityDate is still malformed (no silent fallback)", async () => {
  const client = replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, { ...northwindRows, Task: [taskRow({ ActivityDate: "soon" })] }));
  const result = await createSalesforceEvidenceAdapter({ client, now: NOW }).retrieve(request);
  assert.equal(result.ok, false);
});

test("Event: StartDateTime wins and no Last modified line is written", async () => {
  const rows = { ...northwindRows, Event: [eventRow({ StartDateTime: "2026-03-01T10:00:00.000+0000", EndDateTime: "2026-03-01T11:00:00.000+0000" })] };
  const event = (await retrieve(rows))[`src_sf_${sid("00U", 7)}`];
  assert.equal(event.occurred_at, "2026-03-01T10:00:00.000Z");
  assert.equal(event.metadata.sf_occurred_at_source, "StartDateTime");
  assert.ok(!event.content.includes("Last modified"));
});

test("Event: without StartDateTime LastModifiedDate is used", async () => {
  const rows = { ...northwindRows, Event: [eventRow({})] };
  const event = (await retrieve(rows))[`src_sf_${sid("00U", 7)}`];
  assert.equal(event.occurred_at, "2026-10-23T09:00:00.000Z");
  assert.equal(event.metadata.sf_occurred_at_source, "LastModifiedDate");
  assert.ok(event.content.endsWith('Event "Meeting / (no date)" - Last modified: 2026-10-23T09:00:00.000Z'));
});

test("Last modified is content only: no claim is produced for it", async () => {
  const records = await retrieve(northwindRows);
  const extractor = createSalesforceStructuredClaimExtractor();
  for (const record of Object.values(records)) {
    assert.ok(extractor.extract(record).candidates.every((c) => !c.claim.includes("Last modified")));
  }
});

test("source.rank over Salesforce records ranks on occurred_at, not on retrieval time", async () => {
  const records = Object.values(await retrieve(northwindRows));
  const result = rankSources({ account_id: NORTHWIND_ACCOUNT_ID, records, now: "2026-11-05T12:00:00Z" });
  assert.notEqual(result.status, "failed", JSON.stringify(result.errors));
  assert.equal(result.data.sources.length, 1);
  const [source] = result.data.sources;
  assert.equal(source.source_id, "salesforce");
  assert.equal(source.recency, "dated");
  assert.equal(source.latest_data_at, "2026-10-20T12:30:00Z");
  assert.equal(source.latest_data_at_field, "occurred_at");
  assert.ok(!result.warnings.some((warning) => warning.code === "RETRIEVAL_TIME_FALLBACK"));
});

// ---------------------------------------------------------------- future activity times and calendar validation

test("a future CompletedDateTime is skipped: the past ActivityDate applies", async () => {
  const rows = { ...northwindRows, Task: [taskRow({ CompletedDateTime: "2026-12-01T09:00:00.000+0000", ActivityDate: "2026-09-30" })] };
  const task = (await retrieve(rows))[`src_sf_${sid("00T", 7)}`];
  assert.equal(task.occurred_at, "2026-09-30T00:00:00.000Z");
  assert.equal(task.metadata.sf_occurred_at_source, "ActivityDate");
});

test("an open task due in the future falls back to LastModifiedDate and says so", async () => {
  const rows = { ...northwindRows, Task: [taskRow({ ActivityDate: "2026-12-01" })] };
  const task = (await retrieve(rows))[`src_sf_${sid("00T", 7)}`];
  assert.equal(task.occurred_at, "2026-10-22T08:00:00.000Z");
  assert.equal(task.metadata.sf_occurred_at_source, "LastModifiedDate");
  assert.ok(task.content.endsWith('Task "Call / Open" - Last modified: 2026-10-22T08:00:00.000Z'));
});

test("both Task candidates in the future fall back to LastModifiedDate; a due date earlier today is not future", async () => {
  const future = { ...northwindRows, Task: [taskRow({ CompletedDateTime: "2026-11-04T10:00:01.000+0000", ActivityDate: "2026-11-05" })] };
  const a = (await retrieve(future))[`src_sf_${sid("00T", 7)}`];
  assert.equal(a.metadata.sf_occurred_at_source, "LastModifiedDate");
  const today = { ...northwindRows, Task: [taskRow({ ActivityDate: "2026-11-04" })] };
  const b = (await retrieve(today))[`src_sf_${sid("00T", 7)}`];
  assert.equal(b.occurred_at, "2026-11-04T00:00:00.000Z");
  assert.equal(b.metadata.sf_occurred_at_source, "ActivityDate");
  const exact = { ...northwindRows, Task: [taskRow({ CompletedDateTime: "2026-11-04T10:00:00.000+0000" })] };
  assert.equal((await retrieve(exact))[`src_sf_${sid("00T", 7)}`].metadata.sf_occurred_at_source, "CompletedDateTime", "equal to the retrieval time is not later");
});

test("a scheduled (future) Event falls back to LastModifiedDate", async () => {
  const rows = { ...northwindRows, Event: [eventRow({ StartDateTime: "2026-12-15T10:00:00.000+0000", EndDateTime: "2026-12-15T11:00:00.000+0000" })] };
  const event = (await retrieve(rows))[`src_sf_${sid("00U", 7)}`];
  assert.equal(event.occurred_at, "2026-10-23T09:00:00.000Z");
  assert.equal(event.metadata.sf_occurred_at_source, "LastModifiedDate");
  assert.ok(event.content.includes("Last modified: 2026-10-23T09:00:00.000Z"));
  assert.ok(event.content.includes("Start [StartDateTime]: 2026-12-15T10:00:00.000Z"), "the start itself stays a content fact");
});

test("source.rank is not moved by future-dated activities", async () => {
  const rows = { ...northwindRows, Task: [taskRow({ ActivityDate: "2027-06-01" })], Event: [eventRow({ StartDateTime: "2027-07-01T10:00:00.000+0000" })] };
  const records = Object.values(await retrieve(rows));
  const result = rankSources({ account_id: NORTHWIND_ACCOUNT_ID, records, now: "2026-11-05T12:00:00Z" });
  assert.equal(result.data.sources[0].latest_data_at, "2026-10-23T09:00:00Z", "the newest LastModifiedDate, not a 2027 due date");
  assert.ok(result.data.sources[0].age_days >= 0);
});

test("an impossible calendar ActivityDate is treated as missing: the next fallback applies", async () => {
  for (const ActivityDate of ["2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-06-00", "2027-02-29"]) {
    const rows = { ...northwindRows, Task: [taskRow({ ActivityDate })] };
    const task = (await retrieve(rows))[`src_sf_${sid("00T", 7)}`];
    assert.equal(task.metadata.sf_occurred_at_source, "LastModifiedDate", ActivityDate);
    assert.equal(task.occurred_at, "2026-10-22T08:00:00.000Z", ActivityDate);
  }
  const leap = { ...northwindRows, Task: [taskRow({ ActivityDate: "2024-02-29" })] };
  assert.equal((await retrieve(leap))[`src_sf_${sid("00T", 7)}`].occurred_at, "2024-02-29T00:00:00.000Z");
});

test("an impossible calendar datetime is malformed, never a rolled-over instant", async () => {
  for (const value of ["2026-02-31T10:00:00.000+0000", "2026-04-31T10:00:00.000+0000", "2026-03-01T25:00:00.000+0000"]) {
    const client = replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, { ...northwindRows, Task: [taskRow({ CompletedDateTime: value })] }));
    const result = await createSalesforceEvidenceAdapter({ client, now: NOW }).retrieve(request);
    assert.equal(result.ok, false, value);
    assert.equal(result.error.code, "ADAPTER_MALFORMED_RESPONSE");
  }
});
