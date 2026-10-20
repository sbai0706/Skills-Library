import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../schemas/index.js";

const validSkillResult = {
  skill: "account.resolve",
  skill_version: "0.1.0",
  status: "success",
  data: { outcome: "resolved" },
  evidence_ids: [],
  warnings: [],
  errors: [],
  trace_id: "trace_01234567-89ab-cdef-0123-456789abcdef",
  started_at: "2026-10-19T14:00:00.000Z",
  finished_at: "2026-10-19T14:00:01.000Z",
};

const validError = {
  code: "ACCOUNT_NOT_FOUND",
  message: "No credible account matched the reference.",
  retryable: false,
  details: { candidates_seen: 0 },
  occurred_at: "2026-10-19T14:00:00.000Z",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectInvalid(name, value, hint) {
  const { valid, errors } = validate(name, value);
  assert.equal(valid, false, `expected invalid (${hint})`);
  assert.ok(errors.length > 0);
  return errors;
}

test("valid skill result envelope passes the shared schema", () => {
  const { valid, errors } = validate("skillResult", validSkillResult);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("skill result may carry errors only when not successful", () => {
  const failed = clone(validSkillResult);
  failed.status = "failed";
  failed.data = null;
  failed.errors = [validError];
  assert.equal(validate("skillResult", failed).valid, true);

  const successWithError = clone(validSkillResult);
  successWithError.errors = [validError];
  expectInvalid("skillResult", successWithError, "success status with errors");

  const failedWithoutError = clone(validSkillResult);
  failedWithoutError.status = "failed";
  expectInvalid("skillResult", failedWithoutError, "failed status without errors");
});

test("skill result rejects unknown top-level fields", () => {
  const extra = clone(validSkillResult);
  extra.model_confidence = 0.9;
  expectInvalid("skillResult", extra, "unknown field");
});

test("skill result rejects an invalid status", () => {
  const bad = clone(validSkillResult);
  bad.status = "completed";
  expectInvalid("skillResult", bad, "status enum");
});

test("skill result rejects a missing required field", () => {
  for (const field of ["skill", "skill_version", "trace_id", "started_at", "finished_at"]) {
    const bad = clone(validSkillResult);
    delete bad[field];
    expectInvalid("skillResult", bad, `missing ${field}`);
  }
});

test("skill result rejects malformed identifiers and timestamps", () => {
  const badSkill = clone(validSkillResult);
  badSkill.skill = "account_resolve";
  expectInvalid("skillResult", badSkill, "skill naming");

  const badTrace = clone(validSkillResult);
  badTrace.trace_id = "1234";
  expectInvalid("skillResult", badTrace, "trace id prefix");

  const badTime = clone(validSkillResult);
  badTime.started_at = "2026-10-19 14:00";
  expectInvalid("skillResult", badTime, "date-time format");

  const badEvidence = clone(validSkillResult);
  badEvidence.evidence_ids = ["evidence-1"];
  expectInvalid("skillResult", badEvidence, "evidence id prefix");
});

test("evidence example validates", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/evidence.example.json", import.meta.url), "utf8"),
  );
  const { valid, errors } = validate("evidence", example);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("evidence record without a source fails", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/evidence.example.json", import.meta.url), "utf8"),
  );
  const noSource = clone(example);
  noSource.source_uri = null;
  noSource.source_record_id = null;
  expectInvalid("evidence", noSource, "no resolvable source");
});

test("evidence record missing a required field fails", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/evidence.example.json", import.meta.url), "utf8"),
  );
  for (const field of ["claim_id", "claim", "source_type", "account_id", "confidence", "verification_status", "access_classification"]) {
    const bad = clone(example);
    delete bad[field];
    const errors = expectInvalid("evidence", bad, `missing ${field}`);
    assert.ok(errors.some((e) => e.message.includes("required")), `missing ${field} reported`);
  }
});

test("evidence record rejects invalid enumerations", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/evidence.example.json", import.meta.url), "utf8"),
  );
  const badConfidence = clone(example);
  badConfidence.confidence = "certain";
  expectInvalid("evidence", badConfidence, "confidence enum");

  const badAccess = clone(example);
  badAccess.access_classification = "secret";
  expectInvalid("evidence", badAccess, "access classification enum");
});

test("raw source record example validates", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/source-record.example.json", import.meta.url), "utf8"),
  );
  const { valid, errors } = validate("sourceRecord", example);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("raw source record missing a required field fails", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/source-record.example.json", import.meta.url), "utf8"),
  );
  for (const field of ["record_id", "account_id", "source_type", "content", "retrieved_at", "access_classification"]) {
    const bad = clone(example);
    delete bad[field];
    expectInvalid("sourceRecord", bad, `missing ${field}`);
  }
});

test("raw source record rejects claim-level fields", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/source-record.example.json", import.meta.url), "utf8"),
  );
  for (const field of ["claim", "confidence", "verification_status"]) {
    const bad = clone(example);
    bad[field] = "x";
    expectInvalid("sourceRecord", bad, `claim field ${field}`);
  }
});

test("raw source record rejects an invalid source type and field-shaped metadata", () => {
  const example = JSON.parse(
    readFileSync(new URL("../schemas/source-record.example.json", import.meta.url), "utf8"),
  );
  const badType = clone(example);
  badType.source_type = "email";
  expectInvalid("sourceRecord", badType, "source type enum");

  const nestedMetadata = clone(example);
  nestedMetadata.metadata = { nested: { a: 1 } };
  expectInvalid("sourceRecord", nestedMetadata, "flat metadata only");
});

test("valid structured error passes the shared schema", () => {
  const { valid, errors } = validate("error", validError);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("structured error requires code, message, and retryable", () => {
  for (const field of ["code", "message", "retryable"]) {
    const bad = clone(validError);
    delete bad[field];
    expectInvalid("error", bad, `missing ${field}`);
  }
  const unknownCode = clone(validError);
  unknownCode.code = "SOMETHING_BROKE";
  expectInvalid("error", unknownCode, "unknown error code");
});