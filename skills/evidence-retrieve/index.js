import { randomUUID } from "node:crypto";
import { resultProblems } from "../../adapters/evidence-adapter.js";
import { validate } from "../../schemas/index.js";
import {
  compareRecords,
  dedupeRecords,
  filterByClassification,
  isKnownClassification,
  recordProblems,
} from "./records.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "evidence.retrieve";
export const SKILL_VERSION = "0.2.0";

/**
 * Per-source outcome codes used in data.source_results. These are diagnostic
 * outcomes, not claims about the world.
 */
export const SOURCE_OUTCOME = Object.freeze({
  OK: "ok",
  EMPTY: "empty",
  UNAUTHORIZED: "unauthorized",
  UNAVAILABLE: "unavailable",
  MALFORMED: "malformed",
  UNSUPPORTED: "unsupported",
});

/**
 * Policy for result status, documented in SKILL.md:
 *   - every source clean (ok or empty)             -> success
 *   - at least one source usable, but not all      -> partial
 *   - all sources failed, any access-policy denial -> blocked (authorization or classification)
 *   - all sources failed, no access-policy denial   -> failed (execution failure)
 *
 * An empty successful source is clean, not a failure. A source that returned
 * malformed records is "degraded": it is usable only if some of its records
 * survived validation.
 */
export function deriveStatus({ cleanCount, degradedCount, failureCodes, total }) {
  if (total === 0) return "failed";
  if (cleanCount === total) return "success";
  if (cleanCount + degradedCount > 0) return "partial";
  if (failureCodes.includes("ADAPTER_UNAUTHORIZED") || failureCodes.includes("CLASSIFICATION_RESTRICTED")) {
    return "blocked";
  }
  return "failed";
}

