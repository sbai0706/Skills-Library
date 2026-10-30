import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../schemas/index.js";
import { renderArtifact } from "../skills/artifact-render/index.js";
import { TEMPLATES } from "../skills/artifact-render/templates.js";

const FIXTURE_NAMES = [
  "brief-complete",
  "brief-sparse",
  "brief-partial-answer",
  "brief-conflicted",
  "brief-public-ceiling-with-internal-evidence",
  "brief-public-ceiling-with-confidential-evidence",
  "brief-internal-ceiling-with-confidential",
  "brief-internal-ceiling-with-public-and-internal",
  "brief-confidential-input-and-confidential-ceiling",
  "brief-empty-evidence",
  "brief-unknown-template",
];

const readJson = (relative) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

const fixtures = FIXTURE_NAMES.map((name) => ({
  name,
  input: readJson(`../fixtures/${name}/input.json`),
  expected: readJson(`../fixtures/${name}/expected.json`),
}));

const CLASSIFICATION_RANK = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
});

function assertEnvelope(result) {
  const { valid, errors } = validate("skillResult", result);
  assert.equal(valid, true, `envelope invalid: ${JSON.stringify(errors)}`);
  assert.equal(result.skill, "artifact.render");
  assert.match(result.trace_id, /^trace_/);
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
}

function claimBullets(markdown) {
  return markdown.split("\n").filter((line) => line.startsWith("- "));
}

function renderedCitations(markdown) {
  const ids = new Set();
  for (const match of markdown.matchAll(/`\[(clm_[A-Za-z0-9_-]+)\]`/g)) {
    ids.add(match[1]);
  }
  return [...ids].sort();
}

function expectedOmittedIds(input) {
  const ceiling = CLASSIFICATION_RANK[input.classification_ceiling];
  if (ceiling === undefined || !Array.isArray(input.claims)) return [];
  return [
    ...new Set(
      input.claims
        .filter((claim) => CLASSIFICATION_RANK[claim.access_classification] > ceiling)
        .map((claim) => claim.claim_id),
    ),
  ].sort();
}

async function resultFor(fixture) {
  return renderArtifact(fixture.input);
}

test("the only MVP template is registered and unknown templates are not", () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ["first-meeting-brief-v1"]);
});

test("every fixture gap_result validates against the frozen gap-result schema", () => {
  for (const fixture of fixtures) {
    const { valid, errors } = validate("gapResult", fixture.input.gap_result);
    assert.equal(valid, true, `${fixture.name}: ${JSON.stringify(errors)}`);
  }
});

test("canonical fixtures validate structurally regardless of claim classification", () => {
  for (const fixture of fixtures) {
    const { valid, errors } = validate("firstMeetingBriefInput", fixture.input);
    assert.equal(valid, true, `${fixture.name}: ${JSON.stringify(errors)}`);
    assert.equal(fixture.expected.schema_valid_input, true, fixture.name);
  }
});

test("complete brief renders every answered question with citations", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-complete");
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, fixture.expected.expected.status);
  assert.deepEqual(result.data.cited_evidence_ids, fixture.expected.expected.cited_evidence_ids);
  assert.deepEqual(result.data.omitted_evidence_ids, fixture.expected.expected.omitted_evidence_ids);
  assert.match(result.data.rendered_artifact, /^# First-meeting brief — Northstar Logistics/m);
  for (const expected of fixture.expected.expected.contains) {
    assert.ok(result.data.rendered_artifact.includes(expected), `missing ${expected}`);
  }
  for (const forbidden of fixture.expected.expected.not_contains) {
    assert.ok(!result.data.rendered_artifact.includes(forbidden), `unexpected ${forbidden}`);
  }
});

test("every factual bullet contains an evidence ID", async () => {
  for (const fixture of fixtures) {
    if (fixture.name === "brief-unknown-template") continue;
    const result = await resultFor(fixture);
    const bullets = claimBullets(result.data.rendered_artifact);
    for (const bullet of bullets) {
      assert.match(
        bullet,
        /`\[clm_[A-Za-z0-9_-]+\]`/,
        `${fixture.name}: uncited factual bullet: ${bullet}`,
      );
    }
  }
});

test("sparse brief displays unanswered questions openly", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-sparse");
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.match(result.data.rendered_artifact, /No permitted evidence was retrieved for this question\./);
  for (const id of ["FM-DEV-001", "FM-REL-001", "FM-STK-001", "FM-SVC-001"]) {
    assert.ok(result.data.rendered_artifact.includes(`**${id}**`), `${id} is displayed`);
  }
  assert.ok(result.data.warnings.some((warning) => warning.code === "gaps_present"));
});

