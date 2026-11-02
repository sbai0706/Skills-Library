import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  schemaDocuments,
  validate,
  validateFirstMeetingBriefInputV2,
} from "../schemas/index.js";

const referenceFiles = [
  ["signal-taxonomy.yaml", "signals"],
  ["personas.yaml", "personas"],
  ["offerings.yaml", "offerings"],
];

const schemaExamples = [
  ["signalResult", "signal-result.example.json"],
  ["stakeholderMap", "stakeholder-map.example.json"],
  ["offeringMatch", "offering-match.example.json"],
  ["firstMeetingBriefInputV2", "first-meeting-brief-input-v2.example.json"],
];

function readJson(filename) {
  return JSON.parse(readFileSync(new URL(`../schemas/${filename}`, import.meta.url), "utf8"));
}

function readReference(filename) {
  return YAML.parse(readFileSync(new URL(`../reference/${filename}`, import.meta.url), "utf8"));
}

function makeReferenceRegistry() {
  return {
    signalTaxonomy: readReference("signal-taxonomy.yaml"),
    personas: readReference("personas.yaml"),
    offerings: readReference("offerings.yaml"),
  };
}

function makeSemanticBrief() {
  const brief = readJson("first-meeting-brief-input-v2.example.json");
  const claim = readJson("evidence.example.json");
  claim.account_id = brief.account.account_id;
  brief.claims = [claim];
  brief.signals = readJson("signal-result.example.json");
  brief.stakeholder_map = readJson("stakeholder-map.example.json");
  brief.offering_matches = readJson("offering-match.example.json");
  brief.signals.account_id = brief.account.account_id;
  brief.stakeholder_map.account_id = brief.account.account_id;
  brief.offering_matches.account_id = brief.account.account_id;
  brief.signals.signals[0].claim_ids = [claim.claim_id];
  brief.signals.signals[0].evidence_ids = [claim.claim_id];
  brief.stakeholder_map.stakeholders[0].claim_ids = [claim.claim_id];
  brief.stakeholder_map.stakeholders[0].evidence_ids = [claim.claim_id];
  return brief;
}

test("Account Intelligence reference YAML parses with provisional metadata and unique stable IDs", () => {
  for (const [filename, entriesKey] of referenceFiles) {
    const document = readReference(filename);
    assert.match(document.version, /^\d+\.\d+\.\d+$/, filename);
    assert.equal(document.status, "provisional", filename);
    assert.equal(document.business_owner, "TBD", filename);
    assert.equal(document.approver, "TBD", filename);
    assert.equal(document.approval_date, null, filename);
    assert.deepEqual(document.source_documents, [], filename);
    assert.equal(document.effective_date, null, filename);
    assert.ok(Array.isArray(document.change_history) && document.change_history.length > 0, filename);

    const entries = document[entriesKey];
    assert.ok(Array.isArray(entries) && entries.length > 0, `${filename} has entries`);
    const ids = entries.map((entry) => entry.id);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0), `${filename} entries have IDs`);
    assert.equal(new Set(ids).size, ids.length, `${filename} IDs are unique`);
  }
});

test("every new Account Intelligence schema is registered and its example validates", () => {
  for (const [name, filename] of schemaExamples) {
    assert.ok(schemaDocuments[name], `${name} is registered`);
    assert.ok(schemaDocuments[name].$id, `${name} has a stable $id`);
    const result = validate(name, readJson(filename));
    assert.equal(result.valid, true, `${filename}: ${JSON.stringify(result.errors)}`);
  }
});

test("each new schema rejects a malformed identifier or unrecognized field", () => {
  const cases = [
    ["signalResult", "signal-result.example.json", (value) => { value.signals[0].signal_type_id = "wrong_id"; }],
    ["stakeholderMap", "stakeholder-map.example.json", (value) => { value.stakeholders[0].persona_id = "wrong_id"; }],
    ["offeringMatch", "offering-match.example.json", (value) => { value.matches[0].offering_id = "wrong_id"; }],
    ["firstMeetingBriefInputV2", "first-meeting-brief-input-v2.example.json", (value) => { value.unreviewed = true; }],
  ];
  for (const [name, filename, mutate] of cases) {
    const example = readJson(filename);
    mutate(example);
    const result = validate(name, example);
    assert.equal(result.valid, false, `${filename} should reject invalid data`);
    assert.ok(result.errors.length > 0, `${filename} returns validation errors`);
  }
});

test("brief v2 enrichment fields are optional and preserve v1 audience and classification enums", () => {
  const example = readJson("first-meeting-brief-input-v2.example.json");
  delete example.signals;
  delete example.stakeholder_map;
  delete example.offering_matches;
  assert.equal(validate("firstMeetingBriefInputV2", example).valid, true);

  for (const audience of ["internal_sales", "executive", "customer"]) {
    assert.equal(validate("firstMeetingBriefInputV2", { ...example, audience }).valid, true);
  }
  for (const classification of ["public", "internal", "confidential"]) {
    assert.equal(validate("firstMeetingBriefInputV2", { ...example, classification_ceiling: classification }).valid, true);
  }
  assert.equal(validate("firstMeetingBriefInputV2", { ...example, audience: "external_partner" }).valid, false);
  assert.equal(validate("firstMeetingBriefInputV2", { ...example, classification_ceiling: "restricted" }).valid, false);
});

