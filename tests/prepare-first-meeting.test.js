import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { validate } from "../schemas/index.js";
import { prepareFirstMeeting } from "../workflows/prepare-first-meeting/index.js";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";
import { resolveAccount } from "../skills/account-resolve/index.js";
import { retrieveEvidence } from "../skills/evidence-retrieve/index.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { detectGaps } from "../skills/gap-detect/index.js";
import { renderArtifact } from "../skills/artifact-render/index.js";

const FIXTURE_NAMES = [
  "workflow-first-meeting-success",
  "workflow-first-meeting-ambiguous",
  "workflow-first-meeting-fuzzy-confirmation",
  "workflow-first-meeting-missing-account",
  "workflow-first-meeting-sparse",
  "workflow-first-meeting-partial-source-failure",
  "workflow-first-meeting-normalization-rejection",
  "workflow-first-meeting-conflicted",
  "workflow-first-meeting-classification-filtered",
  "workflow-first-meeting-retrieval-failure",
  "workflow-first-meeting-renderer-failure",
];

function load(name) {
  const dir = new URL(`../fixtures/${name}/`, import.meta.url);
  return {
    name,
    input: JSON.parse(readFileSync(new URL("input.json", dir), "utf8")),
    expected: JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")).expected,
    accounts: JSON.parse(readFileSync(new URL("accounts.json", dir), "utf8")),
    sources: JSON.parse(readFileSync(new URL("sources.json", dir), "utf8")),
  };
}

const fixtures = FIXTURE_NAMES.map(load);

function depsFor(name, overrides = {}) {
  return {
    accountAdapter: createFixtureAccountAdapter({ fixture: name }),
    evidenceAdapter: createFixtureEvidenceAdapter({ fixture: name }),
    claimExtractor: createFixtureClaimExtractor(),
    ...overrides,
  };
}

async function runFixture(fixture, overrides = {}) {
  return prepareFirstMeeting(fixture.input, depsFor(fixture.name, overrides));
}

function citationsIn(markdown) {
  const ids = new Set();
  for (const match of markdown.matchAll(/`\[(clm_[A-Za-z0-9_-]+)\]`/g)) ids.add(match[1]);
  return [...ids].sort();
}

function assertWorkflowSchema(result) {
  const { valid, errors } = validate("workflowResult", result);
  assert.equal(valid, true, `workflow result invalid: ${JSON.stringify(errors)}`);
  assert.equal(result.workflow, "prepare-first-meeting");
  assert.match(result.workflow_version, /^\d+\.\d+\.\d+$/);
  assert.match(result.trace_id, /^trace_/);
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
}

const DIAGNOSTIC_KEYS = new Set(["step", "skill", "code", "message", "retryable"]);

function assertSafeDiagnostics(result) {
  for (const entry of [...result.warnings, ...result.errors]) {
    for (const key of Object.keys(entry)) {
      assert.ok(DIAGNOSTIC_KEYS.has(key), `unexpected diagnostic field ${key}`);
    }
    assert.equal(typeof entry.step, "string");
    assert.equal(typeof entry.skill, "string");
    assert.equal(typeof entry.code, "string");
    assert.equal(typeof entry.message, "string");
    assert.ok(entry.message.length > 0);
    assert.equal(entry.details, undefined);
  }
}

