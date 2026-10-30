import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const referencePath = fileURLToPath(
  new URL("../../reference/first-meeting-questions.yaml", import.meta.url),
);

const reference = YAML.parse(readFileSync(referencePath, "utf8"));

/** Category order comes from the reference file, never from model judgement. */
export const CATEGORY_ORDER = Object.freeze(reference.categories.map((category) => category.id));

const questions = reference.categories.flatMap((category) =>
  category.questions.map((question, index) => ({
    id: question.id,
    text: question.question,
    category: category.id,
    position: index,
  })),
);

const byId = new Map(questions.map((question) => [question.id, question]));
const categoryRank = new Map(CATEGORY_ORDER.map((id, index) => [id, index]));

/** Stable reference order: category, then the question's position in that category. */
export function compareQuestionIds(a, b) {
  const left = byId.get(a);
  const right = byId.get(b);
  if (left && right) {
    return (
      (categoryRank.get(left.category) ?? 0) - (categoryRank.get(right.category) ?? 0) ||
      left.position - right.position ||
      a.localeCompare(b)
    );
  }
  if (left) return -1;
  if (right) return 1;
  return a.localeCompare(b);
}

export function categoryForQuestion(questionId) {
  return byId.get(questionId)?.category ?? null;
}

export function questionText(questionId) {
  return byId.get(questionId)?.text ?? questionId;
}
