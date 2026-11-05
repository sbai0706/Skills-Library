import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { schemaDocuments, validate } from "../schemas/index.js";
import { rankSources, TIMESTAMP_PRECEDENCE } from "../skills/source-rank/index.js";
import { ageInDays, formatTimestamp, parseTimestamp } from "../skills/source-rank/timestamps.js";

const ACCOUNT = "acct_test_001";
const NOW = "2026-11-05T12:00:00Z";

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const readText = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const fixtureInput = () => readJson("../fixtures/source-rank-recency/input.json");
const fixtureExpected = () => readJson("../fixtures/source-rank-recency/expected.json");

function record(id, provider, overrides = {}) {
  return {
    record_id: `src_${id}`,
    account_id: ACCOUNT,
    source_type: "third_party",
    title: "Synthetic record title",
    content: "Synthetic record content.",
    source_uri: null,
    retrieved_at: "2026-11-01T00:00:00Z",
    access_classification: "internal",
    question_ids: [],
    metadata: provider === null ? {} : { provider },
    ...overrides,
  };
}

function evidence(id, overrides = {}) {
  return {
    claim_id: `clm_${id}`,
    claim: "Synthetic claim.",
    source_type: "third_party",
    source_record_id: `src_${id}`,
    account_id: ACCOUNT,
    retrieved_at: "2026-11-01T00:00:00Z",
    excerpt: "Synthetic excerpt.",
    confidence: "medium",
    verification_status: "direct",
    access_classification: "internal",
    ...overrides,
  };
}

const rank = (input, deps) => rankSources({ account_id: ACCOUNT, now: NOW, ...input }, deps);
const ids = (result) => result.data.sources.map((source) => source.source_id);
const find = (result, sourceId) => result.data.sources.find((source) => source.source_id === sourceId);
const warningCodes = (result) => result.warnings.map((warning) => warning.code);

function assertEnvelope(result) {
  const { valid, errors } = validate("skillResult", result);
  assert.equal(valid, true, "envelope invalid: " + JSON.stringify(errors));
  assert.equal(result.skill, "source.rank");
  assert.match(result.trace_id, /^trace_/);
  if (result.data !== null) {
    const data = validate("sourceRankResult", result.data);
    assert.equal(data.valid, true, "data invalid: " + JSON.stringify(data.errors));
  }
}

function deepFreeze(value) {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function withoutClock(fn) {
  const RealDate = globalThis.Date;
  class NoClockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error("clock read: new Date()");
      super(...args);
    }
    static now() {
      throw new Error("clock read: Date.now()");
    }
  }
  globalThis.Date = NoClockDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// --- Fixture ---------------------------------------------------------------------------------

test("source-rank-recency fixture produces the expected ranking", () => {
  const result = rankSources(fixtureInput());
  const expected = fixtureExpected().expected;
  assertEnvelope(result);
  assert.equal(result.status, expected.status);
  assert.deepEqual(result.data, expected.data);
  assert.deepEqual(result.evidence_ids, expected.evidence_ids);
  assert.deepEqual(warningCodes(result), expected.warning_codes);
  assert.deepEqual(result.errors, []);
});

test("fixture ordering: newer market intelligence outranks CRM; tie, fallback and unknown follow", () => {
  const { data } = rankSources(fixtureInput());
  assert.deepEqual(
    data.sources.map((source) => [source.source_id, source.rank, source.recency]),
    [
      ["fixture-market-intel", 1, "dated"],
      ["fixture-crm", 2, "dated"],
      ["fixture-public-web", 3, "dated"],
      ["fixture-intranet", 4, "retrieval_fallback"],
      ["fixture-partner-feed", null, "unknown"],
    ],
  );
});

test("fixture is synthetic and its foreign record never reaches the output", () => {
  const input = fixtureInput();
  const serialized = JSON.stringify(rankSources(input));
  assert.ok(!serialized.includes("acct_other_999"));
  assert.ok(!serialized.includes("src_crm_act_9901"));
  assert.ok(input.records.every((item) => /fixture|example/i.test(JSON.stringify(item)) || item.content.startsWith("Fictional")));
});

// --- Recency semantics -----------------------------------------------------------------------

test("recency is the data timestamp, not the retrieval time", () => {
  const result = rank({
    records: [
      record("a1", "provider-old-data", {
        occurred_at: "2026-01-01T00:00:00Z",
        retrieved_at: "2026-11-04T00:00:00Z",
      }),
      record("b1", "provider-new-data", {
        published_at: "2026-10-01T00:00:00Z",
        retrieved_at: "2026-10-02T00:00:00Z",
      }),
    ],
  });
  assert.deepEqual(ids(result), ["provider-new-data", "provider-old-data"]);
  assert.equal(find(result, "provider-old-data").latest_data_at_field, "occurred_at");
  assert.equal(find(result, "provider-new-data").latest_data_at_field, "published_at");
  assert.equal(find(result, "provider-old-data").recency, "dated");
});

