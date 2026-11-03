import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { assessQualification } from "../skills/qualification-assess/index.js";
import { validate } from "../schemas/index.js";
import { runQualification } from "../workflows/qualification/index.js";

const NOW = () => new Date("2026-10-25T00:00:00.000Z");
const ACCOUNT_ID = "account_fixture";
const CLAIM_ID = "clm_fixture_event_1";
const CLAIM_TEXT = "The customer discussed an illustrative project.";
const SECRET_ID = "clm_hidden_qualification_991";
const SECRET_TEXT = "CONFIDENTIAL QUALIFICATION EVENT MUST NOT LEAK";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function claim(overrides = {}) {
  return {
    claim_id: CLAIM_ID,
    claim: CLAIM_TEXT,
    source_type: "crm_record",
    source_uri: "https://example.test/account",
    account_id: ACCOUNT_ID,
    retrieved_at: "2026-10-20T14:30:00.000Z",
    excerpt: CLAIM_TEXT,
    confidence: "high",
    verification_status: "direct",
    access_classification: "internal",
    ...overrides,
  };
}

function criteriaSet(evidenceIds = [CLAIM_ID]) {
  return {
    version: "1.2.0",
    approval_status: "provisional",
    criteria: [{
      id: "criterion_example",
      label: "Illustrative criterion",
      definition: "A fixture-only example, not an approved business rule.",
      evidence_ids: evidenceIds,
    }],
  };
}

function directInput(overrides = {}) {
  return {
    account_id: ACCOUNT_ID,
    claims: [claim()],
    classification_ceiling: "internal",
    ...overrides,
  };
}

function makeDeps(fixture = "workflow-first-meeting-success", overrides = {}) {
  return {
    accountAdapter: createFixtureAccountAdapter({ fixture }),
    evidenceAdapter: createFixtureEvidenceAdapter({ fixture }),
    claimExtractor: createFixtureClaimExtractor(),
    now: NOW,
    traceId: "trace_qualification_test",
    ...overrides,
  };
}

function workflowInput(overrides = {}) {
  return {
    workflow_input: {
      account_reference: "Northstar Logistics",
      requested_sources: ["crm", "public_source"],
      classification_ceiling: "internal",
    },
    ...overrides,
  };
}

function workflowFixtureClaimId() {
  return "clm_e5754f979c134d33";
}

test("no supplied criteria stays unresolved and all six event fields stay explicit", () => {
  const result = assessQualification(directInput(), { now: NOW });
  assert.equal(result.status, "partial");
  assert.equal(result.data.criteria_set.status, "unprovided");
  assert.deepEqual(result.data.criteria_set.assessments, []);
  assert.equal(result.data.qualification_decision, "not_determined");
  assert.equal(result.data.event_assessment.status, "unverified");
  assert.deepEqual(Object.keys(result.data.event_assessment.fields), [
    "event",
    "deadline",
    "consequence",
    "accountable_owner",
    "relevantz_service_need",
    "next_customer_decision",
  ]);
  assert.ok(Object.values(result.data.event_assessment.fields)
    .every((field) => field.evidence_state === "missing" && field.evidence.length === 0));
  assert.equal(result.data.stage_readiness.status, "unavailable");
  assert.ok(result.data.discovery_questions.length >= 8);
  assert.equal(validate("skillResult", result).valid, true);
  assert.equal(validate("qualificationAssessment", result.data).valid, true);
});

test("provisional criteria and six linked fields show evidence references, never pass or verification", () => {
  const fieldMappings = Object.fromEntries([
    "event",
    "deadline",
    "consequence",
    "accountable_owner",
    "relevantz_service_need",
    "next_customer_decision",
  ].map((field) => [field, [CLAIM_ID]]));
  const result = assessQualification(directInput({
    criteria_set: criteriaSet(),
    event_evidence: fieldMappings,
  }), { now: NOW });

  assert.equal(result.status, "success");
  assert.equal(result.data.criteria_set.status, "provisional");
  assert.equal(result.data.criteria_set.version, "1.2.0");
  assert.equal(result.data.criteria_set.assessments[0].evidence_state, "evidence_linked");
  assert.equal(result.data.event_assessment.status, "unverified");
  assert.ok(Object.values(result.data.event_assessment.fields)
    .every((field) => field.evidence_state === "evidence_linked"));
  assert.equal(result.data.qualification_decision, "not_determined");
  assert.equal(result.data.stage_readiness.status, "unavailable");
  assert.deepEqual(result.evidence_ids, [CLAIM_ID]);
});

