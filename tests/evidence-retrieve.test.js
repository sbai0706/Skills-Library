import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../schemas/index.js";
import { createFixtureEvidenceAdapter, loadEvidenceFixture } from "../adapters/fixture-evidence-adapter.js";
import { retrieveEvidence, SOURCE_OUTCOME } from "../skills/evidence-retrieve/index.js";

const fixtures = [
  "evidence-complete",
  "evidence-sparse",
  "evidence-partial-source-failure",
  "evidence-unauthorized",
].map(loadEvidenceFixture);

const questions = [
  { id: "FM-CTX-001", text: "What does the company sell, to whom, and in which geographies?" },
  { id: "FM-DEV-001", text: "What credible initiative or event has the company disclosed in the last twelve months?" },
];

function assertEnvelope(result) {
  const { valid, errors } = validate("skillResult", result);
  assert.equal(valid, true, `envelope invalid: ${JSON.stringify(errors)}`);
  assert.match(result.trace_id, /^trace_/);
  assert.deepEqual(result.evidence_ids, [], "retrieval produces no evidence claim IDs");
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
}

function assertRecordsValid(result) {
  for (const record of result.data.records) {
    const { valid, errors } = validate("sourceRecord", record);
    assert.equal(valid, true, `record ${record.record_id} invalid: ${JSON.stringify(errors)}`);
  }
}

const completeQuestions = loadEvidenceFixture("evidence-complete").expected.input.questions;

async function run(fixture, overrides = {}) {
  return retrieveEvidence(
    { ...fixture.expected.input, ...overrides },
    { adapter: createFixtureEvidenceAdapter({ fixture: fixture.name }) },
  );
}

test("fixtures cover the four intended scenarios", () => {
  const outcomes = fixtures.map((f) => f.expected.expected.status).sort();
  assert.deepEqual(outcomes, ["partial", "partial", "success", "success"]);
});

test("valid input: CRM and public-source retrieval succeeds", async () => {
  const fixture = fixtures.find((f) => f.name === "evidence-complete");
  const result = await run(fixture);
  assertEnvelope(result);
  assertRecordsValid(result);
  assert.equal(result.status, fixture.expected.expected.status);
  assert.equal(result.data.record_count, fixture.expected.expected.record_count);
  assert.equal(result.data.records.length, fixture.expected.expected.record_count);
  assert.equal(result.data.account_id, "sf_clear_001");
  assert.deepEqual(result.errors, []);
  for (const [source, outcome] of Object.entries(fixture.expected.expected.source_outcomes)) {
    assert.equal(
      result.data.source_results.find((r) => r.source === source).outcome,
      outcome,
    );
  }
});

test("CRM-only retrieval succeeds", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-complete" });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["crm"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.equal(result.data.record_count, 3);
  assert.ok(result.data.records.every((r) => ["crm_record", "crm_activity"].includes(r.source_type)));
  assert.deepEqual(result.data.requested_sources, ["crm"]);
});

test("public-source retrieval succeeds", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-complete" });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["public_source"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.equal(result.data.record_count, 2);
  assert.ok(result.data.records.every((r) => ["news", "company_site", "third_party"].includes(r.source_type)));
});

test("zero records is success, not failure, and does not claim absence", async () => {
  const fixture = fixtures.find((f) => f.name === "evidence-sparse");
  const result = await run(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.records, []);
  assert.equal(result.data.record_count, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.data.source_results.map((r) => r.outcome),
    ["empty", "empty"],
  );
  assert.ok(result.warnings.some((w) => w.code === "NO_RECORDS_RETRIEVED"));
  const warningText = result.warnings.find((w) => w.code === "NO_RECORDS_RETRIEVED").message;
  assert.match(warningText, /does not mean the information does not exist/i);
});

test("one source unavailable produces partial with the successful records", async () => {
  const fixture = fixtures.find((f) => f.name === "evidence-partial-source-failure");
  const result = await run(fixture);
  assertEnvelope(result);
  assertRecordsValid(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.data.records.map((r) => r.record_id),
    fixture.expected.expected.record_ids,
  );
  assert.equal(result.data.source_results.find((r) => r.source === "public_source").outcome, "unavailable");
  assert.equal(result.data.source_results.find((r) => r.source === "crm").outcome, "ok");
  assert.deepEqual(result.errors.map((e) => e.code), ["ADAPTER_UNAVAILABLE"]);
  assert.equal(result.errors[0].details.source, "public_source");
  assert.equal(result.errors[0].retryable, true);
  assert.ok(result.warnings.some((w) => w.code === "PARTIAL_SOURCES"));
});

