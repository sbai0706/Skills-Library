import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schemaDir = dirname(fileURLToPath(import.meta.url));

const load = (filename) => JSON.parse(readFileSync(join(schemaDir, filename), "utf8"));

export const schemaDocuments = {
  skillResult: load("skill-result.schema.json"),
  evidence: load("evidence.schema.json"),
  error: load("error.schema.json"),
};

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of Object.values(schemaDocuments)) ajv.addSchema(schema);

/**
 * Validate a value against a named shared schema.
 * Returns {valid, errors} where errors is a readable list of {path, message}.
 * Throws if `name` is not a known schema (developer error, not data error).
 */
export function validate(name, value) {
  const validators = {
    skillResult: ajv.getSchema(schemaDocuments.skillResult.$id),
    evidence: ajv.getSchema(schemaDocuments.evidence.$id),
    error: ajv.getSchema(schemaDocuments.error.$id),
  };
  const validateFn = validators[name];
  if (!validateFn) throw new Error(`Unknown schema: ${name}`);
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