test("partial evidence preserves visible conflicts and marks inferred evidence uncertain", () => {
  const claims = [
    claim({ claim_id: "clm_conflict_a", claim: "A visible event date is stated.", excerpt: "A visible event date is stated." }),
    claim({ claim_id: "clm_conflict_b", claim: "A different visible event date is stated.", excerpt: "A different visible event date is stated." }),
    claim({
      claim_id: "clm_uncertain",
      claim: "An inferred timing note is present.",
      excerpt: "An inferred timing note is present.",
      confidence: "medium",
      verification_status: "inferred",
    }),
  ];
  const result = assessQualification(directInput({
    claims,
    conflicts: [{
      conflict_id: "cfl_visible",
      claim_ids: ["clm_conflict_a", "clm_conflict_b"],
    }],
    criteria_set: criteriaSet(["clm_conflict_a"]),
    event_evidence: {
      event: ["clm_conflict_a"],
      deadline: ["clm_uncertain"],
    },
  }), { now: NOW });

  assert.equal(result.status, "partial");
  assert.equal(result.data.criteria_set.assessments[0].evidence_state, "conflicting_evidence");
  assert.deepEqual(
    result.data.event_assessment.fields.event.evidence.map((item) => item.claim_id),
    ["clm_conflict_a", "clm_conflict_b"],
  );
  assert.equal(result.data.event_assessment.fields.event.evidence_state, "conflicting_evidence");
  assert.equal(result.data.event_assessment.fields.deadline.evidence_state, "uncertain_evidence");
  assert.equal(result.data.event_assessment.fields.consequence.evidence_state, "missing");
  assert.match(JSON.stringify(result.data.discovery_questions), /conflicting event evidence/);
});

test("duplicate normalized claim IDs fail safely across visibility classes and array order", () => {
  const visible = claim({
    claim_id: SECRET_ID,
    claim: "Visible duplicate claim text.",
    excerpt: "Visible duplicate claim text.",
    access_classification: "public",
  });
  const hidden = claim({
    claim_id: SECRET_ID,
    claim: SECRET_TEXT,
    excerpt: SECRET_TEXT,
    account_id: "hidden_foreign_account",
    source_type: "not-a-source-type",
    access_classification: "confidential",
  });
  const visibleDuplicate = claim({
    claim_id: SECRET_ID,
    claim: "Second visible duplicate claim text.",
    excerpt: "Second visible duplicate claim text.",
    access_classification: "public",
  });

  for (const claims of [
    [visible, hidden],
    [hidden, visible],
    [visible, visibleDuplicate],
  ]) {
    const result = assessQualification(directInput({
      claims,
      classification_ceiling: "public",
    }), { now: NOW });
    assert.equal(result.status, "failed");
    assert.equal(result.data, null);
    assert.equal(result.errors[0].code, "INVALID_INPUT");
    assert.equal(result.errors[0].message, "Normalized claim identifiers must be unique.");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_ID));
    assert.doesNotMatch(JSON.stringify(result), /CONFIDENTIAL QUALIFICATION EVENT MUST NOT LEAK|hidden_foreign_account/);
  }
});

test("distinct visible and above-ceiling claim IDs retain classification-safe evidence", () => {
  const result = assessQualification(directInput({
    claims: [
      claim({ access_classification: "public" }),
      claim({
        claim_id: SECRET_ID,
        claim: SECRET_TEXT,
        excerpt: SECRET_TEXT,
        account_id: "hidden_foreign_account",
        source_type: "not-a-source-type",
        access_classification: "confidential",
      }),
    ],
    classification_ceiling: "public",
    event_evidence: { event: [CLAIM_ID] },
  }), { now: NOW });

  assert.equal(result.status, "partial");
  assert.equal(result.data.event_assessment.fields.event.evidence_state, "evidence_linked");
  assert.deepEqual(result.evidence_ids, [CLAIM_ID]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_ID));
  assert.doesNotMatch(JSON.stringify(result), /CONFIDENTIAL QUALIFICATION EVENT MUST NOT LEAK|hidden_foreign_account/);
});