test("authorization denial leaks no restricted records and returns partial", async () => {
  const fixture = fixtures.find((f) => f.name === "evidence-unauthorized");
  const result = await run(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.data.records.map((r) => r.record_id),
    fixture.expected.expected.record_ids,
  );
  for (const forbidden of fixture.expected.expected.forbidden_record_ids) {
    assert.ok(!result.data.records.some((r) => r.record_id === forbidden), "restricted record absent");
  }
  const serialized = JSON.stringify(result);
  for (const text of fixture.expected.expected.forbidden_text) {
    assert.ok(!serialized.includes(text), "restricted text absent from the whole result");
  }
  assert.deepEqual(result.errors.map((e) => e.code), ["ADAPTER_UNAUTHORIZED"]);
  assert.equal(result.errors[0].retryable, false);
  assert.equal(result.data.source_results.find((r) => r.source === "public_source").outcome, "unauthorized");
});

test("authorization denied for the only source returns blocked", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-unauthorized" });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["public_source"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "blocked", "access denial with no usable source is a policy block");
  assert.deepEqual(result.data.records, []);
  assert.equal(result.errors[0].code, "ADAPTER_UNAUTHORIZED");
});

test("all requested sources unavailable returns failed with no records", async () => {
  const adapter = createFixtureEvidenceAdapter({
    sources: {
      sources: {
        crm: { mode: "unavailable", records: [] },
        public_source: { mode: "unavailable", records: [] },
      },
    },
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm", "public_source"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data.record_count, 0);
  assert.equal(result.data.records.length, 0);
  assert.deepEqual(result.errors.map((e) => e.code), ["ADAPTER_UNAVAILABLE", "ADAPTER_UNAVAILABLE"]);
  assert.ok(result.errors.every((e) => e.retryable === true));
});

test("malformed adapter envelope is rejected for that source only", async () => {
  const adapter = createFixtureEvidenceAdapter({
    sources: {
      sources: {
        crm: {
          mode: "ok",
          records: [
            {
              record_id: "src_crm_act_5001",
              account_id: "sf_clear_001",
              source_type: "crm_activity",
              title: "Call notes",
              content: "Notes.",
              source_uri: null,
              occurred_at: null,
              retrieved_at: "2026-10-20T14:00:00Z",
              access_classification: "internal",
              question_ids: ["FM-CTX-001"],
              metadata: {},
            },
          ],
        },
        public_source: { mode: "malformed_envelope", records: [] },
      },
    },
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm", "public_source"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.record_count, 1);
  assert.deepEqual(result.errors.map((e) => [e.code, e.details.source]), [
    ["ADAPTER_MALFORMED_RESPONSE", "public_source"],
  ]);
});

test("one malformed record is rejected while valid records survive", async () => {
  const good = {
    record_id: "src_crm_act_5101",
    account_id: "sf_clear_001",
    source_type: "crm_activity",
    title: "Valid call notes",
    content: "Valid content.",
    source_uri: null,
    occurred_at: null,
    retrieved_at: "2026-10-20T14:00:00Z",
    access_classification: "internal",
    question_ids: ["FM-CTX-001"],
    metadata: { provider: "fixture-crm" },
  };
  const missingContent = { ...good, record_id: "src_crm_act_5102", title: "Broken record" };
  delete missingContent.content;
  const wrongAccount = { ...good, record_id: "src_crm_act_5103", account_id: "sf_other_999" };

  const adapter = createFixtureEvidenceAdapter({
    sources: { sources: { crm: { mode: "ok", records: [good, missingContent, wrongAccount] } } },
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.records.map((r) => r.record_id), ["src_crm_act_5101"]);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((e) => e.code === "ADAPTER_MALFORMED_RESPONSE"));
  for (const error of result.errors) {
    assert.ok(Array.isArray(error.details.problems) && error.details.problems.length > 0);
    assert.equal(error.retryable, false, "malformed payloads are non-retryable");
    // Rejected-record diagnostics must not echo content or identifiers.
    const serialized = JSON.stringify(error);
    assert.ok(!serialized.includes("src_crm_act_510"), "record id must not appear in diagnostics");
    assert.ok(!serialized.includes("Valid content"), "record content must not appear in diagnostics");
  }
});

test("adapter throwing unexpectedly is normalized, not propagated", async () => {
  const adapter = createFixtureEvidenceAdapter({
    sources: { sources: { crm: { mode: "throw", records: [] } } },
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data.records.length, 0);
  assert.equal(result.errors[0].code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.errors[0].retryable, true);
  assert.equal(result.errors[0].details.thrown, true);
});

test("records are returned in deterministic order", async () => {
  const fixture = fixtures.find((f) => f.name === "evidence-complete");
  const first = await run(fixture);
  const second = await run(fixture);
  const ids = (result) => result.data.records.map((r) => r.record_id);
  assert.deepEqual(ids(first), fixture.expected.expected.record_order);
  assert.deepEqual(ids(first), ids(second));
  assert.notEqual(first.trace_id, second.trace_id);
});

test("duplicate records across sources are deduplicated by record ID", async () => {
  const record = {
    record_id: "src_dup_1",
    account_id: "sf_clear_001",
    source_type: "crm_activity",
    title: "Same record",
    content: "Same content.",
    source_uri: null,
    occurred_at: null,
    retrieved_at: "2026-10-20T14:00:00Z",
    access_classification: "internal",
    question_ids: ["FM-CTX-001"],
    metadata: {},
  };
  const adapter = createFixtureEvidenceAdapter({
    sources: { sources: { crm: { mode: "ok", records: [record, record] } } },
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter },
  );
  assert.equal(result.data.records.length, 1);
});

test("records carry source data only, never claim fields", async () => {
  const fixture = fixtures.find((f) => f.name === "evidence-complete");
  const result = await run(fixture);
  for (const record of result.data.records) {
    for (const forbidden of ["claim", "confidence", "verification_status", "claim_id"]) {
      assert.equal(record[forbidden], undefined, `${record.record_id} must not carry ${forbidden}`);
    }
    assert.ok(Array.isArray(record.question_ids));
  }
});

test("unknown requested source is rejected, not ignored", async () => {
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm", "dark_web"] },
    { adapter: createFixtureEvidenceAdapter({ fixture: "evidence-complete" }) },
  );
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.deepEqual(result.errors.map((e) => e.code), ["UNSUPPORTED_SOURCE"]);
  assert.deepEqual(result.errors[0].details.supported_sources, ["crm", "public_source", "internal_document"]);
});

test("input validation rejects missing account ID, empty questions, and empty sources", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-complete" });
  const cases = [
    [{ questions, requested_sources: ["crm"] }, "missing account_id"],
    [{ account_id: "", questions, requested_sources: ["crm"] }, "blank account_id"],
    [{ account_id: "sf_clear_001", questions: [], requested_sources: ["crm"] }, "empty questions"],
    [{ account_id: "sf_clear_001", requested_sources: ["crm"] }, "absent questions"],
    [{ account_id: "sf_clear_001", questions, requested_sources: [] }, "empty sources"],
    [{ account_id: "sf_clear_001", questions }, "absent sources"],
    [{ account_id: "sf_clear_001", questions: [{ id: "Q1", text: "" }], requested_sources: ["crm"] }, "blank question text"],
  ];
  for (const [input, label] of cases) {
    const result = await retrieveEvidence(input, { adapter });
    assertEnvelope(result);
    assert.equal(result.status, "failed", label);
    assert.equal(result.data, null, label);
    assert.equal(result.errors[0].code, "INVALID_INPUT", label);
  }
});

test("an unresolved account name is rejected in place of account_id", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-complete" });
  for (const accountId of ["Northstar Logistics", "northstar-logistics.example"]) {
    const result = await retrieveEvidence(
      { account_id: accountId, questions, requested_sources: ["crm"] },
      { adapter },
    );
    assertEnvelope(result);
    assert.equal(result.status, "failed");
    assert.equal(result.errors[0].code, "INVALID_INPUT");
  }
});

test("duplicate or conflicting question IDs are rejected", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-complete" });
  const duplicate = await retrieveEvidence(
    {
      account_id: "sf_clear_001",
      questions: [
        { id: "FM-CTX-001", text: "What does the company sell?" },
        { id: "FM-CTX-001", text: "What does the company sell, again?" },
      ],
      requested_sources: ["crm"],
    },
    { adapter },
  );
  assert.equal(duplicate.status, "failed");
  assert.match(duplicate.errors[0].message, /Duplicate question id/);
});

test("record referencing a question outside the request is rejected", async () => {
  const adapter = createFixtureEvidenceAdapter({
    sources: {
      sources: {
        crm: {
          mode: "ok",
          records: [
            {
              record_id: "src_crm_act_5201",
              account_id: "sf_clear_001",
              source_type: "crm_activity",
              title: "Call notes",
              content: "Notes.",
              source_uri: null,
              occurred_at: null,
              retrieved_at: "2026-10-20T14:00:00Z",
              access_classification: "internal",
              question_ids: ["FM-UNKNOWN-999"],
              metadata: {},
            },
          ],
        },
      },
    },
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter },
  );
  // The only source produced nothing usable, so this is an execution failure,
  // not a partial result.
  assert.equal(result.status, "failed");
  assert.equal(result.data.record_count, 0);
  assert.equal(result.errors[0].code, "ADAPTER_MALFORMED_RESPONSE");
  assert.ok(result.errors[0].details.problems.some((p) => p.includes("FM-UNKNOWN-999")));
});

test("classification filter withholds restricted records and says so", async () => {
  const adapter = createFixtureEvidenceAdapter({ fixture: "evidence-complete" });
  const result = await retrieveEvidence(
    {
      account_id: "sf_clear_001",
      questions: completeQuestions,
      requested_sources: ["crm"],
      context: { requested_by: "user_17", permitted_classifications: ["public"] },
    },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.data.record_count, 0, "no internal records may pass a public-only limit");
  assert.ok(result.warnings.some((w) => w.code === "RECORDS_WITHHELD"));
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.errors.map((e) => e.code), ["CLASSIFICATION_RESTRICTED"]);
});

