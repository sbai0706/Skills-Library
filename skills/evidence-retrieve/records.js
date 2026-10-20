import { SOURCE_RECORD_TYPES } from "../../adapters/evidence-adapter.js";
import { validate } from "../../schemas/index.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Closed classification taxonomy from schemas/source-record.schema.json. */
export const KNOWN_CLASSIFICATIONS = Object.freeze(["public", "internal", "confidential"]);

/**
 * Classification policy when the caller does not specify one:
 * public and internal are permitted; confidential requires explicit inclusion.
 */
export const DEFAULT_PERMITTED_CLASSIFICATIONS = Object.freeze(["public", "internal"]);

export function isKnownClassification(value) {
  return KNOWN_CLASSIFICATIONS.includes(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Validate one raw source record returned for a requested source.
 *
 * Returns a list of problems. The skill rejects the whole record when the list
 * is non-empty: material fields are never repaired or defaulted, because a
 * silently repaired record would look like source data that the source system
 * never contained.
 *
 * @param {unknown} record
 * @param {{sourceId: string, accountId: string, questionIds: Set<string>}} expected
 * @returns {string[]}
 */
export function recordProblems(record, expected) {
  if (typeof record !== "object" || record === null) return ["record is not an object"];

  const problems = [];
  const { sourceId, accountId, questionIds } = expected;

  if (!nonEmptyString(record.record_id)) problems.push("record_id missing or empty");
  if (!nonEmptyString(record.account_id)) {
    problems.push("account_id missing or empty");
  } else if (record.account_id !== accountId) {
    problems.push(`account_id "${record.account_id}" does not match the requested account`);
  }

  const allowedTypes = SOURCE_RECORD_TYPES[sourceId] ?? [];
  if (!nonEmptyString(record.source_type)) {
    problems.push("source_type missing or empty");
  } else if (!allowedTypes.includes(record.source_type)) {
    problems.push(
      `source_type "${record.source_type}" is not valid for source "${sourceId}" (allowed: ${allowedTypes.join(", ")})`,
    );
  }

  if (!nonEmptyString(record.title)) problems.push("title missing or empty");
  if (!nonEmptyString(record.content)) problems.push("content missing or empty");
  if (!nonEmptyString(record.retrieved_at) || !ISO_DATE.test(record.retrieved_at)) {
    problems.push("retrieved_at missing or not an ISO-8601 date-time");
  }
  if (!isKnownClassification(record.access_classification)) {
    problems.push("access_classification is missing or not a permitted value");
  }
  if (!Array.isArray(record.question_ids)) {
    problems.push("question_ids must be an array");
  } else {
    const unknown = record.question_ids.filter((id) => !questionIds.has(id));
    if (unknown.length > 0) {
      problems.push(`question_ids references questions not in the request: ${unknown.join(", ")}`);
    }
  }
  if (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata)) {
    problems.push("metadata must be an object");
  }

  // Final authority: the shared schema. Catches anything the checks above miss.
  const { valid, errors } = validate("sourceRecord", record);
  if (!valid) {
    for (const error of errors) problems.push(`schema: ${error.path} ${error.message}`);
  }

  return [...new Set(problems)];
}

/** Deterministic record order: source type, then occurrence time, then ID. */
export function compareRecords(a, b) {
  return (
    a.source_type.localeCompare(b.source_type) ||
    (a.occurred_at ?? "").localeCompare(b.occurred_at ?? "") ||
    a.record_id.localeCompare(b.record_id)
  );
}

/** Stable deduplication by record ID, keeping the first occurrence. */
export function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    if (seen.has(record.record_id)) return false;
    seen.add(record.record_id);
    return true;
  });
}

/**
 * Apply the caller's classification limit. Fail-closed:
 *  - an omitted permission list uses DEFAULT_PERMITTED_CLASSIFICATIONS;
 *  - an explicitly empty list permits nothing;
 *  - confidential requires explicit inclusion;
 *  - an unrecognized classification is never treated as public.
 *
 * The returned counts are aggregate only. They carry no record identifier,
 * title, text, or source metadata, so a withheld record cannot leak content
 * through warnings, errors, counts, metadata, or diagnostics.
 *
 * Records reaching this function are already schema-valid, so every
 * classification here is a known one. Unrecognized classifications are
 * diverted before validation and counted separately by the caller.
 */
export function filterByClassification(records, permitted) {
  const allowed = permitted ?? DEFAULT_PERMITTED_CLASSIFICATIONS;
  const kept = [];
  let withheld = 0;
  for (const record of records) {
    if (!allowed.includes(record.access_classification)) {
      withheld += 1;
      continue;
    }
    kept.push(record);
  }
  return { kept, withheld };
}