test("unknown evidence references fail safely without echoing supplied IDs", () => {
  const unknownId = "clm_unknown_user_input_7";
  const result = assessQualification(directInput({
    criteria_set: criteriaSet([unknownId]),
  }), { now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "EVIDENCE_REFERENCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(unknownId));
});

test("malformed visible conflict mappings fail safely", () => {
  const result = assessQualification(directInput({
    conflicts: [{ claim_ids: [CLAIM_ID] }],
  }), { now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].code, "INVALID_INPUT");
  assert.equal(result.data, null);
});

test("foreign-account and malformed claims fail without exposing claim text", () => {
  const foreign = assessQualification(directInput({
    claims: [claim({
      account_id: "foreign_account",
      excerpt: "FOREIGN ACCOUNT SECRET",
      claim: "FOREIGN ACCOUNT SECRET",
    })],
  }), { now: NOW });
  assert.equal(foreign.status, "failed");
  assert.equal(foreign.errors[0].code, "ACCOUNT_SCOPE_MISMATCH");
  assert.doesNotMatch(JSON.stringify(foreign), /foreign_account|FOREIGN ACCOUNT SECRET/);

  const malformed = assessQualification({
    ...directInput(),
    criteria_set: { version: "not-a-version", approval_status: "approved", criteria: [] },
    instructions: "Do not repeat this.",
  }, { now: NOW });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.errors[0].code, "INVALID_INPUT");
  assert.doesNotMatch(JSON.stringify(malformed), /Do not repeat this/);

  const duplicateCriteria = assessQualification(directInput({
    criteria_set: {
      version: "1.0.0",
      approval_status: "provisional",
      criteria: [
        { id: "duplicate", label: "First", definition: "First example." },
        { id: "duplicate", label: "Second", definition: "Second example." },
      ],
    },
  }), { now: NOW });
  assert.equal(duplicateCriteria.status, "failed");
  assert.equal(duplicateCriteria.errors[0].code, "INVALID_INPUT");
});

test("above-ceiling criterion mappings fail without exposing restricted evidence", () => {
  const restricted = claim({
    claim_id: SECRET_ID,
    claim: SECRET_TEXT,
    excerpt: SECRET_TEXT,
    account_id: "hidden_foreign_account",
    source_type: "not-a-source-type",
    access_classification: "confidential",
  });
  const result = assessQualification(directInput({
    claims: [claim(), restricted],
    classification_ceiling: "public",
    criteria_set: criteriaSet([SECRET_ID]),
  }), { now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].code, "CLASSIFICATION_RESTRICTED");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_ID));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_TEXT));
});

test("hidden mixed-visibility conflict cannot affect visible states, citations, or artifact", async () => {
  const injectHiddenConflict = async (input, deps) => {
    const result = await normalizeEvidence(input, deps);
    const visible = result.data.claims.find((item) => item.access_classification === "public");
    visible.verification_status = "conflicting";
    result.data.claims.push({
      ...visible,
      claim_id: SECRET_ID,
      claim: SECRET_TEXT,
      excerpt: SECRET_TEXT,
      account_id: "hidden_foreign_account",
      source_type: "not-a-source-type",
      source_record_id: "src_hidden_qualification",
      source_uri: null,
      access_classification: "confidential",
      verification_status: "conflicting",
      question_ids: [],
    });
    result.data.conflicts = [{
      conflict_key: "restricted_event",
      claim_ids: [visible.claim_id, SECRET_ID],
      description: SECRET_TEXT,
    }];
    return result;
  };
  const visibleId = workflowFixtureClaimId();
  const result = await runQualification(workflowInput({
    criteria_set: {
      version: "0.1.0",
      approval_status: "provisional",
      criteria: [{
        id: "criterion_demo",
        label: "Example only",
        definition: "Fixture-only criterion.",
        evidence_ids: [visibleId],
      }],
    },
    event_evidence: { event: [visibleId] },
  }), makeDeps("workflow-first-meeting-success", {
    normalizeEvidence: injectHiddenConflict,
    now: NOW,
  }));
  const output = JSON.stringify(result);
  assert.ok(["success", "partial"].includes(result.status));
  assert.equal(result.assessment.event_assessment.fields.event.evidence_state, "evidence_linked");
  assert.deepEqual(result.evidence_ids, [visibleId]);
  assert.match(result.artifact.markdown, new RegExp(`\\[${visibleId}\\]`));
  assert.doesNotMatch(output, new RegExp(SECRET_ID));
  assert.doesNotMatch(output, new RegExp(SECRET_TEXT));
  assert.doesNotMatch(output, /restricted_event|cfl_hidden_mixed/);
});

