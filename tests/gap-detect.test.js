import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../schemas/index.js";
import { detectGaps } from "../skills/gap-detect/index.js";

const FIXTURES = [
  "gap-all-answered",
  "gap-all-unanswered",
  "gap-partially-answered",
  "gap-conflicted-question",
  "gap-mixed-coverage",
  "gap-foreign-account-claim",
  "gap-unknown-question-reference",
  "gap-empty-claims",
];

function loadFixture(name) {
  const dir = new URL("../fixtures/" + name + "/", import.meta.url);
  return {
    name,
    input: JSON.parse(readFileSync(new URL("input.json", dir), "utf8")),
    expected: JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")).expected,
  };
}

const fixtures = FIXTURES.map(loadFixture);

function claim(overrides = {}) {
  return {
    claim_id: "clm_test_001",
    claim: "Fictional account sells logistics software.",
    source_type: "company_site",
    source_record_id: "src_test_001",
    account_id: "sf_test_001",
    retrieved_at: "2026-10-20T14:00:00Z",
    excerpt: "Fictional account sells logistics software.",
    confidence: "high",
    verification_status: "direct",
    access_classification: "public",
    question_ids: ["FM-CTX-001"],
    ...overrides,
  };
}

function assertEnvelope(result) {
  const { valid, errors } = validate("skillResult", result);
  assert.equal(valid, true, "envelope invalid: " + JSON.stringify(errors));
  assert.match(result.trace_id, /^trace_/);
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
}

function assertGapResult(result) {
  const { valid, errors } = validate("gapResult", result.data);
  assert.equal(valid, true, "gap result invalid: " + JSON.stringify(errors));
  assertEnvelope(result);
}

function inputClaimIds(fixture) {
  return new Set(fixture.input.claims.map((claim) => claim.claim_id));
}

function assertOutputEvidenceIdsExist(result, fixture) {
  const known = inputClaimIds(fixture);
  for (const question of result.data.questions) {
    for (const id of question.supporting_evidence_ids) {
      assert.ok(known.has(id), "unknown supporting evidence ID " + id);
    }
  }
  for (const id of result.evidence_ids) {
    assert.ok(known.has(id), "unknown envelope evidence ID " + id);
  }
}

test("all eight gap fixtures are present", () => {
  assert.equal(fixtures.length, 8);
});

for (const fixture of fixtures) {
  test(fixture.name + ": matches expected statuses and evidence IDs", () => {
    const result = detectGaps(fixture.input);
    assertGapResult(result);
    const expected = fixture.expected;

    assert.equal(result.status, expected.status, "status");
    assert.equal(result.data.account_id, fixture.input.account_id);
    assert.equal(result.data.question_set_version, expected.question_set_version);
    assert.deepEqual(result.data.questions, expected.questions);
    assert.deepEqual(result.data.summary_counts, expected.summary_counts);
    assert.deepEqual(result.evidence_ids, expected.evidence_ids);
    assert.deepEqual(
      result.errors.map((error) => error.details?.reason).sort(),
      [...expected.error_reasons].sort(),
    );
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      expected.warning_codes,
    );
    assertOutputEvidenceIdsExist(result, fixture);

    for (const forbidden of expected.forbidden_output_ids ?? []) {
      assert.ok(
        !result.evidence_ids.includes(forbidden),
        "rejected evidence ID leaked into envelope: " + forbidden,
      );
      for (const question of result.data.questions) {
        assert.ok(
          !question.supporting_evidence_ids.includes(forbidden),
          "rejected evidence ID leaked into a question: " + forbidden,
        );
      }
    }
  });
}

test("all questions answered produces only answered statuses", () => {
  const fixture = fixtures.find((item) => item.name === "gap-all-answered");
  const result = detectGaps(fixture.input);
  assert.ok(result.data.questions.every((question) => question.status === "answered"));
  assert.deepEqual(result.warnings, []);
});

test("no claims is a valid all-unanswered result", () => {
  const fixture = fixtures.find((item) => item.name === "gap-empty-claims");
  const result = detectGaps(fixture.input);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.questions[0].supporting_evidence_ids, []);
  assert.deepEqual(result.evidence_ids, []);
});

