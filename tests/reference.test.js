import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const referencePath = new URL("../reference/first-meeting-questions.yaml", import.meta.url);
const reference = YAML.parse(readFileSync(referencePath, "utf8"));
const questions = reference.categories.flatMap((category) =>
  category.questions.map((question) => ({ ...question, category: category.id })),
);

test("reference file declares version, draft status, and TBD owner", () => {
  assert.match(reference.version, /^\d+\.\d+\.\d+$/);
  assert.equal(reference.status, "draft");
  assert.equal(reference.business_owner, "TBD");
  assert.ok(Array.isArray(reference.change_history) && reference.change_history.length > 0);
});

test("reference covers the six required question areas", () => {
  assert.deepEqual(
    reference.categories.map((c) => c.id).sort(),
    ["company_context", "evidence_gaps", "prior_relationship", "recent_developments", "service_alignment", "stakeholders"],
  );
});

test("every question has a stable unique ID and a required flag", () => {
  const ids = questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, "question IDs are unique");
  for (const question of questions) {
    assert.match(question.id, /^FM-[A-Z]{3}-\d{3}$/, `stable ID format for ${question.id}`);
    assert.equal(typeof question.required, "boolean", `required flag for ${question.id}`);
    assert.equal(typeof question.question, "string");
    assert.ok(question.question.trim().length > 0);
  }
});

test("each category contains at least one required question", () => {
  for (const category of reference.categories) {
    assert.ok(category.id && category.label, "category has id and label");
    assert.ok(
      category.questions.some((q) => q.required === true),
      `${category.id} has a required question`,
    );
  }
});

test("questions are reference text, not answers or runtime results", () => {
  for (const question of questions) {
    assert.equal(question.answer, undefined);
    assert.equal(question.value, undefined);
    assert.equal(question.result, undefined);
    assert.ok(question.question.trim().endsWith("?"), `${question.id} is phrased as a question`);
  }
});

test("service alignment questions carry the hypothesis caveat", () => {
  const alignment = reference.categories.find((c) => c.id === "service_alignment");
  assert.ok(alignment.questions.some((q) => typeof q.caveat === "string"));
});