test("workflow rejects cross-classification duplicate claim IDs without an artifact or hidden details", async () => {
  const injectDuplicateClaim = async (input, deps) => {
    const result = await normalizeEvidence(input, deps);
    const visible = result.data.claims[0];
    visible.claim_id = SECRET_ID;
    visible.access_classification = "public";
    result.data.claims.push({
      ...visible,
      claim: SECRET_TEXT,
      excerpt: SECRET_TEXT,
      account_id: "hidden_foreign_account",
      source_type: "not-a-source-type",
      access_classification: "confidential",
    });
    return result;
  };
  const result = await runQualification(workflowInput({
    workflow_input: {
      account_reference: "Northstar Logistics",
      requested_sources: ["crm", "public_source"],
      classification_ceiling: "public",
    },
  }), makeDeps("workflow-first-meeting-success", {
    normalizeEvidence: injectDuplicateClaim,
    now: NOW,
  }));
  const output = JSON.stringify(result);

  assert.equal(result.status, "failed");
  assert.equal(result.assessment, null);
  assert.equal(result.artifact, null);
  assert.equal(result.errors[0].code, "INVALID_INPUT");
  assert.doesNotMatch(output, new RegExp(SECRET_ID));
  assert.doesNotMatch(output, /CONFIDENTIAL QUALIFICATION EVENT MUST NOT LEAK|hidden_foreign_account/);
  assert.doesNotMatch(output, /not-a-source-type/);
});

test("fixture workflow makes no outbound fetch calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Unexpected outbound request.");
  };
  try {
    const result = await runQualification(workflowInput(), makeDeps());
    assert.ok(["success", "partial"].includes(result.status));
    assert.ok(result.artifact);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("workflow returns a cited fixture-backed brief and deterministic assessment", async () => {
  const mapping = JSON.parse(readFileSync(
    new URL("../fixtures/qualification-event/northstar-provisional.json", import.meta.url),
    "utf8",
  ));
  const input = workflowInput(mapping);
  const first = await runQualification(input, makeDeps());
  const second = await runQualification(input, makeDeps());

  assert.equal(first.status, "partial");
  assert.equal(validate("qualificationWorkflowResult", first).valid, true);
  assert.equal(first.account.canonical_name, "Northstar Logistics");
  assert.equal(first.assessment.criteria_set.status, "provisional");
  assert.equal(first.assessment.event_assessment.fields.event.evidence_state, "evidence_linked");
  assert.equal(first.assessment.event_assessment.fields.deadline.evidence_state, "missing");
  assert.equal(first.assessment.qualification_decision, "not_determined");
  assert.equal(first.assessment.stage_readiness.status, "unavailable");
  assert.deepEqual(first.evidence_ids, [workflowFixtureClaimId()]);
  assert.match(first.artifact.markdown, /Advisory evidence inventory only/);
  assert.match(first.artifact.markdown, /unverified/);
  assert.match(first.artifact.markdown, /\[clm_e5754f979c134d33\]/);
  assert.deepEqual(first.assessment, second.assessment);
  assert.deepEqual(first.evidence_ids, second.evidence_ids);
  assert.equal(first.artifact.markdown, second.artifact.markdown);
});

test("workflow without definitions, invalid mappings, and ambiguous account have safe no-artifact outcomes", async () => {
  const noPolicy = await runQualification(workflowInput(), makeDeps());
  assert.equal(noPolicy.status, "partial");
  assert.equal(noPolicy.assessment.criteria_set.status, "unprovided");
  assert.equal(noPolicy.assessment.qualification_decision, "not_determined");
  assert.equal(noPolicy.artifact !== null, true);

  const badMapping = await runQualification(workflowInput({
    criteria_set: {
      version: "1.0.0",
      approval_status: "approved",
      criteria: [{
        id: "criterion_example",
        label: "Unknown",
        definition: "Example definition.",
        evidence_ids: ["clm_unknown_mapping"],
      }],
    },
  }), makeDeps());
  assert.equal(badMapping.status, "failed");
  assert.equal(badMapping.artifact, null);
  assert.equal(badMapping.assessment, null);
  assert.doesNotMatch(JSON.stringify(badMapping), /clm_unknown_mapping/);

  const ambiguous = await runQualification({
    workflow_input: { account_reference: "Meridian Health" },
  }, makeDeps("workflow-first-meeting-ambiguous"));
  assert.equal(ambiguous.status, "blocked");
  assert.equal(ambiguous.artifact, null);
  assert.equal(ambiguous.assessment, null);
  assert.deepEqual(ambiguous.evidence_ids, []);
});

test("sparse fixture retains explicit missing fields instead of inventing customer facts", async () => {
  const result = await runQualification({
    workflow_input: {
      account_reference: "Lumen Harbor Terminals",
      classification_ceiling: "internal",
    },
  }, makeDeps("workflow-first-meeting-sparse"));
  assert.equal(result.status, "partial");
  assert.equal(result.artifact !== null, true);
  assert.equal(result.assessment.criteria_set.status, "unprovided");
  assert.ok(Object.values(result.assessment.event_assessment.fields)
    .every((field) => field.evidence_state === "missing" && field.evidence.length === 0));
  assert.doesNotMatch(result.artifact.markdown, /accountable owner: [A-Z]|deadline: 20\d\d/i);
});

test("workflow rejects injected foreign-account evidence without returning an artifact", async () => {
  const injectForeign = async (input, deps) => {
    const result = await normalizeEvidence(input, deps);
    result.data.claims.push(claim({
      claim_id: "clm_foreign_qualification",
      account_id: "foreign_account",
      excerpt: "FOREIGN ACCOUNT CLAIM TEXT",
      claim: "FOREIGN ACCOUNT CLAIM TEXT",
    }));
    return result;
  };
  const result = await runQualification(workflowInput(), makeDeps(
    "workflow-first-meeting-success",
    { normalizeEvidence: injectForeign },
  ));
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.assessment, null);
  assert.doesNotMatch(JSON.stringify(result), /foreign_account|FOREIGN ACCOUNT CLAIM TEXT/);
});