test("market-intelligence newer than CRM ranks first", () => {
  const result = rank({
    records: [
      record("crm1", "crm", { source_type: "crm_activity", occurred_at: "2026-09-12T15:00:00Z" }),
      record("mi1", "market-intel", { published_at: "2026-10-20T08:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["market-intel", "crm"]);
  assert.deepEqual(result.data.sources.map((source) => source.rank), [1, 2]);
});

test("field precedence is published_at, then occurred_at, then retrieved_at", () => {
  assert.deepEqual([...TIMESTAMP_PRECEDENCE], ["published_at", "occurred_at", "retrieved_at"]);
  const result = rank({
    records: [
      record("both", "p-both", {
        published_at: "2026-10-10T00:00:00Z",
        occurred_at: "2026-10-20T00:00:00Z",
      }),
      record("occ", "p-occurred", { occurred_at: "2026-10-05T00:00:00Z" }),
      record("ret", "p-retrieved", {}),
    ],
  });
  const both = find(result, "p-both");
  assert.equal(both.latest_data_at, "2026-10-10T00:00:00Z");
  assert.equal(both.latest_data_at_field, "published_at");
  assert.equal(find(result, "p-occurred").latest_data_at_field, "occurred_at");
  assert.equal(find(result, "p-retrieved").latest_data_at_field, "retrieved_at");
  assert.deepEqual(result.data.timestamp_precedence, ["published_at", "occurred_at", "retrieved_at"]);
});

test("an invalid higher-precedence timestamp falls through to the next field and is reported", () => {
  const result = rank({
    records: [
      record("x1", "p-fallthrough", {
        published_at: "not a date",
        occurred_at: "2026-10-05T00:00:00Z",
      }),
    ],
  });
  const source = find(result, "p-fallthrough");
  assert.equal(source.latest_data_at, "2026-10-05T00:00:00Z");
  assert.equal(source.latest_data_at_field, "occurred_at");
  assert.equal(source.invalid_timestamp_count, 1);
  assert.equal(result.status, "success");
  assert.ok(warningCodes(result).includes("INVALID_TIMESTAMP_IGNORED"));
});

test("the source latest is the maximum over its records; supporting IDs cover every record at that instant", () => {
  const result = rank({
    records: [
      record("old", "p-multi", { published_at: "2026-09-01T00:00:00Z" }),
      record("z_new", "p-multi", { published_at: "2026-10-01T00:00:00Z" }),
      record("a_new", "p-multi", { occurred_at: "2026-10-01T00:00:00Z" }),
    ],
    evidence: [evidence("z_new", { published_at: "2026-10-01T00:00:00Z" })],
  });
  const source = find(result, "p-multi");
  assert.equal(source.record_count, 4);
  assert.deepEqual(source.supporting_record_ids, ["src_a_new", "src_z_new"]);
  assert.deepEqual(source.supporting_evidence_ids, ["clm_z_new"]);
  assert.equal(source.latest_data_at_field, "published_at", "published_at wins when fields differ at the same instant");
  assert.deepEqual(result.evidence_ids, ["clm_z_new"]);
});

test("age_days is whole days relative to now", () => {
  const result = rank({
    records: [
      record("a", "p-24h", { published_at: "2026-11-04T12:00:00Z" }),
      record("b", "p-just-under", { published_at: "2026-11-04T12:00:01Z" }),
      record("c", "p-future", { published_at: "2026-11-06T12:00:00Z" }),
    ],
  });
  assert.equal(find(result, "p-24h").age_days, 1);
  assert.equal(find(result, "p-just-under").age_days, 0);
  assert.equal(find(result, "p-future").age_days, -1);
  assert.ok(warningCodes(result).includes("FUTURE_TIMESTAMP"));
});

test("timestamps with offsets compare by instant and are reported in UTC", () => {
  const result = rank({
    records: [
      record("a", "p-offset", { published_at: "2026-10-12T11:00:00+02:00" }),
      record("b", "p-utc", { published_at: "2026-10-12T08:59:59Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["p-offset", "p-utc"]);
  assert.equal(find(result, "p-offset").latest_data_at, "2026-10-12T09:00:00Z");
});

// --- Retrieval-time fallback -----------------------------------------------------------------

test("retrieval time is a flagged fallback used only when a source has no data timestamp", () => {
  const result = rank({
    records: [
      record("a", "p-dated", { published_at: "2026-08-01T00:00:00Z", retrieved_at: "2026-09-01T00:00:00Z" }),
      record("b", "p-retrieval-only", { retrieved_at: "2026-11-04T00:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["p-dated", "p-retrieval-only"]);
  const fallback = find(result, "p-retrieval-only");
  assert.equal(fallback.recency, "retrieval_fallback");
  assert.equal(fallback.latest_data_at_field, "retrieved_at");
  assert.equal(fallback.rank, 2);
  assert.equal(find(result, "p-dated").latest_data_at, "2026-08-01T00:00:00Z", "retrieved_at never overrides a data timestamp");
  assert.ok(warningCodes(result).includes("RETRIEVAL_TIME_FALLBACK"));
  assert.equal(result.data.summary_counts.retrieval_fallback, 1);
});

test("a record without a data timestamp inside a dated source does not use its retrieved_at", () => {
  const result = rank({
    records: [
      record("a", "p-mixed", { published_at: "2026-08-01T00:00:00Z" }),
      record("b", "p-mixed", { retrieved_at: "2026-11-04T00:00:00Z" }),
    ],
  });
  const source = find(result, "p-mixed");
  assert.equal(source.recency, "dated");
  assert.equal(source.latest_data_at, "2026-08-01T00:00:00Z");
  assert.ok(!warningCodes(result).includes("RETRIEVAL_TIME_FALLBACK"));
});

test("retrieval-fallback sources are ordered among themselves by retrieved_at descending", () => {
  const result = rank({
    records: [
      record("a", "p-r-old", { retrieved_at: "2026-10-01T00:00:00Z" }),
      record("b", "p-r-new", { retrieved_at: "2026-10-09T00:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["p-r-new", "p-r-old"]);
});

// --- Unknown recency and invalid timestamps --------------------------------------------------

test("sources without a usable timestamp are listed after dated ones, unranked, never dropped", () => {
  const result = rank({
    records: [
      record("u1", "p-unknown-b", { retrieved_at: "garbage" }),
      record("u2", "p-unknown-a", { retrieved_at: undefined }),
      record("d1", "p-dated", { published_at: "2020-01-01T00:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["p-dated", "p-unknown-a", "p-unknown-b"]);
  assert.deepEqual(result.data.sources.map((source) => source.rank), [1, null, null]);
  for (const source of result.data.sources.slice(1)) {
    assert.equal(source.recency, "unknown");
    assert.equal(source.latest_data_at, null);
    assert.equal(source.latest_data_at_field, null);
    assert.equal(source.age_days, null);
    assert.deepEqual(source.supporting_record_ids, []);
    assert.equal(source.record_count, 1);
  }
  assert.equal(result.status, "partial");
  assert.ok(warningCodes(result).includes("RECENCY_UNKNOWN"));
  assert.equal(result.data.summary_counts.recency_unknown, 2);
});

test("every unparseable timestamp form is treated as missing and reported, not rejected", () => {
  const invalidValues = [
    "yesterday",
    "",
    "2026-10-12",
    "2026-10-12T10:00:00",
    "2026-02-30T10:00:00Z",
    "2027-02-29T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-10-12T25:00:00Z",
    "2026-10-12T10:61:00Z",
    "2016-12-31T23:59:60Z",
    "12/10/2026",
    1760000000,
    true,
    {},
  ];
  for (const value of invalidValues) {
    const result = rank({ records: [record("a", "p-bad", { published_at: value, retrieved_at: value })] });
    const label = JSON.stringify(value);
    assert.equal(result.errors.length, 0, `${label} must not be rejected`);
    assert.equal(find(result, "p-bad").recency, "unknown", label);
    assert.equal(find(result, "p-bad").invalid_timestamp_count, 2, label);
    assert.equal(result.data.summary_counts.invalid_timestamps, 2, label);
    assert.equal(result.data.summary_counts.records_rejected, 0, label);
    assert.ok(warningCodes(result).includes("INVALID_TIMESTAMP_IGNORED"), label);
  }
});

test("null and absent timestamps are missing, not invalid", () => {
  const result = rank({
    records: [record("a", "p-null", { published_at: null, occurred_at: null, retrieved_at: null })],
  });
  assert.equal(find(result, "p-null").invalid_timestamp_count, 0);
  assert.ok(!warningCodes(result).includes("INVALID_TIMESTAMP_IGNORED"));
  assert.equal(find(result, "p-null").recency, "unknown");
});

// --- Ties ------------------------------------------------------------------------------------

test("ties break by source_id ascending, get distinct ranks, and are flagged on both sources", () => {
  const input = {
    records: [
      record("a", "zeta", { published_at: "2026-10-01T00:00:00Z" }),
      record("b", "alpha", { occurred_at: "2026-10-01T00:00:00Z" }),
      record("c", "mid", { published_at: "2026-10-01T00:00:00Z" }),
      record("d", "later", { published_at: "2026-10-02T00:00:00Z" }),
    ],
  };
  const result = rank(input);
  assert.deepEqual(ids(result), ["later", "alpha", "mid", "zeta"]);
  assert.deepEqual(result.data.sources.map((source) => source.rank), [1, 2, 3, 4]);
  assert.deepEqual(find(result, "later").tied_with, []);
  assert.deepEqual(find(result, "alpha").tied_with, ["mid", "zeta"]);
  assert.deepEqual(find(result, "mid").tied_with, ["alpha", "zeta"]);
  assert.deepEqual(find(result, "zeta").tied_with, ["alpha", "mid"]);
  assert.ok(warningCodes(result).includes("RECENCY_TIE"));

  const reversed = rank({ records: [...input.records].reverse() });
  assert.deepEqual(reversed.data, result.data, "tie order does not depend on input order");
});

test("a data-dated source and a retrieval-fallback source at the same instant are not tied", () => {
  const result = rank({
    records: [
      record("a", "p-data", { published_at: "2026-10-01T00:00:00Z" }),
      record("b", "p-fallback", { retrieved_at: "2026-10-01T00:00:00Z" }),
    ],
  });
  assert.deepEqual(find(result, "p-data").tied_with, []);
  assert.deepEqual(find(result, "p-fallback").tied_with, []);
  assert.ok(!warningCodes(result).includes("RECENCY_TIE"));
});

test("no tie is reported when every timestamp differs", () => {
  const result = rank({
    records: [
      record("a", "p1", { published_at: "2026-10-01T00:00:00Z" }),
      record("b", "p2", { published_at: "2026-10-01T00:00:01Z" }),
    ],
  });
  assert.ok(!warningCodes(result).includes("RECENCY_TIE"));
});

// --- Account scope ---------------------------------------------------------------------------

test("records for another account are excluded, counted in a warning, and never ranked", () => {
  const result = rank({
    records: [
      record("mine", "p-mine", { published_at: "2026-09-01T00:00:00Z" }),
      record("theirs", "p-theirs", { account_id: "acct_other_999", published_at: "2026-11-04T00:00:00Z" }),
      record("theirs2", "p-mine", { account_id: "acct_other_999", published_at: "2026-11-04T00:00:00Z" }),
    ],
    evidence: [evidence("theirs3", { account_id: "acct_other_999" })],
  });
  assert.deepEqual(ids(result), ["p-mine"]);
  assert.equal(find(result, "p-mine").latest_data_at, "2026-09-01T00:00:00Z");
  assert.equal(find(result, "p-mine").record_count, 1);
  assert.equal(result.data.summary_counts.records_excluded_foreign_account, 3);
  const warning = result.warnings.find((item) => item.code === "FOREIGN_ACCOUNT_RECORDS_EXCLUDED");
  assert.ok(warning);
  assert.match(warning.message, /^3 item/);
  assert.ok(!JSON.stringify(result).includes("acct_other_999"));
  assert.equal(result.status, "success", "foreign exclusion alone does not degrade the status");
});

test("a foreign-account item is excluded even when it is otherwise malformed", () => {
  const result = rank({
    records: [
      record("mine", "p-mine", { published_at: "2026-09-01T00:00:00Z" }),
      { record_id: "src_junk", account_id: "acct_other_999" },
    ],
  });
  assert.equal(result.data.summary_counts.records_excluded_foreign_account, 1);
  assert.equal(result.data.summary_counts.records_rejected, 0);
});

test("when no record belongs to the account the result is blocked with ACCOUNT_SCOPE_MISMATCH", () => {
  const result = rank({
    records: [record("theirs", "p-theirs", { account_id: "acct_other_999", published_at: NOW })],
  });
  assertEnvelope(result);
  assert.equal(result.status, "blocked");
  assert.equal(result.data, null);
  assert.deepEqual(result.errors.map((error) => error.code), ["ACCOUNT_SCOPE_MISMATCH"]);
  assert.deepEqual(warningCodes(result), ["FOREIGN_ACCOUNT_RECORDS_EXCLUDED"]);
  assert.deepEqual(result.evidence_ids, []);
});

test("empty arrays are blocked with EVIDENCE_REFERENCE_UNAVAILABLE, not a fabricated ranking", () => {
  for (const input of [{ records: [] }, { evidence: [] }, { records: [], evidence: [] }]) {
    const result = rank(input);
    assertEnvelope(result);
    assert.equal(result.status, "blocked");
    assert.equal(result.data, null);
    assert.deepEqual(result.errors.map((error) => error.code), ["EVIDENCE_REFERENCE_UNAVAILABLE"]);
  }
});

// --- Request validation ----------------------------------------------------------------------

test("invalid requests fail with INVALID_INPUT and no data", () => {
  const good = [record("a", "p", { published_at: NOW })];
  const cases = {
    "not an object": null,
    "array input": [],
    "missing account": { records: good },
    "empty account": { account_id: "", records: good },
    "account name": { account_id: "Northstar Logistics", records: good },
    "domain": { account_id: "northstar-logistics.example", records: good },
    "bad characters": { account_id: "acct/../x", records: good },
    "non-string account": { account_id: 42, records: good },
    "neither records nor evidence": { account_id: ACCOUNT },
    "records not an array": { account_id: ACCOUNT, records: "nope" },
    "evidence not an array": { account_id: ACCOUNT, evidence: {} },
    "unknown property": { account_id: ACCOUNT, records: good, extra: true },
    "unparseable now": { account_id: ACCOUNT, records: good, now: "yesterday" },
    "now without offset": { account_id: ACCOUNT, records: good, now: "2026-11-05T12:00:00" },
    "non-string now": { account_id: ACCOUNT, records: good, now: 5 },
  };
  for (const [label, input] of Object.entries(cases)) {
    const result = rankSources(input, { now: () => new Date(NOW) });
    assertEnvelope(result);
    assert.equal(result.status, "failed", label);
    assert.equal(result.data, null, label);
    assert.ok(result.errors.length > 0, label);
    assert.ok(result.errors.every((error) => error.code === "INVALID_INPUT" && error.retryable === false), label);
  }
});

test("malformed items are rejected individually with content-free diagnostics", () => {
  const result = rank({
    records: [
      record("ok", "p-ok", { published_at: "2026-09-01T00:00:00Z" }),
      record("nocontent", "p-bad", { content: undefined }),
      record("badtype", "p-bad", { source_type: "rumour" }),
      "not an object",
      record("extra", "p-bad", { surprise: "SECRET-CONTENT" }),
    ],
    evidence: [evidence("e1", { claim: undefined })],
  });
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(ids(result), ["p-ok"]);
  assert.equal(result.data.summary_counts.records_rejected, 5);
  assert.equal(result.errors.length, 5);
  assert.ok(result.errors.every((error) => error.code === "INVALID_INPUT"));
  assert.ok(warningCodes(result).includes("RECORDS_REJECTED"));
  assert.ok(!JSON.stringify(result).includes("SECRET-CONTENT"));
  assert.deepEqual(
    result.errors.map((error) => [error.details.array, error.details.index]),
    [["evidence", 0], ["records", 1], ["records", 2], ["records", 3], ["records", 4]].sort(),
  );
});

test("duplicate IDs reject every copy so the outcome does not depend on input order", () => {
  const first = record("dup", "p-dup", { published_at: "2026-09-01T00:00:00Z" });
  const second = record("dup", "p-dup", { published_at: "2026-10-01T00:00:00Z" });
  const other = record("solo", "p-dup", { published_at: "2026-08-01T00:00:00Z" });
  const forward = rank({ records: [first, second, other] });
  const backward = rank({ records: [other, second, first] });
  assert.deepEqual(forward.data, backward.data);
  assert.equal(forward.status, "partial");
  assert.equal(forward.data.summary_counts.records_rejected, 2);
  assert.equal(find(forward, "p-dup").latest_data_at, "2026-08-01T00:00:00Z");
  assert.ok(forward.errors.every((error) => error.details.reason === "duplicate_id" && error.details.id === "src_dup"));
});

test("when every item is malformed the result is blocked and lists the rejections", () => {
  const result = rank({ records: [record("bad", "p", { content: "" })] });
  assert.equal(result.status, "blocked");
  assert.equal(result.data, null);
  assert.deepEqual(result.errors.map((error) => error.code), ["INVALID_INPUT"]);
});

test("a record with only an invalid timestamp is still accepted (the shared schema is not applied to timestamps)", () => {
  const result = rank({ records: [record("a", "p", { retrieved_at: "bad" })] });
  assert.equal(result.data.summary_counts.records_accepted, 1);
  assert.equal(result.data.summary_counts.records_rejected, 0);
});

// --- Source identity -------------------------------------------------------------------------

test("sources are grouped by metadata.provider, not by the broad source_type", () => {
  const result = rank({
    records: [
      record("a", "provider-one", { published_at: "2026-10-01T00:00:00Z" }),
      record("b", "provider-two", { published_at: "2026-10-02T00:00:00Z" }),
      record("c", " provider-one ", { published_at: "2026-09-01T00:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["provider-two", "provider-one"]);
  assert.equal(find(result, "provider-one").record_count, 2, "provider is trimmed");
  assert.equal(find(result, "provider-one").source_id_basis, "metadata.provider");
  assert.deepEqual(find(result, "provider-one").source_types, ["third_party"]);
});

test("provider grouping is exact: case differences make different sources, with no normalisation", () => {
  const result = rank({
    records: [
      record("a", "Salesforce", { published_at: "2026-10-01T00:00:00Z" }),
      record("b", "salesforce", { published_at: "2026-10-02T00:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["salesforce", "Salesforce"]);
  assert.equal(result.data.summary_counts.sources, 2);
});

test("without a provider the source_type is the flagged fallback identifier", () => {
  const result = rank({
    records: [
      record("a", null, { source_type: "news", published_at: "2026-10-01T00:00:00Z" }),
      record("b", "", { source_type: "news", published_at: "2026-10-03T00:00:00Z" }),
      record("c", null, { source_type: "company_site", published_at: "2026-10-02T00:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(result), ["source_type:news", "source_type:company_site"]);
  assert.equal(find(result, "source_type:news").source_id_basis, "source_type");
  assert.equal(find(result, "source_type:news").record_count, 2);
  assert.ok(warningCodes(result).includes("SOURCE_ID_FALLBACK"));
});

test("evidence linked to a supplied record inherits that record's provider", () => {
  const result = rank({
    records: [record("r1", "provider-x", { published_at: "2026-10-01T00:00:00Z" })],
    evidence: [evidence("r1", { published_at: "2026-10-01T00:00:00Z" })],
  });
  assert.deepEqual(ids(result), ["provider-x"]);
  const source = find(result, "provider-x");
  assert.equal(source.record_count, 2);
  assert.deepEqual(source.supporting_record_ids, ["src_r1"]);
  assert.deepEqual(source.supporting_evidence_ids, ["clm_r1"]);
  assert.deepEqual(result.evidence_ids, ["clm_r1"]);
  assert.ok(!warningCodes(result).includes("SOURCE_ID_FALLBACK"));
});

const noLink = (id) => ({ source_record_id: undefined, source_uri: `https://example.test/${id}` });

test("evidence-only input without source_record_id is ranked by source_type and uses evidence timestamps", () => {
  const result = rank({
    records: undefined,
    evidence: [
      evidence("n1", { ...noLink("n1"), source_type: "news", published_at: "2026-10-05T00:00:00Z" }),
      evidence("c1", { ...noLink("c1"), source_type: "crm_activity", occurred_at: "2026-10-09T00:00:00Z" }),
      evidence("c2", { ...noLink("c2"), source_type: "crm_activity", occurred_at: "2026-10-01T00:00:00Z" }),
    ],
  });
  assert.ok(warningCodes(result).includes("SOURCE_ID_FALLBACK"));
  assert.ok(!warningCodes(result).includes("SOURCE_RECORD_LINK_UNRESOLVED"));
  assertEnvelope(result);
  assert.deepEqual(ids(result), ["source_type:crm_activity", "source_type:news"]);
  assert.deepEqual(find(result, "source_type:crm_activity").supporting_evidence_ids, ["clm_c1"]);
  assert.deepEqual(find(result, "source_type:crm_activity").supporting_record_ids, []);
  assert.deepEqual(result.evidence_ids, ["clm_c1", "clm_n1"]);
});

function assertUnresolvedLinkExcluded(result, { unresolved, status = "partial" }) {
  assertEnvelope(result);
  assert.equal(result.status, status);
  assert.ok(!ids(result).some((id) => id.startsWith("source_type:")), "never regrouped under source_type");
  assert.ok(!result.data.sources.some((source) => source.supporting_evidence_ids.length > 0));
  assert.deepEqual(result.evidence_ids, []);
  const warning = result.warnings.find((item) => item.code === "SOURCE_RECORD_LINK_UNRESOLVED");
  assert.ok(warning, "SOURCE_RECORD_LINK_UNRESOLVED warning present");
  assert.match(warning.message, new RegExp("^" + unresolved + " evidence item"));
  assert.ok(!JSON.stringify(result.warnings).includes("src_") && !JSON.stringify(result.warnings).includes("clm_"));
}

test("evidence whose source_record_id is absent from the request is excluded, counted and never outranks providers", () => {
  const result = rank({
    records: [record("r1", "provider-x", { published_at: "2026-09-01T00:00:00Z" })],
    evidence: [
      evidence("zzz", { source_record_id: "src_missing", source_type: "news", published_at: "2026-11-01T00:00:00Z" }),
    ],
  });
  assertUnresolvedLinkExcluded(result, { unresolved: 1 });
  assert.deepEqual(ids(result), ["provider-x"]);
  assert.equal(result.data.summary_counts.records_accepted, 1);
});

test("evidence linked to a record rejected as a duplicate is excluded, not regrouped", () => {
  const result = rank({
    records: [
      record("dup", "provider-x", { published_at: "2026-09-01T00:00:00Z" }),
      record("dup", "provider-x", { published_at: "2026-09-02T00:00:00Z" }),
      record("ok", "provider-y", { published_at: "2026-08-01T00:00:00Z" }),
    ],
    evidence: [evidence("dup", { published_at: "2026-11-01T00:00:00Z" })],
  });
  assertUnresolvedLinkExcluded(result, { unresolved: 1 });
  assert.deepEqual(ids(result), ["provider-y"]);
  assert.equal(result.data.summary_counts.records_rejected, 2);
});

test("evidence linked to a rejected (malformed) record is excluded", () => {
  const result = rank({
    records: [
      record("bad", "provider-x", { content: "" }),
      record("ok", "provider-y", { published_at: "2026-08-01T00:00:00Z" }),
    ],
    evidence: [evidence("bad", { published_at: "2026-11-01T00:00:00Z" })],
  });
  assertUnresolvedLinkExcluded(result, { unresolved: 1 });
  assert.deepEqual(ids(result), ["provider-y"]);
});

test("evidence linked to a foreign-account record is excluded and the status is at most partial", () => {
  const result = rank({
    records: [
      record("theirs", "provider-x", { account_id: "acct_other_999", published_at: "2026-11-04T00:00:00Z" }),
      record("ok", "provider-y", { published_at: "2026-08-01T00:00:00Z" }),
    ],
    evidence: [evidence("theirs", { published_at: "2026-11-04T00:00:00Z" })],
  });
  assertUnresolvedLinkExcluded(result, { unresolved: 1 });
  assert.deepEqual(ids(result), ["provider-y"]);
  assert.equal(result.data.summary_counts.records_excluded_foreign_account, 1);
  assert.ok(!JSON.stringify(result).includes("acct_other_999"));
});

test("when only unresolved-link evidence is supplied the result is blocked with the warning", () => {
  const result = rank({ evidence: [evidence("a", { source_record_id: "src_missing" })] });
  assertEnvelope(result);
  assert.equal(result.status, "blocked");
  assert.equal(result.data, null);
  assert.deepEqual(result.errors.map((error) => error.code), ["EVIDENCE_REFERENCE_UNAVAILABLE"]);
  assert.deepEqual(warningCodes(result), ["SOURCE_RECORD_LINK_UNRESOLVED"]);
});

test("unresolved-link evidence is counted per item and does not affect fully resolved evidence", () => {
  const result = rank({
    records: [record("r1", "provider-x", { published_at: "2026-09-01T00:00:00Z" })],
    evidence: [
      evidence("r1", { published_at: "2026-09-01T00:00:00Z" }),
      evidence("m1", { source_record_id: "src_missing" }),
      evidence("m2", { source_record_id: "src_missing_too" }),
    ],
  });
  assert.equal(result.status, "partial");
  assert.match(result.warnings.find((item) => item.code === "SOURCE_RECORD_LINK_UNRESOLVED").message, /^2 evidence item/);
  assert.deepEqual(find(result, "provider-x").supporting_evidence_ids, ["clm_r1"]);
});

test("record-only input leaves the envelope evidence_ids empty", () => {
  const result = rank({ records: [record("r1", "p", { published_at: "2026-10-01T00:00:00Z" })] });
  assert.deepEqual(result.evidence_ids, []);
});

// --- Determinism, purity and scope -----------------------------------------------------------

test("results are deterministic and independent of input order", () => {
  const input = fixtureInput();
  const first = rankSources(input);
  const second = rankSources(input);
  const shuffled = rankSources({
    ...input,
    records: [...input.records].reverse(),
    evidence: [...input.evidence].reverse(),
  });
  assert.deepEqual(second.data, first.data);
  assert.deepEqual(shuffled.data, first.data);
  assert.deepEqual(shuffled.warnings, first.warnings);
  assert.deepEqual(shuffled.evidence_ids, first.evidence_ids);
});

test("no clock is read when now is provided in the input or through deps", () => {
  const input = fixtureInput();
  const expected = rankSources(input).data;
  const viaInput = withoutClock(() => rankSources(input));
  assert.deepEqual(viaInput.data, expected);
  assert.equal(viaInput.started_at, "2026-11-05T12:00:00.000Z");
  assert.equal(viaInput.finished_at, viaInput.started_at);

  const { now: _now, ...withoutNow } = input;
  const fixedClock = new Date(NOW);
  const viaDeps = withoutClock(() => rankSources(withoutNow, { now: () => fixedClock }));
  assert.deepEqual(viaDeps.data, expected);

  const failed = withoutClock(() => rankSources({ account_id: "bad id", records: [], now: NOW }));
  assert.equal(failed.status, "failed");
});

test("input.now takes precedence over deps.now", () => {
  const result = rankSources(
    { account_id: ACCOUNT, records: [record("a", "p", { published_at: "2026-11-04T12:00:00Z" })], now: NOW },
    { now: () => new Date("2030-01-01T00:00:00Z") },
  );
  assert.equal(result.data.now, NOW);
  assert.equal(result.data.sources[0].age_days, 1);
});

test("without now the clock is read, and now is reported in the data", () => {
  const before = Date.now();
  const result = rankSources({ account_id: ACCOUNT, records: [record("a", "p", { published_at: "2020-01-01T00:00:00Z" })] });
  assertEnvelope(result);
  const reported = Date.parse(result.data.now);
  assert.ok(reported >= before - 1000 && reported <= Date.now() + 1000);
});

test("the input is not mutated", () => {
  const input = deepFreeze(fixtureInput());
  assert.doesNotThrow(() => rankSources(input));
});

test("output carries IDs, timestamps and counts only, never content, titles or URIs", () => {
  const input = fixtureInput();
  const serialized = JSON.stringify(rankSources(input));
  for (const item of input.records) {
    assert.ok(!serialized.includes(item.content), "content leaked");
    assert.ok(!serialized.includes(item.title), "title leaked");
    if (item.source_uri) assert.ok(!serialized.includes(item.source_uri), "uri leaked");
  }
  for (const item of input.evidence) {
    assert.ok(!serialized.includes(item.claim), "claim leaked");
    assert.ok(!serialized.includes(item.excerpt), "excerpt leaked");
  }
});

test("the result is recency-only: no reliability, authority or quality fields exist", () => {
  const result = rankSources(fixtureInput());
  assert.equal(result.data.ranking_basis, "data_recency_only");
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(result.data);
  for (const forbidden of ["score", "reliability", "authority", "quality", "trust", "confidence", "priority", "weight"]) {
    assert.ok(![...keys].some((key) => key.includes(forbidden)), `unexpected field containing "${forbidden}"`);
  }
});

test("a source's rank never depends on its record count", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    record(`many_${index}`, "p-many", { published_at: "2026-09-01T00:00:00Z" }),
  );
  const result = rank({
    records: [...many, record("one", "p-one", { published_at: "2026-10-01T00:00:00Z" })],
  });
  assert.deepEqual(ids(result), ["p-one", "p-many"]);
  assert.equal(find(result, "p-many").record_count, 20);
});

// --- Status ----------------------------------------------------------------------------------

test("status is success when every source is dated, even with warnings", () => {
  const result = rank({
    records: [
      record("a", "p1", { published_at: "2026-10-01T00:00:00Z" }),
      record("b", "p2", { retrieved_at: "2026-10-01T00:00:00Z" }),
      record("c", "p3", { published_at: "2026-10-01T00:00:00Z" }),
    ],
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length > 0);
});

test("status is partial when no source is dated at all", () => {
  const result = rank({ records: [record("a", "p1", { retrieved_at: "nope" })] });
  assert.equal(result.status, "partial");
  assert.equal(result.data.summary_counts.data_dated, 0);
  assert.deepEqual(ids(result), ["p1"]);
});

// --- Contracts and documentation -------------------------------------------------------------

test("source.rank schemas are registered with stable IDs and accept the fixture shapes", () => {
  for (const name of ["sourceRankInput", "sourceRankResult"]) {
    assert.ok(schemaDocuments[name], `${name} is registered`);
    assert.ok(schemaDocuments[name].$id, `${name} has a stable $id`);
  }
  const input = fixtureInput();
  const { valid, errors } = validate("sourceRankInput", input);
  assert.equal(valid, true, JSON.stringify(errors));
  assert.equal(validate("sourceRankInput", { account_id: ACCOUNT }).valid, false);
  assert.equal(validate("sourceRankResult", fixtureExpected().expected.data).valid, true);
  const tampered = structuredClone(fixtureExpected().expected.data);
  tampered.ranking_basis = "reliability";
  assert.equal(validate("sourceRankResult", tampered).valid, false);
});

test("skill.yaml matches the shared skill contract conventions", () => {
  const contract = YAML.parse(readText("../skills/source-rank/skill.yaml"));
  assert.equal(contract.skill, "source.rank");
  assert.match(contract.version, /^\d+\.\d+\.\d+$/);
  assert.equal(contract.status, "draft");
  assert.equal(typeof contract.intent, "string");
  assert.ok(Array.isArray(contract.procedure) && contract.procedure.length > 0);
  assert.ok(Array.isArray(contract.constraints) && contract.constraints.length > 0);
  assert.ok(Array.isArray(contract.gates) && contract.gates.length > 0);
  assert.ok(Array.isArray(contract.evals.suites) && contract.evals.suites.length > 0);
  assert.ok(contract.authorization, "authorization expectations are declared");
  assert.ok(contract.dependencies, "dependencies are declared");
  assert.deepEqual(contract.inputs.required, ["account_id"]);
  assert.deepEqual(contract.timestamp_precedence, ["published_at", "occurred_at", "retrieved_at"]);
});

test("SKILL.md is agent-agnostic and states the recency-only boundary and the timestamp precedence", () => {
  const md = readText("../skills/source-rank/SKILL.md");
  assert.match(md, /^# source\.rank/);
  for (const heading of ["When to use", "When not to use"]) {
    assert.ok(md.includes(heading), `has a "${heading}" section`);
  }
  assert.match(md, /^#{2,3} .*constraints/im, "has a constraints section");
  for (const host of ["Claude", "OpenAI", "GPT", "Copilot", "Gemini"]) {
    assert.ok(!new RegExp(host, "i").test(md), `must not mention ${host}`);
  }
  assert.match(md, /recency (ordering )?only/i);
  assert.match(md, /reliab/i);
  assert.match(md, /authorit/i);
  assert.match(md, /published_at.*occurred_at.*retrieved_at/s);
});

test("fixtures directory carries only synthetic account identifiers", () => {
  const serialized = JSON.stringify(fixtureInput());
  assert.ok(!/relevantz|salesforce|draup/i.test(serialized), "no real vendor or customer names");
});

// --- Timestamp helpers -----------------------------------------------------------------------

test("parseTimestamp accepts RFC 3339 forms and rejects everything else", () => {
  assert.equal(parseTimestamp("2026-11-05T12:00:00Z"), Date.UTC(2026, 10, 5, 12));
  assert.equal(parseTimestamp("2026-11-05t12:00:00z"), Date.UTC(2026, 10, 5, 12));
  assert.equal(parseTimestamp("2026-11-05T14:00:00+02:00"), Date.UTC(2026, 10, 5, 12));
  assert.equal(parseTimestamp("2026-11-05T07:00:00-05:00"), Date.UTC(2026, 10, 5, 12));
  assert.equal(parseTimestamp("2026-11-05T12:00:00.5Z"), Date.UTC(2026, 10, 5, 12, 0, 0, 500));
  assert.equal(parseTimestamp("2026-11-05T12:00:00.123456Z"), Date.UTC(2026, 10, 5, 12, 0, 0, 123));
  assert.equal(parseTimestamp("2028-02-29T00:00:00Z"), Date.UTC(2028, 1, 29));
  assert.equal(parseTimestamp("2027-02-29T00:00:00Z"), null);
  assert.equal(parseTimestamp("2026-04-31T00:00:00Z"), null);
  assert.equal(parseTimestamp("2026-11-05T12:00:00+24:00"), null);
  assert.equal(parseTimestamp("2016-12-31T23:59:60Z"), null, "leap second is invalid");
  assert.equal(parseTimestamp("0026-11-05T12:00:00Z"), null);
  for (const bad of [undefined, null, 0, "", "2026-11-05", "2026-11-05 12:00:00Z", "2026-11-05T12:00Z"]) {
    assert.equal(parseTimestamp(bad), null, String(bad));
  }
});

test("formatTimestamp and ageInDays are pure helpers", () => {
  assert.equal(formatTimestamp(Date.UTC(2026, 10, 5, 12)), "2026-11-05T12:00:00Z");
  assert.equal(formatTimestamp(Date.UTC(2026, 10, 5, 12, 0, 0, 250)), "2026-11-05T12:00:00.250Z");
  assert.equal(ageInDays(Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 5, 12)), 4);
  assert.equal(ageInDays(Date.UTC(2026, 10, 6), Date.UTC(2026, 10, 5)), -1);
});
