import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../schemas/index.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { deriveClaimId } from "../skills/evidence-normalize/claims.js";

const FIXTURES = [
  "normalize-single-source",
  "normalize-multiple-claims",
  "normalize-duplicate",
  "normalize-conflicting",
  "normalize-unsupported",
  "normalize-classification",
  "normalize-empty",
];

function loadFixture(name) {
  const dir = new URL("../fixtures/" + name + "/", import.meta.url);
  return {
    name,
    records: JSON.parse(readFileSync(new URL("records.json", dir), "utf8")),
    expected: JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")).expected,
  };
}

const fixtures = FIXTURES.map(loadFixture);

async function run(fixture, overrides = {}) {
  const extractor = createFixtureClaimExtractor();
  const input = { account_id: fixture.records.account_id, records: fixture.records.records, ...overrides };
  return normalizeEvidence(input, { extractor });
}

function assertEnvelope(result) {
  const { valid, errors } = validate("skillResult", result);
  assert.equal(valid, true, "envelope invalid: " + JSON.stringify(errors));
  assert.match(result.trace_id, /^trace_/);
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
}

function assertClaimsValidate(result) {
  for (const claim of result.data.claims) {
    const { valid, errors } = validate("evidence", claim);
    assert.equal(valid, true, "claim " + claim.claim_id + " invalid: " + JSON.stringify(errors));
  }
}

test("all seven normalize fixtures are present", () => {
  assert.equal(fixtures.length, 7);
});

for (const fixture of fixtures) {
  test(fixture.name + ": primary case matches expected.json", async () => {
    const result = await run(fixture);
    assertEnvelope(result);
    assertClaimsValidate(result);
    const expected = fixture.expected;

    assert.equal(result.status, expected.status, "status");
    assert.equal(result.data.claim_count, expected.claim_count, "claim_count");
    assert.equal(result.data.rejected_records.length, expected.rejected_count, "rejected count");
    assert.equal(result.data.conflicts.length, expected.conflict_count ?? 0, "conflict count");

    if (expected.claim_texts) {
      assert.deepEqual(
        result.data.claims.map((c) => c.claim).sort(),
        [...expected.claim_texts].sort(),
      );
    }
    if (expected.published_at !== undefined) {
      assert.equal(result.data.claims[0].published_at, expected.published_at);
      if (expected.occurred_at === null) {
        assert.equal(result.data.claims[0].occurred_at, undefined);
      } else if (expected.occurred_at !== undefined) {
        assert.equal(result.data.claims[0].occurred_at, expected.occurred_at);
      }
    }
    if (expected.classifications) {
      assert.deepEqual(
        result.data.claims.map((c) => c.access_classification).sort(),
        [...expected.classifications].sort(),
      );
    }
    if (expected.verification) {
      assert.deepEqual(
        result.data.claims.map((c) => c.verification_status).sort(),
        [...expected.verification].sort(),
      );
    }
    if (expected.confidence) {
      assert.deepEqual(
        result.data.claims.map((c) => c.confidence).sort(),
        [...expected.confidence].sort(),
      );
    }
    if (expected.rejection_reasons) {
      assert.deepEqual(
        result.data.rejected_records.map((r) => r.reason).sort(),
        [...expected.rejection_reasons].sort(),
      );
    }
    if (expected.warning_codes) {
      for (const code of expected.warning_codes) {
        assert.ok(
          result.warnings.some((w) => w.code === code),
          "expected warning " + code,
        );
      }
    }
    if (expected.source_record_count !== undefined) {
      assert.equal(result.data.source_record_count, expected.source_record_count);
    }
    if (expected.conflict_keys) {
      assert.deepEqual(
        result.data.conflicts.map((c) => c.conflict_key).sort(),
        [...expected.conflict_keys].sort(),
      );
    }

    assert.deepEqual(
      result.evidence_ids.sort(),
      result.data.claims.map((c) => c.claim_id).sort(),
    );
  });
}
// ---- Targeted behavior tests beyond the fixtures ----

const BASE_RECORD = {
  record_id: "src_t_0001",
  account_id: "acct_northstar",
  source_type: "news",
  title: "Test record",
  content: "Northstar Logistics announced a three-year modernization program.",
  source_uri: "https://news.example/test",
  occurred_at: "2026-08-10T00:00:00Z",
  retrieved_at: "2026-10-20T14:00:00Z",
  access_classification: "public",
  question_ids: ["FM-DEV-001"],
  metadata: {},
};