test("adapter that does not implement retrieve fails without throwing", async () => {
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter: { name: "broken" } },
  );
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].code, "ADAPTER_MALFORMED_RESPONSE");
});

test("adapter lacking a declared source returns unsupported for that source", async () => {
  const adapter = createFixtureEvidenceAdapter({
    fixture: "evidence-complete",
    supportedSources: ["crm"],
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["crm", "public_source"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.source_results.find((r) => r.source === "public_source").outcome, "unsupported");
  const unsupported = result.errors.find((e) => e.code === "UNSUPPORTED_SOURCE");
  assert.ok(unsupported, "unsupported source is reported");
  assert.equal(unsupported.details.source, "public_source");
});

function makeRecord(overrides = {}) {
  return {
    record_id: "src_crm_act_6101",
    account_id: "sf_clear_001",
    source_type: "crm_activity",
    title: "Executive compensation review",
    content: "Confidential negotiation notes that must not leave the system.",
    source_uri: null,
    occurred_at: null,
    retrieved_at: "2026-10-20T14:00:00Z",
    access_classification: "confidential",
    question_ids: ["FM-CTX-001"],
    metadata: { provider: "fixture-crm", record_type: "note" },
    ...overrides,
  };
}

const confidentialRecord = makeRecord();

function classificationAdapter(records) {
  return createFixtureEvidenceAdapter({ sources: { sources: { crm: { mode: "ok", records } } } });
}

/** Assert a serialized result contains none of the given source text or IDs. */
function assertNoLeak(result, forbidden) {
  const serialized = JSON.stringify(result);
  for (const value of forbidden) {
    assert.ok(!serialized.includes(value), `withheld content must not appear: ${value}`);
  }
}

test("omitted permitted_classifications permits public and internal but not confidential", async () => {
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["crm"] },
    { adapter: classificationAdapter([
      makeRecord({ record_id: "src_pub_1", access_classification: "public", title: "Public note", content: "Public content." }),
      makeRecord({ record_id: "src_int_1", access_classification: "internal", title: "Internal note", content: "Internal content." }),
      confidentialRecord,
    ]) },
  );
  assertEnvelope(result);
  assert.equal(result.status, "partial", "a withheld record degrades the source");
  assert.deepEqual(
    result.data.records.map((r) => r.access_classification).sort(),
    ["internal", "public"],
  );
  assert.ok(result.warnings.some((w) => w.code === "RECORDS_WITHHELD"));
  assert.deepEqual(result.errors.map((e) => e.code), ["CLASSIFICATION_RESTRICTED"]);
  assert.equal(result.errors[0].retryable, false);
  assertNoLeak(result, [confidentialRecord.record_id, confidentialRecord.title, confidentialRecord.content]);
});