test("an unanswered question is never converted into a negative factual claim", async () => {
  const forbidden = [
    /The customer has no initiative/i,
    /There are no stakeholders/i,
    /No budget exists/i,
    /does not exist/i,
  ];
  for (const name of ["brief-sparse", "brief-empty-evidence"]) {
    const fixture = fixtures.find((item) => item.name === name);
    const result = await resultFor(fixture);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(result.data.rendered_artifact), `${name}: ${pattern}`);
    }
  }
});

test("a partially answered question is labeled partial, not answered or denied", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-partial-answer");
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.ok(
    result.data.rendered_artifact.includes("Available evidence addresses part of this question."),
  );
  assert.ok(result.data.rendered_artifact.includes("**FM-DEV-001**"));
  assert.ok(!result.data.rendered_artifact.includes("The customer has no initiative."));
});

test("conflicts are retained with both statements and no winner", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-conflicted");
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  const artifact = result.data.rendered_artifact;
  assert.match(artifact, /Conflicting evidence requires human review\./);
  assert.ok(artifact.includes("clm_conf_a_0001"));
  assert.ok(artifact.includes("clm_conf_b_0002"));
  assert.ok(artifact.includes("2027"));
  assert.ok(artifact.includes("2028"));
  for (const forbidden of ["winner", "more likely", "was resolved", "The correct date is"]) {
    assert.ok(!artifact.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
  }
});

test("public ceiling excludes an internal claim from structurally valid input", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-public-ceiling-with-internal-evidence",
  );
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.cited_evidence_ids, ["clm_pub_ctx_0001"]);
  assert.deepEqual(result.data.omitted_evidence_ids, ["clm_int_rel_0002"]);
  assert.equal(result.data.classification, "public");
  const artifact = result.data.rendered_artifact;
  assert.ok(!artifact.includes("Aurora Grid requested a root-cause review"));
  assert.ok(!artifact.includes("clm_int_rel_0002"));
});

test("public ceiling excludes a confidential claim from structurally valid input", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-public-ceiling-with-confidential-evidence",
  );
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.cited_evidence_ids, ["clm_pubconf_ctx_0001"]);
  assert.deepEqual(result.data.omitted_evidence_ids, ["clm_pubconf_stk_0002"]);
  const artifact = result.data.rendered_artifact;
  assert.ok(!artifact.includes("Morgan Lee is recorded"));
  assert.ok(!artifact.includes("src_conf_stk_9302"));
  assert.ok(!artifact.includes("clm_pubconf_stk_0002"));
});

test("internal ceiling excludes confidential claims", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-internal-ceiling-with-confidential",
  );
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.cited_evidence_ids, ["clm_intceil_pub_0001"]);
  assert.deepEqual(result.data.omitted_evidence_ids, ["clm_intceil_conf_0002"]);
  const artifact = result.data.rendered_artifact;
  assert.ok(!artifact.includes("Jordan Ellis is recorded"));
  assert.ok(!artifact.includes("src_conf_stk_9102"));
  assert.ok(!artifact.includes("clm_intceil_conf_0002"));
});

test("internal ceiling renders both public and internal claims", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-internal-ceiling-with-public-and-internal",
  );
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.cited_evidence_ids, [
    "clm_intmix_pub_0001",
    "clm_intmix_rel_0002",
  ]);
  assert.deepEqual(result.data.omitted_evidence_ids, []);
  const artifact = result.data.rendered_artifact;
  assert.ok(artifact.includes("Lumen Harbor operates container terminals"));
  assert.ok(artifact.includes("Lumen Harbor requested a terminal throughput review"));
  assert.ok(artifact.includes("clm_intmix_rel_0002"));
});

test("confidential input renders under a confidential ceiling", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-confidential-input-and-confidential-ceiling",
  );
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.cited_evidence_ids, fixture.expected.expected.cited_evidence_ids);
  assert.deepEqual(result.data.omitted_evidence_ids, []);
  assert.ok(
    result.data.rendered_artifact.includes(
      "Priya Raman is recorded as Director of Operations at Northstar Logistics.",
    ),
  );
});

test("omitted content does not leak through warnings or references", async () => {
  for (const name of [
    "brief-public-ceiling-with-internal-evidence",
    "brief-public-ceiling-with-confidential-evidence",
    "brief-internal-ceiling-with-confidential",
  ]) {
    const fixture = fixtures.find((item) => item.name === name);
    const result = await resultFor(fixture);
    const omittedIds = new Set(expectedOmittedIds(fixture.input));
    const omittedClaims = fixture.input.claims.filter((claim) => omittedIds.has(claim.claim_id));

    const warningText =
      JSON.stringify(result.warnings) +
      JSON.stringify(result.data.warnings) +
      JSON.stringify(result.errors);
    for (const claim of omittedClaims) {
      const forbidden = [
        claim.claim,
        claim.excerpt,
        claim.source_uri,
        claim.source_record_id,
        claim.claim_id,
      ].filter((value) => typeof value === "string" && value.length > 0);

      for (const value of forbidden) {
        assert.ok(!warningText.includes(value), `${name}: warning leaked ${value}`);
        assert.ok(
          !result.data.rendered_artifact.includes(value),
          `${name}: artifact leaked ${value}`,
        );
      }
    }
  }
});