for (const fixture of fixtures) {
  test(`${fixture.name}: matches the end-to-end fixture expectation`, async () => {
    const result = await runFixture(fixture);
    assertWorkflowSchema(result);
    assertSafeDiagnostics(result);

    const expected = fixture.expected;
    assert.equal(result.status, expected.status, "workflow status");
    assert.deepEqual(
      result.steps.map((step) => step.step),
      expected.executed_steps,
      "executed step order",
    );

    for (const [step, status] of Object.entries(expected.step_statuses ?? {})) {
      assert.equal(result.steps.find((entry) => entry.step === step)?.status, status, step);
    }

    if (Object.hasOwn(expected, "account")) {
      assert.equal(result.account, expected.account);
    }
    if (expected.account_id) {
      assert.equal(result.account?.account_id, expected.account_id);
      assert.equal(result.account?.canonical_name, expected.account_name);
    }
    if (expected.candidate_account_ids) {
      assert.deepEqual(
        result.account_candidates.map((candidate) => candidate.account_id).sort(),
        [...expected.candidate_account_ids].sort(),
      );
    }

    assert.deepEqual(result.evidence_ids, expected.evidence_ids ?? []);
    assert.deepEqual(result.omitted_evidence_ids, expected.omitted_evidence_ids ?? []);

    for (const code of expected.warning_codes_include ?? []) {
      assert.ok(
        result.warnings.some((warning) => warning.code === code),
        `missing warning ${code}`,
      );
    }
    assert.deepEqual(
      [...new Set(result.errors.map((error) => error.code))].sort(),
      [...new Set(expected.error_codes ?? [])].sort(),
    );

    if (Object.hasOwn(expected, "artifact") && expected.artifact === null) {
      assert.equal(result.artifact, null);
    } else {
      assert.equal(result.artifact?.format, "markdown");
      for (const text of expected.artifact_contains ?? []) {
        assert.ok(result.artifact.markdown.includes(text), `artifact missing ${text}`);
      }
      for (const text of expected.artifact_not_contains ?? []) {
        assert.ok(!result.artifact.markdown.includes(text), `artifact contains ${text}`);
      }
    }
  });
}

test("default question-set loading uses the draft first-meeting reference set", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const result = await runFixture(fixture);
  const reference = YAML.parse(
    readFileSync(new URL("../reference/first-meeting-questions.yaml", import.meta.url), "utf8"),
  );
  const referenceCount = reference.categories.flatMap((category) => category.questions).length;
  const gapStep = result.steps.find((step) => step.step === "gap.detect");
  assert.equal(gapStep.total_questions, referenceCount);
  assert.ok(result.artifact.markdown.includes("**FM-CTX-001**") || result.artifact.markdown.includes("| Account ID |"));
});

test("input validation rejects a missing account reference before any skill runs", async () => {
  let called = 0;
  const result = await prepareFirstMeeting(
    {},
    {
      accountAdapter: createFixtureAccountAdapter({ accounts: [] }),
      evidenceAdapter: createFixtureEvidenceAdapter({ sources: { sources: {} } }),
      claimExtractor: createFixtureClaimExtractor(),
      resolveAccount: async (...args) => {
        called += 1;
        return resolveAccount(...args);
      },
    },
  );
  assertWorkflowSchema(result);
  assert.equal(result.status, "failed");
  assert.equal(result.steps.length, 0);
  assert.equal(called, 0);
  assert.equal(result.errors[0].step, "workflow.input");
  assert.equal(result.errors[0].code, "INVALID_INPUT");
});

test("the input schema accepts the documented question alias and rejects an empty question list", () => {
  assert.equal(validate("workflowInput", {
    account_reference: "Northstar Logistics",
    questions: [{ id: "FM-CTX-001", question: "What does the company do?" }],
  }).valid, true);
  assert.equal(validate("workflowInput", {
    account_reference: "Northstar Logistics", questions: [],
  }).valid, false);
});

test("input validation rejects unknown fields, audiences, ceilings, and malformed questions", async () => {
  const base = fixtures.find((item) => item.name === "workflow-first-meeting-success").input;
  const cases = [
    [{ ...base, unexpected: true }, "unknown field"],
    [{ ...base, audience: "public" }, "unknown audience"],
    [{ ...base, classification_ceiling: "secret" }, "unknown ceiling"],
    [{ ...base, questions: [] }, "empty questions"],
    [{ ...base, questions: [{ id: "FM-CTX-001", text: "" }] }, "empty question text"],
    [
      { ...base, questions: [{ id: "FM-CTX-001", text: "One" }, { id: "FM-CTX-001", text: "Two" }] },
      "duplicate questions",
    ],
    [{ ...base, context: { ...base.context, extra: true } }, "unknown context field"],
  ];

  for (const [input, label] of cases) {
    const result = await prepareFirstMeeting(input, depsFor("workflow-first-meeting-success"));
    assertWorkflowSchema(result);
    assert.equal(result.status, "failed", label);
    assert.equal(result.steps.length, 0, label);
    assert.equal(result.errors[0].step, "workflow.input", label);
    assert.equal(result.artifact, null, label);
  }
});