const CANDIDATE = {
  claim: "Northstar Logistics announced a three-year modernization program.",
  excerpt: "Northstar Logistics announced a three-year modernization program.",
  completeness: "complete",
};

function withCandidates(record, candidates) {
  return { ...record, metadata: { claim_candidates_json: JSON.stringify(candidates) } };
}

async function runRaw(records, extractorOptions = {}) {
  const extractor = createFixtureClaimExtractor(extractorOptions);
  return normalizeEvidence({ account_id: "acct_northstar", records }, { extractor });
}

test("claim IDs are deterministic across runs", async () => {
  const fixture = fixtures.find((f) => f.name === "normalize-single-source");
  const first = await run(fixture);
  const second = await run(fixture);
  assert.equal(first.data.claims.length, 1);
  assert.equal(first.data.claims[0].claim_id, second.data.claims[0].claim_id);
  assert.match(first.data.claims[0].claim_id, /^clm_[a-f0-9]{16}$/);
});

test("claim ID matches the documented derivation", async () => {
  const result = await runRaw([withCandidates(BASE_RECORD, [CANDIDATE])]);
  const expectedId = deriveClaimId("acct_northstar", "src_t_0001", CANDIDATE.claim);
  assert.equal(result.data.claims[0].claim_id, expectedId);
});

test("malformed source record is rejected with reason malformed_source_record", async () => {
  const broken = { ...BASE_RECORD, content: "" };
  const result = await runRaw([broken]);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.claim_count, 0);
  assert.equal(result.data.rejected_records.length, 1);
  assert.equal(result.data.rejected_records[0].reason, "malformed_source_record");
  assert.equal(result.data.rejected_records[0].scope, "record");
  assert.equal(result.data.rejected_records[0].source_record_id, "src_t_0001");
});

test("foreign-account record is rejected with reason foreign_account", async () => {
  const foreign = { ...BASE_RECORD, record_id: "src_t_0002", account_id: "acct_other" };
  const result = await runRaw([foreign]);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.rejected_records[0].reason, "foreign_account");
  assert.equal(result.data.rejected_records[0].source_record_id, "src_t_0002");
  assert.equal(result.data.claim_count, 0);
});

test("excerpt missing from content is rejected with reason excerpt_not_found", async () => {
  const candidate = { ...CANDIDATE, excerpt: "This sentence is not in the record." };
  const result = await runRaw([withCandidates(BASE_RECORD, [candidate])]);
  assertEnvelope(result);
  assert.equal(result.data.rejected_records[0].reason, "excerpt_not_found");
  assert.equal(result.data.rejected_records[0].scope, "candidate");
  assert.equal(result.data.rejected_records[0].candidate_index, 0);
  assert.equal(result.data.claim_count, 0);
});

test("whitespace-only excerpt difference still matches verbatim", async () => {
  const record = { ...BASE_RECORD, content: "Northstar  Logistics   announced a three-year modernization program." };
  const result = await runRaw([withCandidates(record, [CANDIDATE])]);
  assert.equal(result.data.claim_count, 1, "whitespace runs are the only permitted deviation");
});

test("classification downgrade candidate is rejected, equal classification kept", async () => {
  const confidential = { ...BASE_RECORD, access_classification: "confidential" };
  const downgraded = { ...CANDIDATE, access_classification: "public" };
  const kept = { ...CANDIDATE, access_classification: "confidential" };
  const result = await runRaw([withCandidates(confidential, [downgraded, kept])]);
  assertEnvelope(result);
  assert.equal(result.data.rejected_records[0].reason, "classification_violation");
  assert.equal(result.data.claims.length, 1);
  assert.equal(result.data.claims[0].access_classification, "confidential");
});

test("claim may raise classification above the record level", async () => {
  const raised = { ...CANDIDATE, access_classification: "confidential" };
  const result = await runRaw([withCandidates(BASE_RECORD, [raised])]);
  assert.equal(result.data.claims[0].access_classification, "confidential");
});