test("one unanswered question is reported without claiming the fact is false", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }, { id: "FM-DEV-001" }],
    claims: [claim({ question_ids: ["FM-CTX-001"] })],
    conflicts: [],
  });
  assertGapResult(result);
  const unanswered = result.data.questions.find((q) => q.question_id === "FM-DEV-001");
  assert.equal(unanswered.status, "unanswered");
  assert.equal(unanswered.reason_codes[0], "no_supporting_claims");
  assert.match(unanswered.missing_evidence_description, /No supporting claims/);
  assert.ok(!JSON.stringify(result).includes("does not exist"));
});

test("mixed answered and unanswered questions keep independent coverage", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }, { id: "FM-DEV-001" }],
    claims: [claim({ claim_id: "clm_mix_1", question_ids: ["FM-CTX-001"] })],
    conflicts: [],
  });
  assertGapResult(result);
  assert.deepEqual(
    result.data.questions.map((question) => [question.question_id, question.status]),
    [
      ["FM-CTX-001", "answered"],
      ["FM-DEV-001", "unanswered"],
    ],
  );
  assert.deepEqual(result.data.summary_counts, {
    total: 2,
    answered: 1,
    partial: 0,
    unanswered: 1,
    conflicted: 0,
  });
});

test("partial coverage requires every explicitly declared aspect", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [
      {
        id: "FM-SVC-001",
        required_aspects: [
          { id: "initiative", source_types: ["news"] },
          { id: "alignment", claim_ids: ["clm_aspect_2"] },
        ],
      },
    ],
    claims: [
      claim({ claim_id: "clm_aspect_1", source_type: "news", question_ids: ["FM-SVC-001"] }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  assert.equal(result.data.questions[0].status, "partial");
  assert.deepEqual(result.data.questions[0].supporting_evidence_ids, ["clm_aspect_1"]);
  assert.deepEqual(result.data.questions[0].reason_codes, ["partial_support"]);
});

test("partial coverage becomes answered when all declared aspects are supported", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [
      {
        id: "FM-SVC-001",
        required_aspects: [
          { id: "initiative", source_types: ["news"] },
          { id: "alignment", claim_ids: ["clm_aspect_2"] },
        ],
      },
    ],
    claims: [
      claim({ claim_id: "clm_aspect_1", source_type: "news", question_ids: ["FM-SVC-001"] }),
      claim({ claim_id: "clm_aspect_2", source_type: "crm_activity", question_ids: ["FM-SVC-001"] }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  assert.equal(result.data.questions[0].status, "answered");
});

test("conflicted evidence is retained for both sides without a winner", () => {
  const fixture = fixtures.find((item) => item.name === "gap-conflicted-question");
  const result = detectGaps(fixture.input);
  const conflicted = result.data.questions.find((q) => q.question_id === "FM-DEV-001");
  assert.equal(conflicted.status, "conflicted");
  assert.deepEqual(conflicted.supporting_evidence_ids, ["clm_gap_c1", "clm_gap_c2"]);
  assert.deepEqual(conflicted.conflict_ids, ["cfl_gap_conflict1"]);
  assert.deepEqual(conflicted.reason_codes, ["conflicting_claims"]);
});

test("a conflict is linked only to the question its claims support", () => {
  const fixture = fixtures.find((item) => item.name === "gap-conflicted-question");
  const result = detectGaps(fixture.input);
  const unrelated = result.data.questions.find((q) => q.question_id === "FM-CTX-001");
  assert.equal(unrelated.status, "unanswered");
  assert.equal(unrelated.conflict_ids, undefined);
});

test("a claim marked conflicting without a conflict reference is still surfaced", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-DEV-001" }],
    claims: [
      claim({
        claim_id: "clm_solo_conflict",
        verification_status: "conflicting",
        question_ids: ["FM-DEV-001"],
      }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  assert.equal(result.data.questions[0].status, "conflicted");
  assert.match(result.data.questions[0].conflict_ids[0], /^cfl_/);
  assert.ok(result.warnings.some((warning) => warning.code === "CONFLICTS_DERIVED"));
});

test("foreign-account claims are rejected and excluded from output", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }],
    claims: [claim({ claim_id: "clm_foreign_1", account_id: "sf_test_other" })],
    conflicts: [],
  });
  assertGapResult(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.questions[0].status, "unanswered");
  assert.deepEqual(result.evidence_ids, []);
  assert.equal(result.errors[0].details.reason, "foreign_account");
});

