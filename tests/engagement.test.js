import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createFixtureAccountAdapter } from "../adapters/fixture-account-adapter.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { createFixtureClaimExtractor } from "../adapters/fixture-claim-extractor.js";
import { draftEngagement } from "../skills/engagement/index.js";
import { schemaDocuments, validate } from "../schemas/index.js";
import { prepareEngagement } from "../workflows/prepare-engagement/index.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = resolve(ROOT, "bin/prepare-engagement.js");
const NOW = () => new Date("2026-10-25T00:00:00.000Z");
const ACCOUNT = { account_id: "acc_engagement_test", canonical_name: "Example Account" };

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function fixtureInput(name) {
  return readJson(`../fixtures/${name}/input.json`);
}

function fixtureExpected(name) {
  return readJson(`../fixtures/${name}/expected.json`);
}

function fixtureDeps(name, overrides = {}) {
  return {
    accountAdapter: createFixtureAccountAdapter({ fixture: "workflow-first-meeting-success" }),
    evidenceAdapter: createFixtureEvidenceAdapter({ fixture: name }),
    claimExtractor: createFixtureClaimExtractor(),
    now: NOW,
    traceId: "trace_engagement_test",
    ...overrides,
  };
}

function makeClaim({
  id = "clm_context_001",
  text = "Example Account recorded a service modernization initiative.",
  sourceType = "crm_activity",
  accountId = ACCOUNT.account_id,
  classification = "public",
  verification = "direct",
  recordId = `src_${id.slice(4)}`,
} = {}) {
  return {
    claim_id: id,
    claim: text,
    source_type: sourceType,
    source_uri: null,
    source_record_id: recordId,
    account_id: accountId,
    retrieved_at: "2026-10-25T10:00:00Z",
    excerpt: text,
    confidence: "high",
    verification_status: verification,
    access_classification: classification,
  };
}

function directInput(overrides = {}) {
  const context = makeClaim();
  const stakeholderClaim = makeClaim({
    id: "clm_stakeholder_001",
    text: "Alex Example is Operations Lead.",
    sourceType: "crm_record",
    classification: "internal",
    recordId: "src_stakeholder",
  });
  stakeholderClaim.excerpt = "Alex Example, Operations Lead";
  const meetingClaim = makeClaim({
    id: "clm_meeting_001",
    text: "The meeting notes record a discussion of service modernization.",
    sourceType: "crm_activity",
    classification: "internal",
    recordId: "src_meeting",
  });
  return {
    mode: "initial",
    account: ACCOUNT,
    claims: [context, stakeholderClaim, meetingClaim],
    classification_ceiling: "internal",
    outreach_claim_ids: [context.claim_id],
    meeting_claim_ids: [context.claim_id],
    stakeholder_map: {
      account_id: ACCOUNT.account_id,
      stakeholders: [{
        stakeholder_id: "stkh_example_001",
        display_name: "Alex Example",
        role_evidence: "Alex Example, Operations Lead",
        persona_id: "per_operations_leader",
        claim_ids: [stakeholderClaim.claim_id],
        evidence_ids: [stakeholderClaim.claim_id],
      }],
    },
    recipient_name: "Alex Example",
    ...overrides,
  };
}

async function runFixture(name, overrides = {}) {
  return prepareEngagement(fixtureInput(name), fixtureDeps(name, overrides));
}

function invokeCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
}

function jsonResult(processResult) {
  assert.equal(processResult.error, undefined, processResult.error?.message);
  assert.ok(processResult.stdout.endsWith("\n"));
  assert.equal(processResult.stdout.trim().split("\n").length, 1);
  return JSON.parse(processResult.stdout);
}

test("Engagement schemas are registered and deterministic workflow fixture inputs validate", () => {
  for (const name of [
    "engagementDraftInput",
    "engagementDraftData",
    "prepareEngagementInput",
    "prepareEngagementResult",
  ]) {
    assert.ok(schemaDocuments[name], `${name} is registered`);
    assert.ok(schemaDocuments[name].$id, `${name} has a stable schema ID`);
  }
  for (const fixture of [
    "engagement-initial",
    "engagement-follow-up",
    "engagement-sparse",
    "engagement-empty",
    "engagement-conflicting",
  ]) {
    assert.equal(
      validate("prepareEngagementInput", fixtureInput(fixture)).valid,
      true,
      fixture,
    );
    assert.ok(fixtureExpected(fixture).status);
  }
});