test("explicit empty permitted_classifications permits no records", async () => {
  const result = await retrieveEvidence(
    {
      account_id: "sf_clear_001",
      questions: completeQuestions,
      requested_sources: ["crm"],
      context: { permitted_classifications: [] },
    },
    { adapter: classificationAdapter([makeRecord({ access_classification: "public" })]) },
  );
  assertEnvelope(result);
  assert.deepEqual(result.data.records, []);
  assert.equal(result.data.record_count, 0);
  assert.ok(result.warnings.some((w) => w.code === "RECORDS_WITHHELD"));
  assertNoLeak(result, [confidentialRecord.record_id, confidentialRecord.content]);
});

test("confidential records are returned only when explicitly permitted", async () => {
  const result = await retrieveEvidence(
    {
      account_id: "sf_clear_001",
      questions: completeQuestions,
      requested_sources: ["crm"],
      context: { permitted_classifications: ["confidential"] },
    },
    { adapter: classificationAdapter([confidentialRecord]) },
  );
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.records.map((r) => r.record_id), [confidentialRecord.record_id]);
});

test("an unrecognized classification is withheld, reported, and never treated as public", async () => {
  const unknown = makeRecord({
    record_id: "src_odd_1",
    title: "Secret odd record",
    content: "Odd classification content.",
    access_classification: "restricted",
  });
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["crm"] },
    {
      adapter: classificationAdapter([
        unknown,
        makeRecord({ record_id: "src_pub_2", access_classification: "public", content: "Public content.", title: "Public note" }),
      ]),
    },
  );
  assertEnvelope(result);
  assert.equal(result.data.record_count, 1);
  assert.equal(result.data.records[0].access_classification, "public");
  assert.ok(result.warnings.some((w) => w.code === "UNRECOGNIZED_CLASSIFICATION_WITHHELD"));
  assert.equal(result.data.source_results[0].withheld_count, 1);
  assertNoLeak(result, ["restricted", unknown.record_id, unknown.content, unknown.title]);
});