test("conflicting claims are both retained, linked, and never merged", async () => {
  const fixture = fixtures.find((f) => f.name === "normalize-conflicting");
  const result = await run(fixture);
  assert.equal(result.data.claims.length, 2);
  assert.ok(result.data.claims.every((c) => c.verification_status === "conflicting"));
  assert.equal(result.data.conflicts.length, 1);
  const conflict = result.data.conflicts[0];
  assert.equal(conflict.claim_ids.length, 2);
  assert.deepEqual(
    conflict.claim_ids.sort(),
    result.data.claims.map((c) => c.claim_id).sort(),
  );
  assert.match(conflict.conflict_id, /^cfl_/);
  const recordIds = result.data.claims.map((c) => c.source_record_id).sort();
  assert.deepEqual(recordIds, ["src_news_4001", "src_site_4002"]);
});

test("same conflict key with identical claim text is not a conflict", async () => {
  const r1 = withCandidates({ ...BASE_RECORD, record_id: "src_t_0010" }, [{ ...CANDIDATE, conflict_key: "program" }]);
  const r2 = withCandidates(
    { ...BASE_RECORD, record_id: "src_t_0011", content: "Northstar Logistics announced a three-year modernization program.", source_type: "company_site" },
    [{ ...CANDIDATE, conflict_key: "program" }],
  );
  const result = await runRaw([r1, r2]);
  assert.equal(result.data.conflicts.length, 0, "agreement is not a conflict");
  assert.equal(result.data.claims.length, 2, "independent provenance kept");
});

test("equivalent claims across records keep separate provenance (no cross-record dedup)", async () => {
  const fixture = fixtures.find((f) => f.name === "normalize-duplicate");
  const result = await run(fixture);
  assert.equal(result.data.claims.length, 2);
  const sources = result.data.claims.map((c) => c.source_record_id).sort();
  assert.deepEqual(sources, ["src_crm_3001", "src_crm_3002"]);
  const ids = result.data.claims.map((c) => c.claim_id);
  assert.equal(new Set(ids).size, 2, "distinct records produce distinct claim IDs");
});

test("within-record duplicate is removed and counted as a warning", async () => {
  const fixture = fixtures.find((f) => f.name === "normalize-duplicate");
  const result = await run(fixture);
  const dupes = result.data.rejected_records.filter((r) => r.reason === "duplicate_claim");
  assert.equal(dupes.length, 1);
  assert.ok(result.warnings.some((w) => w.code === "DUPLICATE_CLAIMS_REMOVED"));
});

test("output ordering is deterministic", async () => {
  const fixture = fixtures.find((f) => f.name === "normalize-multiple-claims");
  const first = await run(fixture);
  const second = await run(fixture);
  assert.deepEqual(first.data.claims, second.data.claims);
  assert.deepEqual(first.data.rejected_records, second.data.rejected_records);
  assert.deepEqual(first.data.conflicts, second.data.conflicts);
  const order = first.data.claims.map((c) => c.claim_id);
  const sorted = [...order].sort();
  assert.deepEqual(order, sorted, "claims are sorted by claim_id within the record");
});

test("zero accepted claims from an empty list is success, not failure", async () => {
  const result = await runRaw([]);
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.equal(result.data.claim_count, 0);
  assert.deepEqual(result.data.claims, []);
  assert.deepEqual(result.evidence_ids, []);
  assert.deepEqual(result.errors, []);
});

test("zero accepted claims with a record that yields no candidates is still success", async () => {
  const result = await runRaw([{ ...BASE_RECORD, metadata: {} }]);
  assert.equal(result.status, "success");
  assert.equal(result.data.claim_count, 0);
});

test("record with a malformed candidate shape is extractor_failure for the record", async () => {
  const record = withCandidates(BASE_RECORD, [{ claim: "no excerpt" }]);
  const result = await runRaw([record]);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.rejected_records[0].reason, "extractor_failure");
  assert.equal(result.errors[0].code, "EXTRACTOR_MALFORMED_RESPONSE");
  assert.equal(result.errors[0].retryable, false);
  assert.equal(result.data.claim_count, 0);
});

test("extractor unexpected throw is normalized and the record is rejected", async () => {
  const result = await runRaw([withCandidates(BASE_RECORD, [CANDIDATE])], { mode: "throw" });
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.rejected_records[0].reason, "extractor_failure");
  assert.equal(result.errors[0].code, "EXTRACTOR_UNAVAILABLE");
  assert.equal(result.data.claim_count, 0);
});

test("extractor malformed envelope is a non-retryable failure for that record", async () => {
  const result = await runRaw([withCandidates(BASE_RECORD, [CANDIDATE])], { mode: "malformed" });
  assertEnvelope(result);
  assert.equal(result.errors[0].code, "EXTRACTOR_MALFORMED_RESPONSE");
  assert.equal(result.errors[0].retryable, false);
  assert.equal(result.data.rejected_records[0].reason, "extractor_failure");
});