test("gap status is safely unavailable after classification filtering", async () => {
  const cases = [
    { name: "brief-public-ceiling-with-internal-evidence", unavailable: "FM-REL-001" },
    { name: "brief-public-ceiling-with-confidential-evidence", unavailable: "FM-STK-001" },
  ];
  for (const item of cases) {
    const fixture = fixtures.find((entry) => entry.name === item.name);
    const result = await resultFor(fixture);
    const artifact = result.data.rendered_artifact;
    assert.ok(artifact.includes(`**${item.unavailable}**`), item.name);
    assert.ok(
      artifact.includes("Evidence is unavailable at the current classification level."),
      item.name,
    );
    assert.ok(!artifact.includes("No permitted evidence was retrieved for this question."), item.name);
  }
});

test("an answered question with some withheld support is displayed as partial", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-public-ceiling-with-internal-evidence",
  );
  const input = JSON.parse(JSON.stringify(fixture.input));
  input.gap_result.questions[1].supporting_evidence_ids.unshift("clm_pub_ctx_0001");
  assert.equal(validate("firstMeetingBriefInput", input).valid, true);

  const result = await renderArtifact(input);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.cited_evidence_ids, ["clm_pub_ctx_0001"]);
  assert.deepEqual(result.evidence_ids, result.data.cited_evidence_ids);
  assert.deepEqual(result.data.omitted_evidence_ids, ["clm_int_rel_0002"]);
  assert.match(
    result.data.rendered_artifact,
    /\*\*FM-REL-001\*\*[^\n]*\n\nAvailable evidence addresses part of this question\./,
  );
  assert.ok(!result.data.rendered_artifact.includes(input.claims[1].claim));
});

test("withheld support for a partial question is unavailable rather than a negative fact", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-partial-answer");
  const input = JSON.parse(JSON.stringify(fixture.input));
  input.claims[0].access_classification = "confidential";
  assert.equal(validate("firstMeetingBriefInput", input).valid, true);

  const result = await renderArtifact(input);
  assertEnvelope(result);
  assert.deepEqual(result.data.cited_evidence_ids, []);
  assert.deepEqual(result.data.omitted_evidence_ids, [input.claims[0].claim_id]);
  assert.match(
    result.data.rendered_artifact,
    /\*\*FM-DEV-001\*\*[^\n]*\n\nEvidence is unavailable at the current classification level\./,
  );
  assert.ok(!result.data.rendered_artifact.includes(input.claims[0].claim));
});

test("withheld conflicting claims do not leak through conflicts or diagnostics", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-conflicted");
  const input = JSON.parse(JSON.stringify(fixture.input));
  input.claims[0].access_classification = "internal";
  input.claims[1].access_classification = "confidential";
  assert.equal(validate("firstMeetingBriefInput", input).valid, true);

  const result = await renderArtifact(input);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.cited_evidence_ids, ["clm_conf_ctx_0003"]);
  assert.deepEqual(result.evidence_ids, result.data.cited_evidence_ids);
  assert.deepEqual(result.data.omitted_evidence_ids, ["clm_conf_a_0001", "clm_conf_b_0002"]);
  assert.ok(result.data.rendered_artifact.includes(
    "Supporting statements are not available at the current classification level.",
  ));
  const diagnostics = JSON.stringify(result.warnings) + JSON.stringify(result.errors);
  for (const claim of input.claims.slice(0, 2)) {
    for (const value of [claim.claim_id, claim.claim, claim.excerpt, claim.source_uri]) {
      assert.ok(!result.data.rendered_artifact.includes(value), `artifact leaked ${value}`);
      assert.ok(!diagnostics.includes(value), `diagnostics leaked ${value}`);
    }
  }
});

test("unknown template fails structurally without using a default", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-unknown-template");
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "INVALID_INPUT");
  assert.equal(result.errors[0].details.template_id, "first-meeting-brief-v2");
  assert.ok(!JSON.stringify(result).includes("rendered_artifact"));
});

test("empty evidence produces a valid gap-oriented brief", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-empty-evidence");
  const result = await resultFor(fixture);
  assertEnvelope(result);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.cited_evidence_ids, []);
  assert.deepEqual(result.data.omitted_evidence_ids, []);
  assert.deepEqual(claimBullets(result.data.rendered_artifact), []);
  assert.ok(result.data.rendered_artifact.includes("No evidence was cited."));
  for (const id of ["FM-CTX-001", "FM-DEV-001", "FM-REL-001", "FM-STK-001", "FM-SVC-001"]) {
    assert.ok(result.data.rendered_artifact.includes(`**${id}**`), `${id} is displayed`);
  }
});