function envelope({ status, data, startedAt, errors = [], warnings = [] }) {
  const result = {
    skill: SKILL_NAME,
    skill_version: SKILL_VERSION,
    status,
    data,
    evidence_ids: [],
    warnings,
    errors,
    trace_id: `trace_${randomUUID()}`,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  const { valid, errors: schemaErrors } = validate("skillResult", result);
  if (!valid) {
    throw new Error(`evidence.retrieve produced an invalid envelope: ${JSON.stringify(schemaErrors)}`);
  }
  return result;
}

/**
 * Remove free-text source content from diagnostic problems so a rejected or
 * withheld record cannot leak through error metadata. Values that appear inside
 * quotes are dropped; only the field and the rule remain.
 */
function sanitizeProblems(problems) {
  return problems.map((problem) => {
    if (/^schema: /.test(problem)) return problem.replace(/: "[^"]*"/g, "");
    return problem.replace(/"[^"]*"/g, '"<redacted>"');
  });
}

/**
 * Number of records the source provided that survived validation, before the
 * caller's classification filter is applied. This is what distinguishes "the
 * source returned nothing" from "the source returned data the caller may not
 * see"; `record_count` remains the number of records actually returned.
 */
function retainedCount(provided, rejected) {
  return Math.max(0, provided - rejected);
}

/**
 * Map an adapter-level failure to a stable structured error.
 *
 * Only a transport-style ADAPTER_UNAVAILABLE failure is retryable. Malformed
 * adapter payloads are deterministic defects: the skill does not retry them and
 * marks them non-retryable. The skill itself never retries; a future live
 * adapter may retry transient transport failures internally before returning.
 */
function adapterError(sourceId, code, message, details = {}) {
  return { code, message, retryable: code === "ADAPTER_UNAVAILABLE", details: { source: sourceId, ...details } };
}

/**
 * Retrieve raw source records for one resolved account.
 *
 * Returns records from each requested source independently and never converts
 * them into evidence claims.
 *
 * @param {{account_id: string, questions: {id: string, text: string}[], requested_sources: string[], context?: object}} input
 * @param {{adapter: import("../../adapters/evidence-adapter.js").EvidenceAdapter, now?: () => Date}} deps
 * @returns {Promise<object>} skill result envelope
 */
export async function retrieveEvidence(input, deps) {
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const inputResult = validateInput(input);

  if (!inputResult.ok) {
    // Any request-level validation problem fails before the adapter runs.
    // Input defects are never retryable with the same payload.
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: inputResult.errors.map((error) => ({ ...error, retryable: false })),
    });
  }

  const { account_id: accountId, questions, requested_sources: requestedSources, context } = inputResult.value;
  const questionIds = new Set(questions.map((q) => q.id));

  const adapter = deps.adapter;
  if (!adapter || typeof adapter.retrieve !== "function") {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: [
        adapterError("adapter", "ADAPTER_MALFORMED_RESPONSE", "Evidence adapter does not implement retrieve()"),
      ],
    });
  }
  const supported = Array.isArray(adapter.supportedSources) ? adapter.supportedSources : null;

  const errors = [];
  const warnings = [];
  const sourceResults = [];
  const accepted = [];

  for (const sourceId of requestedSources) {
    if (supported && !supported.includes(sourceId)) {
      errors.push(
        adapterError(sourceId, "UNSUPPORTED_SOURCE", `Adapter "${adapter.name ?? "unnamed"}" cannot serve "${sourceId}".`),
      );
      sourceResults.push({ source: sourceId, outcome: SOURCE_OUTCOME.UNSUPPORTED, record_count: 0 });
      continue;
    }

    let response;
    try {
      response = await adapter.retrieve({ account_id: accountId, questions, source_type: sourceId, context });
    } catch (error) {
      errors.push(
        adapterError(
          sourceId,
          "ADAPTER_UNAVAILABLE",
          `${sourceId} adapter threw: ${error instanceof Error ? error.message : "unknown error"}`,
          { thrown: true },
        ),
      );
      sourceResults.push({ source: sourceId, outcome: SOURCE_OUTCOME.UNAVAILABLE, record_count: 0 });
      continue;
    }

    const envelopeProblem = resultProblems(response);
    if (envelopeProblem) {
      errors.push(adapterError(sourceId, envelopeProblem.code, envelopeProblem.message));
      sourceResults.push({ source: sourceId, outcome: SOURCE_OUTCOME.MALFORMED, record_count: 0 });
      continue;
    }

    if (response.ok === false) {
      const { code, message, retryable } = response.error;
      errors.push({ code, message, retryable: retryable === true, details: { source: sourceId } });
      const outcome = {
        ADAPTER_UNAUTHORIZED: SOURCE_OUTCOME.UNAUTHORIZED,
        ADAPTER_UNAVAILABLE: SOURCE_OUTCOME.UNAVAILABLE,
        UNSUPPORTED_SOURCE: SOURCE_OUTCOME.UNSUPPORTED,
      }[code] ?? SOURCE_OUTCOME.MALFORMED;
      sourceResults.push({ source: sourceId, outcome, record_count: 0 });
      continue;
    }

    // Record-level validation: reject malformed records, keep valid ones.
    const expected = { sourceId, accountId, questionIds };
    const valid = [];
    let rejected = 0;
    let unknownClassification = 0;
    for (const [index, record] of response.records.entries()) {
      // Classify before anything else: a record whose access classification is
      // unrecognized is never treated as public and never inspected further.
      // Its identifier, title, content, and metadata are not reported.
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        const classification = record.access_classification;
        if (typeof classification === "string" && !isKnownClassification(classification)) {
          unknownClassification += 1;
          continue;
        }
      }

      const problems = recordProblems(record, expected);
      if (problems.length > 0) {
        rejected += 1;
        errors.push({
          code: "ADAPTER_MALFORMED_RESPONSE",
          message: `${sourceId} returned a malformed record that was rejected.`,
          retryable: false,
          details: {
            source: sourceId,
            record_index: index,
            problems: sanitizeProblems(problems).slice(0, 10),
          },
        });
        continue;
      }
      valid.push(record);
    }

    const classification = filterByClassification(valid, context.permitted_classifications);
    const withheldTotal = classification.withheld + unknownClassification;
    if (classification.withheld > 0) {
      warnings.push({
        code: "RECORDS_WITHHELD",
        message: `${classification.withheld} ${sourceId} record(s) were withheld because their access classification exceeds the caller's permission.`,
      });
    }
    if (unknownClassification > 0) {
      warnings.push({
        code: "UNRECOGNIZED_CLASSIFICATION_WITHHELD",
        message: `${unknownClassification} ${sourceId} record(s) were withheld because their access classification is not recognized.`,
      });
    }
    if (withheldTotal > 0) {
      errors.push({
        code: "CLASSIFICATION_RESTRICTED",
        message: `${withheldTotal} ${sourceId} record(s) were withheld by the access classification policy.`,
        retryable: false,
        // Aggregate only: no record identifier, title, content, or metadata.
        details: { source: sourceId, withheld_count: withheldTotal },
      });
    }
    // A source that returned any rejected, withheld, or unrecognized record is
    // not a clean source, even when some records survived.
    const retained = retainedCount(response.records.length, rejected);
    const outcome =
      rejected > 0 || withheldTotal > 0
        ? SOURCE_OUTCOME.MALFORMED
        : retained === 0
          ? SOURCE_OUTCOME.EMPTY
          : SOURCE_OUTCOME.OK;
    sourceResults.push({
      source: sourceId,
      outcome,
      record_count: classification.kept.length,
      retained_count: retained,
      rejected_count: rejected,
      ...(withheldTotal > 0 ? { withheld_count: withheldTotal } : {}),
    });
    accepted.push(...classification.kept);
  }

  const records = dedupeRecords(accepted).sort(compareRecords);
  const cleanCount = sourceResults.filter(
    (result) => result.outcome === SOURCE_OUTCOME.OK || result.outcome === SOURCE_OUTCOME.EMPTY,
  ).length;
  // A degraded source counts as usable only if the caller actually received at
  // least one record from it. `retained_count` stays available for reporting the
  // difference between "nothing came back" and "everything was withheld".
  const degradedCount = sourceResults.filter(
    (result) => result.outcome === SOURCE_OUTCOME.MALFORMED && result.record_count > 0,
  ).length;
  const status = deriveStatus({
    cleanCount,
    degradedCount,
    failureCodes: errors.map((error) => error.code),
    total: sourceResults.length,
  });
  const okCount = cleanCount + degradedCount;

  if (records.length === 0 && status !== "failed") {
    warnings.push({
      code: "NO_RECORDS_RETRIEVED",
      message: "No source records were retrieved from the requested sources. This does not mean the information does not exist.",
    });
  }
  if (errors.length > 0 && status !== "failed") {
    warnings.push({
      code: "PARTIAL_SOURCES",
      message: `${sourceResults.length - okCount} of ${sourceResults.length} requested sources did not return usable records; see source_results and errors.`,
    });
  }

  return envelope({
    status,
    data: {
      account_id: accountId,
      requested_sources: requestedSources,
      question_ids: [...questionIds],
      records,
      source_results: sourceResults,
      record_count: records.length,
    },
    startedAt,
    errors,
    warnings,
  });
}

export default retrieveEvidence;