test("unknown question IDs are rejected instead of silently accepted", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }],
    claims: [
      claim({ claim_id: "clm_unknown_q", question_ids: ["FM-NOPE-999"] }),
      claim({ claim_id: "clm_known_q", question_ids: ["FM-CTX-001"] }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  assert.equal(result.status, "partial");
  assert.equal(result.errors[0].details.reason, "unknown_question_reference");
  assert.deepEqual(result.evidence_ids, ["clm_known_q"]);
});

test("duplicate evidence IDs are rejected, keeping the first accepted claim", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }],
    claims: [
      claim({ claim_id: "clm_duplicate", claim: "First fictional claim." }),
      claim({ claim_id: "clm_duplicate", claim: "Second fictional claim." }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  assert.equal(result.status, "partial");
  assert.equal(result.errors[0].details.reason, "duplicate_claim_id");
  assert.deepEqual(result.evidence_ids, ["clm_duplicate"]);
});

test("a nonexistent evidence ID in a conflict cannot appear in output", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }],
    claims: [claim({ claim_id: "clm_existing" })],
    conflicts: [{ conflict_id: "cfl_missing_ref", claim_ids: ["clm_missing"] }],
  });
  assertGapResult(result);
  assert.equal(result.status, "partial");
  assert.equal(result.data.questions[0].status, "answered");
  assert.deepEqual(result.data.questions[0].supporting_evidence_ids, ["clm_existing"]);
  assert.ok(!JSON.stringify(result.data).includes("clm_missing"));
  assert.ok(!JSON.stringify(result.data).includes("cfl_missing_ref"));
  assert.equal(result.errors[0].details.reason, "unknown_claim_reference");
});

test("question ordering follows the supplied question set deterministically", () => {
  const input = {
    account_id: "sf_test_001",
    questions: [{ id: "FM-STK-001" }, { id: "FM-CTX-001" }, { id: "FM-DEV-001" }],
    claims: [],
    conflicts: [],
  };
  const first = detectGaps(input);
  const second = detectGaps(input);
  assert.deepEqual(
    first.data.questions.map((question) => question.question_id),
    ["FM-STK-001", "FM-CTX-001", "FM-DEV-001"],
  );
  assert.deepEqual(first.data.questions, second.data.questions);
});

test("evidence IDs are ordered deterministically inside questions", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }],
    claims: [
      claim({ claim_id: "clm_zeta", source_record_id: "src_z" }),
      claim({ claim_id: "clm_alpha", source_record_id: "src_a" }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  assert.deepEqual(result.data.questions[0].supporting_evidence_ids, ["clm_alpha", "clm_zeta"]);
  assert.deepEqual(result.evidence_ids, ["clm_alpha", "clm_zeta"]);
});

test("confidential claim content never leaks through diagnostics", () => {
  const secret = "Confidential merger plan for Project Secret Lantern.";
  const result = detectGaps({
    account_id: "sf_test_001",
    questions: [{ id: "FM-CTX-001" }],
    claims: [
      claim({
        claim_id: "clm_secret",
        account_id: "sf_test_other",
        access_classification: "confidential",
        claim: secret,
        excerpt: secret,
      }),
    ],
    conflicts: [],
  });
  assertGapResult(result);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("Secret Lantern"));
});

test("default reference questions are used when the question set is omitted", () => {
  const result = detectGaps({
    account_id: "sf_test_001",
    claims: [],
  });
  assertGapResult(result);
  assert.equal(result.data.question_set_version, "0.1.0");
  assert.ok(result.data.questions.length > 0);
  assert.ok(result.data.questions.every((question) => question.status === "unanswered"));
});

test("request-level input errors fail with no data", () => {
  const cases = [
    [{ claims: [] }, "missing account_id"],
    [{ account_id: "Northstar Logistics", claims: [] }, "account name"],
    [{ account_id: "sf_test_001" }, "missing claims"],
    [{ account_id: "sf_test_001", claims: [], conflicts: {} }, "conflicts not array"],
    [{ account_id: "sf_test_001", claims: [], questions: "bad" }, "questions not array"],
  ];
  for (const [input, label] of cases) {
    const result = detectGaps(input);
    assertEnvelope(result);
    assert.equal(result.status, "failed", label);
    assert.equal(result.data, null, label);
    assert.ok(result.errors.length > 0, label);
  }
});