test("unknown requested source fails before retrieval", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  let retrieveCalls = 0;
  const result = await prepareFirstMeeting(
    { ...fixture.input, requested_sources: ["crm", "web_crawl"] },
    depsFor(fixture.name, {
      retrieveEvidence: async (...args) => {
        retrieveCalls += 1;
        return retrieveEvidence(...args);
      },
    }),
  );
  assertWorkflowSchema(result);
  assert.equal(result.status, "failed");
  assert.equal(retrieveCalls, 0);
  assert.equal(result.errors[0].code, "UNSUPPORTED_SOURCE");
});

test("unknown template fails at the renderer after safe completed-step summaries", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-renderer-failure");
  const result = await runFixture(fixture);
  assertWorkflowSchema(result);
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.steps.at(-1).step, "artifact.render");
  assert.equal(result.steps.at(-1).status, "failed");
  assert.equal(result.steps.length, 5);
  assert.equal(result.errors[0].code, "INVALID_INPUT");
  assert.equal(result.errors[0].step, "artifact.render");
  assert.ok(!JSON.stringify(result).includes("rendered_artifact"));
});

test("retrieval is not called after an ambiguous account", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-ambiguous");
  let retrieveCalls = 0;
  const result = await runFixture(fixture, {
    retrieveEvidence: async () => {
      retrieveCalls += 1;
      throw new Error("should not run");
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(retrieveCalls, 0);
  assert.deepEqual(result.steps.map((step) => step.step), ["account.resolve"]);
});

test("retrieval is not called after a confirmation_required account", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "workflow-first-meeting-fuzzy-confirmation",
  );
  let retrieveCalls = 0;
  const result = await runFixture(fixture, {
    retrieveEvidence: async () => {
      retrieveCalls += 1;
      throw new Error("should not run");
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(retrieveCalls, 0);
  assert.equal(result.account_candidates[0].account_id, "sf_wf_fuzzy_001");
  assert.ok(!JSON.stringify(result.account_candidates).includes("owner"));
});

test("normalization is not called after fatal retrieval failure", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "workflow-first-meeting-retrieval-failure",
  );
  let normalizeCalls = 0;
  const result = await runFixture(fixture, {
    normalizeEvidence: async () => {
      normalizeCalls += 1;
      throw new Error("should not run");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(normalizeCalls, 0);
  assert.deepEqual(result.steps.map((step) => step.step), [
    "account.resolve",
    "evidence.retrieve",
  ]);
});

test("gap detection is not called after normalization failure", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  let gapCalls = 0;
  const result = await runFixture(fixture, {
    claimExtractor: undefined,
    detectGaps: async () => {
      gapCalls += 1;
      throw new Error("should not run");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(gapCalls, 0);
  assert.equal(result.steps.find((step) => step.step === "evidence.normalize")?.status, "failed");
  assert.ok(!result.steps.some((step) => step.step === "gap.detect"));
});

test("renderer is not called after gap-detection failure", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  let renderCalls = 0;
  const failedGapResult = {
    skill: "gap.detect",
    status: "failed",
    data: null,
    evidence_ids: [],
    warnings: [],
    errors: [
      { code: "INVALID_INPUT", message: "Simulated gap failure.", retryable: false },
    ],
  };
  const result = await runFixture(fixture, {
    detectGaps: async () => failedGapResult,
    renderArtifact: async () => {
      renderCalls += 1;
      throw new Error("should not run");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(renderCalls, 0);
  assert.ok(!result.steps.some((step) => step.step === "artifact.render"));
});

test("all intermediate skill outputs validate against their existing schemas", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const checks = [];
  const wrap = (name, validateResult) => async (input, deps) => {
    const result = await (name === "account.resolve"
      ? resolveAccount(input, deps)
      : name === "evidence.retrieve"
        ? retrieveEvidence(input, deps)
        : name === "evidence.normalize"
          ? normalizeEvidence(input, deps)
          : name === "gap.detect"
            ? detectGaps(input, deps)
            : renderArtifact(input, deps));
    const schemaResult = validate("skillResult", result);
    assert.equal(schemaResult.valid, true, `${name}: ${JSON.stringify(schemaResult.errors)}`);
    validateResult(input, result);
    checks.push(name);
    return result;
  };

  const result = await runFixture(fixture, {
    resolveAccount: wrap("account.resolve", () => {}),
    retrieveEvidence: wrap("evidence.retrieve", (input, skillResult) => {
      for (const record of skillResult.data.records) {
        assert.equal(validate("sourceRecord", record).valid, true, "source record schema");
      }
    }),
    normalizeEvidence: wrap("evidence.normalize", (input, skillResult) => {
      for (const claim of skillResult.data.claims) {
        assert.equal(validate("evidence", claim).valid, true, "evidence schema");
      }
    }),
    detectGaps: wrap("gap.detect", (input, skillResult) => {
      assert.equal(validate("gapResult", skillResult.data).valid, true, "gap result schema");
    }),
    renderArtifact: wrap("artifact.render", (input) => {
      assert.equal(
        validate("firstMeetingBriefInput", input).valid,
        true,
        "renderer input schema",
      );
    }),
  });

  assertWorkflowSchema(result);
  assert.deepEqual(checks, [
    "account.resolve",
    "evidence.retrieve",
    "evidence.normalize",
    "gap.detect",
    "artifact.render",
  ]);
});

test("artifact citations exactly match final evidence IDs", async () => {
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    if (!result.artifact) {
      assert.deepEqual(result.evidence_ids, [], fixture.name);
      continue;
    }
    assert.deepEqual(
      citationsIn(result.artifact.markdown),
      [...result.evidence_ids].sort(),
      fixture.name,
    );
  }
});

test("final omitted IDs match the renderer's classification omissions", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "workflow-first-meeting-classification-filtered",
  );
  let rendererOmitted;
  const result = await runFixture(fixture, {
    renderArtifact: async (input, deps) => {
      const rendered = await renderArtifact(input, deps);
      rendererOmitted = rendered.data?.omitted_evidence_ids;
      return rendered;
    },
  });
  assertWorkflowSchema(result);
  assert.deepEqual(result.omitted_evidence_ids, [...rendererOmitted].sort());
  assert.deepEqual(result.omitted_evidence_ids, fixture.expected.omitted_evidence_ids);
});

test("classification filtering is leak-free in the artifact, diagnostics, and summaries", async () => {
  const fixture = fixtures.find(
    (item) => item.name === "workflow-first-meeting-classification-filtered",
  );
  const result = await runFixture(fixture);
  const serializedDiagnostics = JSON.stringify({
    warnings: result.warnings,
    errors: result.errors,
    steps: result.steps,
  });
  const internalClaim = "Juniper Ridge Energy requested a root-cause review of grid outages.";
  const confidentialClaim =
    "Juniper Ridge Energy is evaluating a confidential acquisition of Harborline Marine.";

  for (const forbidden of [
    internalClaim,
    confidentialClaim,
    "src_wf_class_internal",
    "src_wf_class_confidential",
    fixture.expected.omitted_evidence_ids[0],
    fixture.expected.omitted_evidence_ids[1],
  ]) {
    assert.ok(!serializedDiagnostics.includes(forbidden), `diagnostics leaked ${forbidden}`);
    assert.ok(!result.artifact.markdown.includes(forbidden), `artifact leaked ${forbidden}`);
  }
  assert.ok(result.artifact.markdown.includes("Evidence is unavailable at the current classification level."));
});

test("adapter, extractor and input diagnostic messages cannot leak raw text or record IDs", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const secret = "private claim text and record identifier src_secret_123";
  const adapterResult = await runFixture(fixture, {
    evidenceAdapter: {
      name: "test adapter",
      supportedSources: ["crm", "public_source"],
      async retrieve() { throw new Error(secret); },
    },
  });
  assert.equal(adapterResult.status, "failed");
  assert.ok(!JSON.stringify(adapterResult).includes(secret));

  const extractorResult = await runFixture(fixture, {
    claimExtractor: { async extract() { throw new Error(secret); } },
  });
  assert.equal(extractorResult.status, "partial");
  assert.ok(!JSON.stringify({ warnings: extractorResult.warnings, errors: extractorResult.errors, steps: extractorResult.steps }).includes(secret));

  const inputResult = await prepareFirstMeeting({ account_reference: "Northstar", [secret]: true });
  assert.equal(inputResult.status, "failed");
  assert.ok(!JSON.stringify(inputResult).includes(secret));
});

test("diagnostics are deduplicated and deterministically ordered", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const duplicate = {
    code: "NO_RECORDS_RETRIEVED",
    message: "No source records were retrieved from the requested sources. This does not mean the information does not exist.",
  };
  const retrieveWithDuplicates = async (input) => ({
    skill: "evidence.retrieve",
    skill_version: "0.2.0",
    status: "success",
    data: {
      account_id: input.account_id,
      requested_sources: input.requested_sources,
      question_ids: input.questions.map((question) => question.id),
      records: [],
      source_results: [],
      record_count: 0,
    },
    evidence_ids: [],
    warnings: [duplicate, duplicate],
    errors: [],
    trace_id: "trace_injected",
    started_at: "2026-10-20T14:00:00Z",
    finished_at: "2026-10-20T14:00:01Z",
  });

  const first = await runFixture(fixture, { retrieveEvidence: retrieveWithDuplicates });
  const second = await runFixture(fixture, { retrieveEvidence: retrieveWithDuplicates });
  assert.equal(
    first.warnings.filter((warning) => warning.code === "NO_RECORDS_RETRIEVED").length,
    1,
  );
  assert.deepEqual(first.warnings, second.warnings);
  assert.deepEqual(first.errors, second.errors);
});

test("step and warning ordering are deterministic across repeated runs", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const first = await runFixture(fixture);
  const second = await runFixture(fixture);

  assert.deepEqual(first.steps, second.steps);
  assert.deepEqual(first.warnings, second.warnings);
  assert.deepEqual(first.errors, second.errors);
  assert.equal(first.artifact.markdown, second.artifact.markdown);
  assert.deepEqual(first.evidence_ids, second.evidence_ids);
});

test("deterministic repeat accepts an injected trace ID while business output is stable", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const first = await runFixture(fixture, { traceId: "trace_workflow_fixed" });
  const second = await runFixture(fixture, { traceId: "trace_workflow_fixed" });
  assert.equal(first.trace_id, "trace_workflow_fixed");
  assert.equal(second.trace_id, "trace_workflow_fixed");

  const stripVolatile = (result) => {
    const copy = JSON.parse(JSON.stringify(result));
    delete copy.started_at;
    delete copy.finished_at;
    return copy;
  };
  assert.deepEqual(stripVolatile(first), stripVolatile(second));
});