test("withheld records leak nothing through warnings, errors, counts, or metadata", async () => {
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["crm"] },
    {
      adapter: classificationAdapter([
        makeRecord({ record_id: "src_pub_3", access_classification: "public", title: "Public note", content: "Public content." }),
        confidentialRecord,
      ]),
    },
  );
  assertNoLeak(result, [confidentialRecord.record_id, confidentialRecord.title, confidentialRecord.content]);
  // Aggregate counts only.
  assert.equal(result.data.source_results[0].withheld_count, 1);
  assert.equal(result.data.source_results[0].record_count, 1);
});

test("a withheld-only source is not reported as empty", async () => {
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions: completeQuestions, requested_sources: ["crm"] },
    { adapter: classificationAdapter([confidentialRecord]) },
  );
  assertEnvelope(result);
  assert.equal(result.status, "blocked", "withholding every record is an access-policy block");
  assert.equal(result.data.source_results[0].outcome, "malformed");
  assert.equal(result.data.source_results[0].retained_count, 1);
  assert.equal(result.data.record_count, 0);
  assert.deepEqual(result.errors.map((e) => e.code), ["CLASSIFICATION_RESTRICTED"]);
  assertNoLeak(result, [confidentialRecord.record_id, confidentialRecord.title, confidentialRecord.content]);
});

test("malformed adapter payloads are non-retryable and never retried", async () => {
  let calls = 0;
  const adapter = {
    name: "counting-adapter",
    supportedSources: ["crm"],
    async retrieve() {
      calls += 1;
      return { ok: true, records: "not-an-array" };
    },
  };
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter },
  );
  assertEnvelope(result);
  assert.equal(calls, 1, "the skill must not retry the adapter");
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].code, "ADAPTER_MALFORMED_RESPONSE");
  assert.equal(result.errors[0].retryable, false);
});

test("an unsupported source is non-retryable and is not retried", async () => {
  let calls = 0;
  const adapter = {
    name: "strict-adapter",
    supportedSources: ["crm"],
    async retrieve() {
      calls += 1;
      return { ok: true, records: [] };
    },
  };
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm", "public_source"] },
    { adapter },
  );
  assert.equal(calls, 1, "an unsupported source is not dispatched or retried");
  const unsupported = result.errors.find((e) => e.code === "UNSUPPORTED_SOURCE");
  assert.equal(unsupported.retryable, false);
});

test("only transport unavailability is marked retryable, and the skill still retries nothing", async () => {
  let calls = 0;
  const adapter = {
    name: "flaky-adapter",
    supportedSources: ["crm"],
    async retrieve() {
      calls += 1;
      return { ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "timeout", retryable: true } };
    },
  };
  const result = await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
    { adapter },
  );
  assert.equal(calls, 1, "a future live adapter may retry internally; the skill must not");
  assert.equal(result.errors[0].code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.errors[0].retryable, true);
});

test("raw source record example validates against the source-record schema", async () => {
  const { readFileSync } = await import("node:fs");
  const example = JSON.parse(
    readFileSync(new URL("../schemas/source-record.example.json", import.meta.url), "utf8"),
  );
  const { valid, errors } = validate("sourceRecord", example);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("SOURCE_OUTCOME vocabulary is stable", () => {
  assert.deepEqual(Object.values(SOURCE_OUTCOME).sort(), [
    "empty",
    "malformed",
    "ok",
    "unauthorized",
    "unavailable",
    "unsupported",
  ]);
});