test("brief v2 preserves v1 input shapes with opaque account IDs when enrichment is absent", () => {
  const v1Schema = schemaDocuments.firstMeetingBriefInput;
  const v2Schema = schemaDocuments.firstMeetingBriefInputV2;
  assert.deepEqual(v2Schema.required, v1Schema.required);
  for (const [property, definition] of Object.entries(v1Schema.properties)) {
    assert.deepEqual(v2Schema.properties[property], definition, property);
  }

  const v1Example = readJson("first-meeting-brief-input.example.json");
  assert.equal(validate("firstMeetingBriefInput", v1Example).valid, true);

  for (const accountId of ["acc_fixture_northstar", "account-123", "opaque/customer:01"]) {
    const v1Shape = structuredClone(v1Example);
    v1Shape.account.account_id = accountId;
    assert.equal(validate("firstMeetingBriefInput", v1Shape).valid, true, accountId);
    assert.equal(validate("firstMeetingBriefInputV2", v1Shape).valid, true, accountId);
    assert.equal(validateFirstMeetingBriefInputV2(v1Shape).valid, true, accountId);
  }
});

test("v2 semantic validation accepts empty enrichment and versioned provisional references", () => {
  const empty = readJson("first-meeting-brief-input-v2.example.json");
  assert.equal(validateFirstMeetingBriefInputV2(empty).valid, true);

  const brief = makeSemanticBrief();
  const result = validateFirstMeetingBriefInputV2(brief, {
    referenceRegistry: makeReferenceRegistry(),
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("v2 semantic validation rejects unknown vocabulary and nonexistent claim or signal IDs", () => {
  const registry = makeReferenceRegistry();
  const unknownVocabulary = makeSemanticBrief();
  unknownVocabulary.signals.signals[0].signal_type_id = "sigcat_unknown_but_well_formed";
  unknownVocabulary.stakeholder_map.stakeholders[0].persona_id = "per_unknown_but_well_formed";
  unknownVocabulary.offering_matches.matches[0].offering_id = "off_unknown_but_well_formed";
  assert.equal(validateFirstMeetingBriefInputV2(unknownVocabulary, { referenceRegistry: registry }).valid, false);

  const missingClaim = makeSemanticBrief();
  missingClaim.signals.signals[0].claim_ids = ["clm_nonexistent_001"];
  missingClaim.signals.signals[0].evidence_ids = ["clm_nonexistent_001"];
  assert.equal(validateFirstMeetingBriefInputV2(missingClaim, { referenceRegistry: registry }).valid, false);

  const missingSignal = makeSemanticBrief();
  missingSignal.offering_matches.matches[0].signal_ids = ["sig_nonexistent_001"];
  assert.equal(validateFirstMeetingBriefInputV2(missingSignal, { referenceRegistry: registry }).valid, false);
});

test("v2 semantic validation rejects inconsistent evidence references and cross-account data", () => {
  const registry = makeReferenceRegistry();
  const inconsistent = makeSemanticBrief();
  inconsistent.signals.signals[0].evidence_ids = ["clm_different_001"];
  const inconsistentResult = validateFirstMeetingBriefInputV2(inconsistent, { referenceRegistry: registry });
  assert.equal(inconsistentResult.valid, false);
  assert.ok(inconsistentResult.errors.some((error) => error.path.endsWith("/evidence_ids")));

  const foreignEvidence = makeSemanticBrief();
  foreignEvidence.claims[0].account_id = "another-account";
  assert.equal(validateFirstMeetingBriefInputV2(foreignEvidence, { referenceRegistry: registry }).valid, false);

  const foreignEnrichment = makeSemanticBrief();
  foreignEnrichment.stakeholder_map.account_id = "another-account";
  assert.equal(validateFirstMeetingBriefInputV2(foreignEnrichment, { referenceRegistry: registry }).valid, false);
});

test("v2 enrichment classification errors do not disclose withheld claim IDs or text", () => {
  const brief = makeSemanticBrief();
  const secretId = "clm_secret_withheld_991";
  const secretText = "UNIQUE CONFIDENTIAL CUSTOMER FACT";
  brief.claims[0].claim_id = secretId;
  brief.claims[0].claim = secretText;
  brief.claims[0].excerpt = secretText;
  brief.claims[0].access_classification = "confidential";
  brief.signals.signals[0].claim_ids = [secretId];
  brief.signals.signals[0].evidence_ids = [secretId];

  const result = validateFirstMeetingBriefInputV2(brief, {
    referenceRegistry: makeReferenceRegistry(),
  });
  assert.equal(result.valid, false);
  const diagnostics = JSON.stringify(result.errors);
  assert.doesNotMatch(diagnostics, new RegExp(secretId));
  assert.doesNotMatch(diagnostics, new RegExp(secretText));
});

test("v2 semantic validation preserves conflicting claims without choosing a winner", () => {
  const brief = makeSemanticBrief();
  brief.claims[0].verification_status = "conflicting";
  const conflictingClaim = {
    ...brief.claims[0],
    claim_id: "clm_conflicting_002",
    claim: "The initiative has a different reported start date.",
    excerpt: "The initiative has a different reported start date.",
  };
  brief.claims.push(conflictingClaim);
  brief.signals.signals[0].claim_ids = [brief.claims[0].claim_id, conflictingClaim.claim_id];
  brief.signals.signals[0].evidence_ids = [brief.claims[0].claim_id, conflictingClaim.claim_id];
  const claimsBeforeValidation = structuredClone(brief.claims);

  const result = validateFirstMeetingBriefInputV2(brief, {
    referenceRegistry: makeReferenceRegistry(),
  });
  assert.equal(result.valid, true);
  assert.deepEqual(brief.claims, claimsBeforeValidation);
  assert.ok(brief.claims.every((claim) => claim.verification_status === "conflicting"));
});