test("initial workflow drafts outreach, meeting preparation, questions, and mapped talking points", async () => {
  const sent = [];
  const changedCrm = [];
  const result = await runFixture("engagement-initial", {
    sendMessage: (...args) => sent.push(args),
    mutateCrm: (...args) => changedCrm.push(args),
  });
  const expected = fixtureExpected("engagement-initial");

  assert.equal(result.status, expected.status);
  assert.equal(validate("prepareEngagementResult", result).valid, true);
  assert.ok(result.artifact);
  assert.equal(result.engagement.draft_only, true);
  for (const section of expected.expected_sections) {
    assert.ok(result.artifact.markdown.includes(section), section);
  }
  assert.deepEqual(result.evidence_ids, expected.expected_citations);
  assert.match(result.artifact.markdown, /Hello Priya Raman/);
  assert.match(result.artifact.markdown, /Priya Raman is Director of Operations/);
  assert.match(result.artifact.markdown, /do not infer decision authority/);
  assert.match(result.artifact.markdown, /Draft only.*no communication was sent/);
  assert.doesNotMatch(result.artifact.markdown, /CIO|budget owner|approved messaging/);
  assert.deepEqual(sent, []);
  assert.deepEqual(changedCrm, []);
});

test("follow-up workflow uses only supplied meeting evidence and proposes unassigned next questions", async () => {
  const result = await runFixture("engagement-follow-up");
  const expected = fixtureExpected("engagement-follow-up");

  assert.equal(result.status, expected.status);
  assert.equal(validate("prepareEngagementResult", result).valid, true);
  assert.ok(result.artifact);
  for (const section of expected.expected_sections) {
    assert.ok(result.artifact.markdown.includes(section), section);
  }
  for (const citation of expected.expected_citations) {
    assert.ok(result.evidence_ids.includes(citation), citation);
  }
  for (const phrase of expected.must_not_contain) {
    assert.ok(!result.artifact.markdown.includes(phrase), phrase);
  }
  assert.match(result.artifact.markdown, /No owner, date, agreement, or commitment is inferred/);
  assert.match(result.artifact.markdown, /what next step, if any/);
});

test("sparse initial evidence returns an explicitly partial generic draft", async () => {
  const result = await runFixture("engagement-sparse");
  assert.equal(result.status, fixtureExpected("engagement-sparse").status);
  assert.ok(result.artifact);
  assert.deepEqual(result.evidence_ids, []);
  assert.match(result.artifact.markdown, /Add an account-specific reference only after checking it/);
  assert.ok(result.warnings.some((warning) => warning.code === "NO_VISIBLE_EVIDENCE"));
  assert.ok(result.warnings.some((warning) => warning.code === "NO_STAKEHOLDER_MAPPING"));
});

test("empty follow-up evidence blocks without a publishable artifact", async () => {
  const result = await runFixture("engagement-empty");
  assert.equal(result.status, "blocked");
  assert.equal(result.artifact, null);
  assert.equal(result.engagement, null);
  assert.deepEqual(result.evidence_ids, []);
  assert.ok(result.errors.some((error) => error.code === fixtureExpected("engagement-empty").error_code));
});

test("visible conflicts are retained, cited, and never resolved by the follow-up draft", async () => {
  const result = await runFixture("engagement-conflicting");
  assert.equal(result.status, "partial");
  assert.ok(result.artifact);
  assert.ok(result.warnings.some((warning) => warning.code === "VISIBLE_EVIDENCE_CONFLICT"));
  assert.match(result.artifact.markdown, /conflicting statements/);
  assert.match(result.artifact.markdown, /this draft selects no version/);
  assert.match(result.artifact.markdown, /Q2 2027/);
  assert.match(result.artifact.markdown, /Q3 2027/);
  for (const id of fixtureExpected("engagement-conflicting").expected_citations) {
    assert.ok(result.evidence_ids.includes(id), id);
  }
});

test("above-ceiling conflicting evidence does not leak conflict metadata or hidden references", async () => {
  const input = fixtureInput("engagement-conflicting");
  input.mode = "initial";
  input.workflow_input.classification_ceiling = "public";
  delete input.follow_up_claim_ids;
  input.outreach_claim_ids = [];
  input.meeting_claim_ids = [];
  const result = await prepareEngagement(input, fixtureDeps("engagement-conflicting"));
  const output = JSON.stringify(result);

  assert.equal(result.status, "partial");
  assert.ok(result.artifact);
  assert.ok(!result.warnings.some((warning) => warning.code === "VISIBLE_EVIDENCE_CONFLICT"));
  assert.doesNotMatch(output, /clm_486a60a81f8ddd0c|clm_4508f27821b000d6/);
  assert.doesNotMatch(output, /Q2 2027|Q3 2027|conflicting rollout quarter/);
});

