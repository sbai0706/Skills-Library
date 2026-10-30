import { readFileSync } from "node:fs";
import YAML from "yaml";

const referenceUrl = new URL("../../reference/first-meeting-questions.yaml", import.meta.url);

let cached;

export function loadReferenceQuestionSet() {
  if (cached) return cached;
  const document = YAML.parse(readFileSync(referenceUrl, "utf8"));
  const questions = (document.categories ?? []).flatMap((category) =>
    (category.questions ?? []).map((question) => ({ ...question })),
  );
  cached = { version: document.version, questions };
  return cached;
}