test("a tampered renderer result is rejected by workflow provenance verification", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const result = await runFixture(fixture, {
    renderArtifact: async (input, deps) => {
      const rendered = await renderArtifact(input, deps);
      return {
        ...rendered,
        data: {
          ...rendered.data,
          rendered_artifact: rendered.data.rendered_artifact.replace(
            /`\[clm_[A-Za-z0-9_-]+\]`/,
            "`[clm_not_in_normalized_claims]`",
          ),
        },
      };
    },
  });
  assertWorkflowSchema(result);
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.deepEqual(result.evidence_ids, []);
  assert.deepEqual(result.omitted_evidence_ids, []);
  assert.equal(result.errors[0].code, "PROVENANCE_INVARIANT_FAILED");
});

test("renderer classification metadata must match the requested ceiling", async () => {
  const fixture = fixtures.find((item) => item.name === "workflow-first-meeting-success");
  const result = await runFixture(fixture, {
    renderArtifact: async (input, deps) => {
      const rendered = await renderArtifact(input, deps);
      return { ...rendered, data: { ...rendered.data, classification: "public" } };
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.errors.at(-1).code, "PROVENANCE_INVARIANT_FAILED");
});

test("every workflow fixture result validates against the workflow-result schema", async () => {
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    assertWorkflowSchema(result);
  }
});