test("missing references fail at the callable skill boundary without echoing the ID", () => {
  const missingId = "clm_missing_engagement_001";
  const result = draftEngagement(directInput({ outreach_claim_ids: [missingId] }), { now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.ok(result.errors.some((error) => error.code === "EVIDENCE_REFERENCE_UNAVAILABLE"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(missingId));
});

test("foreign-account claims fail at the callable skill boundary without exposing content", () => {
  const privateText = "FOREIGN_ACCOUNT_SECRET_SENTENCE";
  const foreign = makeClaim({
    id: "clm_foreign_engagement_001",
    text: privateText,
    accountId: "another_account",
    recordId: "src_foreign",
  });
  const result = draftEngagement(directInput({ claims: [foreign] }), { now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.ok(result.errors.some((error) => error.code === "ACCOUNT_SCOPE_MISMATCH"));
  assert.doesNotMatch(JSON.stringify(result), /another_account|FOREIGN_ACCOUNT_SECRET_SENTENCE|clm_foreign_engagement_001/);
});

test("above-ceiling references fail without exposing withheld text or identifiers", () => {
  const hidden = makeClaim({
    id: "clm_hidden_engagement_991",
    text: "CONFIDENTIAL_ENGAGEMENT_FACT",
    sourceType: "crm_activity",
    classification: "internal",
    recordId: "src_hidden_engagement",
  });
  const hiddenInput = directInput({
    mode: "follow_up",
    classification_ceiling: "public",
    follow_up_claim_ids: [hidden.claim_id],
    claims: [makeClaim(), hidden],
    stakeholder_map: { account_id: ACCOUNT.account_id, stakeholders: [] },
  });
  delete hiddenInput.recipient_name;
  const result = draftEngagement(hiddenInput, { now: NOW });
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.ok(result.errors.some((error) => error.code === "CLASSIFICATION_RESTRICTED"));
  assert.doesNotMatch(JSON.stringify(result), /clm_hidden_engagement_991|CONFIDENTIAL_ENGAGEMENT_FACT/);
});

test("malformed evidence and unsupported follow-up source types fail without empty success", () => {
  const malformed = makeClaim({
    id: "clm_malformed_engagement_001",
    text: "MALFORMED_PRIVATE_EVIDENCE",
  });
  delete malformed.source_record_id;
  delete malformed.source_uri;
  const malformedResult = draftEngagement(directInput({ claims: [malformed] }), { now: NOW });
  assert.equal(malformedResult.status, "failed");
  assert.equal(malformedResult.data, null);
  assert.ok(malformedResult.errors.some((error) => error.code === "INVALID_INPUT"));
  assert.doesNotMatch(JSON.stringify(malformedResult), /MALFORMED_PRIVATE_EVIDENCE/);

  const unsupported = makeClaim({
    id: "clm_not_a_meeting_record",
    text: "A public source says this account is interesting.",
    sourceType: "news",
    recordId: "src_public",
  });
  const unsupportedInput = directInput({
    mode: "follow_up",
    follow_up_claim_ids: [unsupported.claim_id],
    claims: [unsupported],
    outreach_claim_ids: [],
    meeting_claim_ids: [],
    stakeholder_map: { account_id: ACCOUNT.account_id, stakeholders: [] },
  });
  delete unsupportedInput.recipient_name;
  const unsupportedResult = draftEngagement(unsupportedInput, { now: NOW });
  assert.equal(unsupportedResult.status, "failed");
  assert.equal(unsupportedResult.data, null);
  assert.ok(unsupportedResult.errors.some((error) => error.code === "UNSUPPORTED_MAPPING"));
});

test("recipient must resolve to one evidence-backed stakeholder and conflict cannot personalize greeting", () => {
  const missing = draftEngagement(directInput({ recipient_name: "Unknown Person" }), { now: NOW });
  assert.equal(missing.status, "failed");
  assert.ok(missing.errors.some((error) => error.code === "STAKEHOLDER_REFERENCE_UNAVAILABLE"));

  const conflicted = directInput();
  conflicted.claims = conflicted.claims.map((claim) =>
    claim.claim_id === "clm_stakeholder_001"
      ? { ...claim, verification_status: "conflicting" }
      : claim,
  );
  const conflictResult = draftEngagement(conflicted, { now: NOW });
  assert.equal(conflictResult.status, "failed");
  assert.equal(conflictResult.data, null);
  assert.ok(conflictResult.errors.some((error) => error.code === "UNSUPPORTED_MAPPING"));
});

test("caller-reported template approval is never represented as verified approval", () => {
  const unreferenced = draftEngagement(directInput({
    messaging_guidance: { template_id: "caller-template", version: "2.1.0", approval_status: "approved" },
  }), { now: NOW });
  assert.equal(unreferenced.status, "failed");
  assert.equal(unreferenced.data, null);

  const supplied = draftEngagement(directInput({
    messaging_guidance: {
      template_id: "caller-template",
      version: "2.1.0",
      approval_status: "approved",
      approval_reference: "approval-record-17",
    },
  }), { now: NOW });
  assert.equal(supplied.status, "success");
  assert.equal(supplied.data.messaging_guidance.approval_status, "caller_reported_approved");
  assert.match(supplied.data.markdown, /caller-reported approved; approval was not verified/);
  assert.doesNotMatch(supplied.data.markdown, /approval-record-17/);
});

test("deterministic reruns produce identical draft text and citations", async () => {
  const first = await runFixture("engagement-follow-up");
  const second = await runFixture("engagement-follow-up");
  assert.equal(first.artifact.markdown, second.artifact.markdown);
  assert.deepEqual(first.evidence_ids, second.evidence_ids);
  assert.deepEqual(first.engagement, second.engagement);
});

test("workflow errors do not return drafts or disclose dependency exceptions", async () => {
  const secret = "PRIVATE_NORMALIZER_FAILURE";
  const result = await runFixture("engagement-initial", {
    normalizeEvidence: async () => {
      throw new Error(secret);
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.engagement, null);
  assert.deepEqual(result.evidence_ids, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("workflow missing evidence references fail without emitting a draft or the missing ID", async () => {
  const missingId = "clm_missing_workflow_engagement_002";
  const input = fixtureInput("engagement-initial");
  input.outreach_claim_ids = [missingId];
  const result = await prepareEngagement(input, fixtureDeps("engagement-initial"));

  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.engagement, null);
  assert.deepEqual(result.evidence_ids, []);
  assert.ok(result.errors.some((error) => error.code === "EVIDENCE_REFERENCE_UNAVAILABLE"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(missingId));
});

test("partial source retrieval remains explicit while the usable draft stays review-only", async () => {
  const sources = readJson("../fixtures/engagement-follow-up/sources.json");
  sources.sources.public_source = { mode: "unavailable", records: [] };
  const input = fixtureInput("engagement-follow-up");
  input.workflow_input.requested_sources = ["crm", "public_source"];
  const result = await prepareEngagement(input, fixtureDeps("engagement-follow-up", {
    evidenceAdapter: createFixtureEvidenceAdapter({ sources }),
  }));

  assert.equal(result.status, "partial");
  assert.ok(result.artifact);
  assert.ok(result.warnings.some((warning) => warning.code === "SOURCE_RETRIEVAL_PARTIAL"));
  assert.equal(
    result.steps.find((step) => step.step === "evidence.prepare")?.status,
    "partial",
  );
  assert.match(result.artifact.markdown, /Draft only.*no communication was sent/);
});

test("portable CLI produces one JSON result and emits no artifact for blocked Markdown", () => {
  const json = invokeCli(["--fixture", "engagement-initial"]);
  assert.equal(json.status, 0, json.stderr);
  const result = jsonResult(json);
  assert.equal(result.status, "success");
  assert.equal(validate("prepareEngagementResult", result).valid, true);

  const blocked = invokeCli([
    "--fixture", "engagement-empty",
    "--output", "markdown",
  ]);
  assert.equal(blocked.status, 3);
  assert.equal(blocked.stdout, "");
  assert.match(blocked.stderr, /No draft artifact was produced/);
});

test("portable CLI rejects an unknown fixture and exposes a documented help entrypoint", () => {
  const unknown = invokeCli(["--fixture", "engagement-not-real"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown Engagement fixture/);

  const help = invokeCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: npm run prepare-engagement/);
  assert.match(help.stdout, /no live systems, message sending, or CRM writes/);
});

test("workflow mode and input schema errors fail with no artifact", async () => {
  const invalid = await prepareEngagement({ mode: "send", workflow_input: {} }, fixtureDeps("engagement-initial"));
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.mode, null);
  assert.equal(invalid.artifact, null);
  assert.equal(invalid.engagement, null);
  assert.deepEqual(invalid.evidence_ids, []);
  assert.ok(invalid.errors.some((error) => error.code === "INVALID_INPUT"));
});