test("identical input produces identical Markdown, including reordered claims and questions", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-complete");
  const first = await resultFor(fixture);
  const second = await resultFor(fixture);

  assert.equal(first.data.rendered_artifact, second.data.rendered_artifact);
  assert.deepEqual(first.data.cited_evidence_ids, second.data.cited_evidence_ids);

  const reordered = {
    ...fixture.input,
    claims: [...fixture.input.claims].reverse(),
    gap_result: {
      ...fixture.input.gap_result,
      questions: [...fixture.input.gap_result.questions].reverse(),
    },
  };
  const third = await renderArtifact(reordered);
  assert.equal(third.data.rendered_artifact, first.data.rendered_artifact);
});

test("cited_evidence_ids exactly matches rendered citations", async () => {
  for (const fixture of fixtures) {
    if (fixture.name === "brief-unknown-template") continue;
    const result = await resultFor(fixture);
    assert.deepEqual(
      result.data.cited_evidence_ids,
      renderedCitations(result.data.rendered_artifact),
      fixture.name,
    );
    assert.deepEqual(result.evidence_ids, result.data.cited_evidence_ids, fixture.name);
  }
});

test("omitted_evidence_ids exactly matches classification-filtered claims", async () => {
  for (const fixture of fixtures) {
    const result = await resultFor(fixture);
    assert.deepEqual(
      result.data?.omitted_evidence_ids ?? [],
      expectedOmittedIds(fixture.input),
      fixture.name,
    );
  }
});

test("every fixture result validates against the shared skill-result schema", async () => {
  for (const fixture of fixtures) {
    const result = await resultFor(fixture);
    const { valid, errors } = validate("skillResult", result);
    assert.equal(valid, true, `${fixture.name}: ${JSON.stringify(errors)}`);
  }
});

test("raw source records and arbitrary raw-record fields are rejected", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-complete");
  const rawClaim = {
    record_id: "src_raw_1",
    account_id: "sf_clear_001",
    source_type: "news",
    title: "Raw record",
    content: "Unprocessed source content.",
    source_uri: "https://news.example/raw",
    occurred_at: null,
    retrieved_at: "2026-10-20T14:30:00Z",
    access_classification: "public",
    question_ids: ["FM-CTX-001"],
    metadata: {},
  };
  const withRawClaim = { ...fixture.input, claims: [rawClaim] };
  const rawClaimResult = await renderArtifact(withRawClaim);
  assertEnvelope(rawClaimResult);
  assert.equal(rawClaimResult.status, "failed");
  assert.equal(rawClaimResult.errors[0].code, "INVALID_INPUT");

  const withRawRecords = { ...fixture.input, raw_records: [rawClaim] };
  const rawRecordsResult = await renderArtifact(withRawRecords);
  assertEnvelope(rawRecordsResult);
  assert.equal(rawRecordsResult.status, "failed");
  assert.equal(rawRecordsResult.errors[0].code, "INVALID_INPUT");
});

test("malformed claims still fail structural validation, including above the ceiling", async () => {
  const fixture = fixtures.find((item) => item.name === "brief-complete");
  const clone = () => JSON.parse(JSON.stringify(fixture.input));

  const unknownProperty = clone();
  unknownProperty.claims[0].unexpected_field = "not allowed";
  unknownProperty.claims[0].access_classification = "confidential";
  unknownProperty.classification_ceiling = "public";
  assert.equal(validate("firstMeetingBriefInput", unknownProperty).valid, false);
  const unknownResult = await renderArtifact(unknownProperty);
  assert.equal(unknownResult.status, "failed");
  assert.equal(unknownResult.errors[0].code, "INVALID_INPUT");

  const missingField = clone();
  delete missingField.claims[0].claim_id;
  assert.equal(validate("firstMeetingBriefInput", missingField).valid, false);
  const missingResult = await renderArtifact(missingField);
  assert.equal(missingResult.status, "failed");
  assert.equal(missingResult.errors[0].code, "INVALID_INPUT");
});

test("warning ordering is deterministic and aggregate-only", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "brief-public-ceiling-with-internal-evidence",
  );
  const first = await resultFor(fixture);
  const second = await resultFor(fixture);
  assert.deepEqual(
    first.data.warnings.map((warning) => warning.code),
    second.data.warnings.map((warning) => warning.code),
  );
  assert.deepEqual(
    first.data.warnings.map((warning) => warning.code),
    ["gaps_present", "claims_withheld"],
  );
  assert.ok(
    first.data.warnings.every((warning) => warning.message === "Some research questions remain unresolved." ||
      warning.message === "Some claims were withheld by the classification ceiling."),
  );
});
