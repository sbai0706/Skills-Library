import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { schemaDocuments, validate } from "../schemas/index.js";

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

test("Account Intelligence reference YAML parses with provisional metadata and unique stable IDs", () => {
  for (const [filename, entriesKey] of referenceFiles) {
    const document = YAML.parse(readFileSync(new URL(`../reference/${filename}`, import.meta.url), "utf8"));
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
