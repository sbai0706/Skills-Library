import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../schemas/index.js";

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const gapExample = readJson("../schemas/gap-result.example.json");
const briefExample = readJson("../schemas/first-meeting-brief-input.example.json");
const evidenceExample = readJson("../schemas/evidence.example.json");

function expectInvalid(name, value, reason) {
  const result = validate(name, value);
  assert.equal(result.valid, false, reason);
  assert.ok(result.errors.length > 0, reason);
}

test("gap-result example validates", () => {
  const result = validate("gapResult", gapExample);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(gapExample.summary_counts, { total: 4, answered: 1, partial: 1, unanswered: 1, conflicted: 1 });
});

test("gap result rejects generated prose and claim text fields", () => {
  const prose = clone(gapExample);
  prose.generated_conclusion = "The account is ready to buy.";
  expectInvalid("gapResult", prose, "generated prose is outside the gap contract");
  const copiedClaim = clone(gapExample);
  copiedClaim.questions[0].claim_text = "Confidential claim text";
  expectInvalid("gapResult", copiedClaim, "question items cannot carry claim text");
});

test("gap result requires safe missing descriptions for partial and unanswered questions", () => {
  const partial = clone(gapExample);
  delete partial.questions[1].missing_evidence_description;
  expectInvalid("gapResult", partial, "partial question requires a description");
  const unanswered = clone(gapExample);
  delete unanswered.questions[2].missing_evidence_description;
  expectInvalid("gapResult", unanswered, "unanswered question requires a description");
});

test("gap result requires conflict indicator and safe conflict reason", () => {
  const conflict = clone(gapExample);
  delete conflict.questions[3].conflict_ids;
  expectInvalid("gapResult", conflict, "conflicted question must reference conflicts");
  const reason = clone(gapExample);
  reason.questions[0].reason_codes = ["confidential_claim_text_here"];
  expectInvalid("gapResult", reason, "reason codes are an enum");
});

test("first-meeting brief input example validates", () => {
  const result = validate("firstMeetingBriefInput", briefExample);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("brief input warning text is a safe fixed message", () => {
  const unsafe = clone(briefExample);
  unsafe.warnings[0].message = "Confidential claim: the account plans to acquire Acme.";
  expectInvalid("firstMeetingBriefInput", unsafe, "warnings cannot copy claim text");
});

test("brief input rejects arbitrary raw source records", () => {
  const raw = clone(briefExample);
  raw.raw_records = [{ content: "unprocessed source text" }];
  expectInvalid("firstMeetingBriefInput", raw, "renderer input must be structured claims and gaps");
});

test("brief input enforces classification ceiling for claims", () => {
  const internal = clone(briefExample);
  internal.claims[0].access_classification = "internal";
  expectInvalid("firstMeetingBriefInput", internal, "public ceiling rejects internal claim");
  const confidential = clone(briefExample);
  confidential.classification_ceiling = "internal";
  confidential.claims[0].access_classification = "confidential";
  expectInvalid("firstMeetingBriefInput", confidential, "internal ceiling rejects confidential claim");
});

test("evidence schema accepts occurrence-only, publication-only, and both timestamps", () => {
  const olderEvidence = clone(evidenceExample);
  delete olderEvidence.occurred_at;
  delete olderEvidence.published_at;
  assert.equal(validate("evidence", olderEvidence).valid, true, "backward-compatible evidence remains valid");
  const occurrenceOnly = { ...olderEvidence, occurred_at: "2026-09-28T09:00:00Z" };
  assert.equal(validate("evidence", occurrenceOnly).valid, true);
  const publicationOnly = { ...olderEvidence, published_at: "2026-10-01T10:00:00Z" };
  assert.equal(validate("evidence", publicationOnly).valid, true);
  const both = { ...occurrenceOnly, published_at: "2026-10-01T10:00:00Z" };
  assert.equal(validate("evidence", both).valid, true);
});

test("source-record schema accepts both distinct timestamps", () => {
  const source = readJson("../schemas/source-record.example.json");
  source.published_at = "2026-10-01T10:00:00Z";
  source.occurred_at = "2026-09-28T09:00:00Z";
  const result = validate("sourceRecord", source);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});