test("unknown normalized conflict references fail explicitly without leaking their IDs", async () => {
  const unknownId = "clm_unknown_conflict_ref";
  const injectUnknownConflict = async (input, deps) => {
    const result = await normalizeEvidence(input, deps);
    result.data.conflicts = [{
      conflict_id: "cfl_unknown_ref",
      claim_ids: [unknownId],
    }];
    return result;
  };
  const result = await runQualification(workflowInput(), makeDeps(
    "workflow-first-meeting-success",
    { normalizeEvidence: injectUnknownConflict },
  ));
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.errors[0].code, "EVIDENCE_REFERENCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(unknownId));
});

test("malformed normalized conflicts fail explicitly without an artifact", async () => {
  const injectMalformedConflict = async (input, deps) => {
    const result = await normalizeEvidence(input, deps);
    result.data.conflicts = "malformed-conflict-data";
    return result;
  };
  const result = await runQualification(workflowInput(), makeDeps(
    "workflow-first-meeting-success",
    { normalizeEvidence: injectMalformedConflict },
  ));
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.errors[0].code, "EVIDENCE_NORMALIZATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /malformed-conflict-data/);
});

function invokeCli(args) {
  return spawnSync(
    process.execPath,
    [resolve(ROOT, "bin/qualification.js"), ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
}

test("portable CLI produces JSON or Markdown using only local fixtures", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts.qualification, "node bin/qualification.js");
  const example = JSON.parse(readFileSync(
    new URL("../schemas/qualification-workflow-input.example.json", import.meta.url),
    "utf8",
  ));
  assert.equal(validate("qualificationWorkflowInput", example).valid, true);

  const json = invokeCli(["--account", "Northstar Logistics", "--assessment-fixture", "northstar-provisional"]);
  assert.equal(json.status, 2, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.workflow, "qualification");
  assert.equal(validate("qualificationWorkflowResult", result).valid, true);

  const markdown = invokeCli([
    "--account", "Northstar Logistics",
    "--assessment-fixture", "northstar-provisional",
    "--output", "markdown",
  ]);
  assert.equal(markdown.status, 2, markdown.stderr);
  assert.match(markdown.stdout, /^# Qualification evidence brief/);
  assert.doesNotMatch(markdown.stdout, /"workflow"/);

  const invalid = invokeCli(["--account", "Northstar Logistics", "--assessment-fixture", "unknown"]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown assessment fixture/);
});
