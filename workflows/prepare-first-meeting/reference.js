import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const referencePath = fileURLToPath(
  new URL("../../reference/first-meeting-questions.yaml", import.meta.url),
);

let cached;

/**
 * Load the draft first-meeting reference question set as the active workflow
 * question set. Only IDs and question text are exposed; this is reference data,
 * not an answer or a skill result.
 */
export function loadDefaultQuestions() {
  if (cached) return cached;
  const document = YAML.parse(readFileSync(referencePath, "utf8"));
  cached = {
    version: document.version,
    questions: (document.categories ?? []).flatMap((category) =>
      (category.questions ?? []).map((question) => ({
        id: question.id,
        text: question.question,
      })),
    ),
  };
  return cached;
}