test("extractor error result is surfaced per record", async () => {
  const result = await runRaw([withCandidates(BASE_RECORD, [CANDIDATE])], { mode: "error" });
  assertEnvelope(result);
  assert.equal(result.errors[0].code, "EXTRACTOR_UNAVAILABLE");
  assert.equal(result.data.rejected_records[0].reason, "extractor_failure");
});

test("extractor failure on one record does not prevent other records from normalizing", async () => {
  const good = withCandidates(
    { ...BASE_RECORD, record_id: "src_t_0020", content: "The pilot is proceeding." },
    [{ claim: "The pilot is proceeding.", excerpt: "The pilot is proceeding.", completeness: "complete" }],
  );
  const extractor = {
    name: "mixed-extractor",
    async extract(record) {
      if (record.record_id === "src_t_0001") throw new Error("boom");
      return { ok: true, candidates: JSON.parse(record.metadata.claim_candidates_json) };
    },
  };
  const result = await normalizeEvidence(
    { account_id: "acct_northstar", records: [withCandidates(BASE_RECORD, [CANDIDATE]), good] },
    { extractor },
  );
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.claim_count, 1);
  assert.equal(result.data.rejected_records.length, 1);
  assert.equal(result.data.claims[0].source_record_id, "src_t_0020");
});

test("missing extractor is a failed result with no data", async () => {
  const result = await normalizeEvidence(
    { account_id: "acct_northstar", records: [] },
    {},
  );
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "EXTRACTOR_MALFORMED_RESPONSE");
});

test("input validation: account_id and records required", async () => {
  const extractor = createFixtureClaimExtractor();
  const cases = [
    [{ records: [] }, "missing account_id"],
    [{ account_id: "", records: [] }, "blank account_id"],
    [{ account_id: "acct_northstar" }, "missing records"],
    [{ account_id: "Northstar Logistics", records: [] }, "account name"],
  ];
  for (const [input, label] of cases) {
    const result = await normalizeEvidence(input, { extractor });
    assertEnvelope(result);
    assert.equal(result.status, "failed", label);
    assert.equal(result.data, null, label);
    assert.equal(result.errors[0].code, "INVALID_INPUT", label);
  }
});

test("rejected-record diagnostics never contain record content", async () => {
  const confidentialContent = "Secret reorganization details for 2027.";
  const record = {
    ...BASE_RECORD,
    record_id: "src_t_0030",
    access_classification: "confidential",
    content: confidentialContent,
    metadata: { claim_candidates_json: JSON.stringify([{ ...CANDIDATE, excerpt: "not present" }]) },
  };
  const result = await runRaw([record]);
  const serialized = JSON.stringify(result.data.rejected_records);
  assert.ok(!serialized.includes(confidentialContent));
  assert.ok(!serialized.includes("reorganization"));
});

test("publication and occurrence timestamps remain distinct", async () => {
  const record = {
    ...BASE_RECORD,
    published_at: "2026-10-01T10:00:00Z",
    occurred_at: "2026-09-28T09:00:00Z",
  };
  const result = await runRaw([withCandidates(record, [CANDIDATE])]);
  const claim = result.data.claims[0];
  assert.equal(claim.published_at, "2026-10-01T10:00:00Z");
  assert.equal(claim.occurred_at, "2026-09-28T09:00:00Z");
  assert.equal(claim.claim_id, deriveClaimId("acct_northstar", "src_t_0001", CANDIDATE.claim));
});

test("claims preserve provenance fields from the record", async () => {
  const result = await runRaw([withCandidates(BASE_RECORD, [CANDIDATE])]);
  const claim = result.data.claims[0];
  assert.equal(claim.source_record_id, "src_t_0001");
  assert.equal(claim.source_uri, "https://news.example/test");
  assert.equal(claim.source_type, "news");
  assert.equal(claim.account_id, "acct_northstar");
  assert.equal(claim.occurred_at, "2026-08-10T00:00:00Z");
  assert.equal(claim.published_at, undefined, "publication time is omitted when the source has none");
  assert.equal(claim.retrieved_at, "2026-10-20T14:00:00Z");
  assert.deepEqual(claim.question_ids, ["FM-DEV-001"]);
});