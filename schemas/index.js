import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaDir = dirname(fileURLToPath(import.meta.url));

const load = (filename) => JSON.parse(readFileSync(join(schemaDir, filename), "utf8"));

/** Files whose validation capability is exposed through validate(). */
const SCHEMA_FILES = {
  skillResult: "skill-result.schema.json",
  evidence: "evidence.schema.json",
  error: "error.schema.json",
  sourceRecord: "source-record.schema.json",
  gapResult: "gap-result.schema.json",
  firstMeetingBriefInput: "first-meeting-brief-input.schema.json",
};

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

export const schemaDocuments = Object.fromEntries(
  Object.entries(SCHEMA_FILES).map(([name, filename]) => [name, load(filename)]),
);

for (const schema of Object.values(schemaDocuments)) ajv.addSchema(schema);

/**
 * Validate a value against a named shared schema.
 * Returns {valid, errors} where errors is a readable list of {path, message}.
 * Throws if `name` is not a known schema (developer error, not data error).
 */
export function validate(name, value) {
  const schema = schemaDocuments[name];
  if (!schema) throw new Error(`Unknown schema: ${name}`);
  const validateFn = ajv.getSchema(schema.$id);
  const valid = validateFn(value);
  return {
    valid: Boolean(valid),
    errors: valid
      ? []
      : (validateFn.errors ?? []).map((e) => ({
          path: e.instancePath || "/",
          message: e.message ?? "schema violation",
        })),
  };
}
