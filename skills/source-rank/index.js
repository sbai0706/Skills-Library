import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { validateInput } from "./validate-input.js";
import { ageInDays, formatTimestamp, parseTimestamp } from "./timestamps.js";

export const SKILL_NAME = "source.rank";
export const SKILL_VERSION = "0.1.0";

/** Per-item timestamp precedence, highest first. Mirrored in SKILL.md and skill.yaml. */
export const TIMESTAMP_PRECEDENCE = Object.freeze(["published_at", "occurred_at", "retrieved_at"]);

/** Fields that describe the data itself; retrieved_at only describes when it was fetched. */
const DATA_FIELDS = Object.freeze(["published_at", "occurred_at"]);

/** Placeholder so the strict schema can validate everything except the timestamps. */
const PLACEHOLDER_TIMESTAMP = "1970-01-01T00:00:00Z";

/** Dated ranks before retrieval-fallback ranks before unknown. */
const TIER = Object.freeze({ dated: 0, retrieval_fallback: 1, unknown: 2 });

const trace = () => "trace_" + randomUUID();

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function envelope({ status, data, startedAt, finishedAt, errors = [], warnings = [], evidenceIds = [] }) {
  const result = {
    skill: SKILL_NAME,
    skill_version: SKILL_VERSION,
    status,
    data,
    evidence_ids: evidenceIds,
    warnings,
    errors,
    trace_id: trace(),
    started_at: startedAt,
    finished_at: finishedAt ?? new Date().toISOString(),
  };
  const { valid, errors: schemaErrors } = validate("skillResult", result);
  if (!valid) {
    throw new Error("source.rank produced an invalid envelope: " + JSON.stringify(schemaErrors));
  }
  return result;
}

function clockFrom(deps, inputNow) {
  const supplied = typeof inputNow === "string" ? parseTimestamp(inputNow) : null;
  if (supplied !== null) return { ms: supplied, provided: true };
  const fromDeps = deps.now?.()?.getTime?.();
  if (Number.isFinite(fromDeps)) return { ms: fromDeps, provided: true };
  return { ms: Date.now(), provided: false };
}

/** Validate an item against its shared schema with the three timestamp fields neutralised. */
function structuralProblems(schemaName, item) {
  const copy = { ...item, retrieved_at: PLACEHOLDER_TIMESTAMP };
  for (const field of DATA_FIELDS) {
    if (Object.hasOwn(copy, field)) copy[field] = null;
  }
  return validate(schemaName, copy).errors.map((problem) => problem.path);
}

function readTimestamps(item) {
  const parsed = {};
  let invalid = 0;
  for (const field of TIMESTAMP_PRECEDENCE) {
    const value = item[field];
    if (value === undefined || value === null) continue;
    const ms = parseTimestamp(value);
    if (ms === null) invalid += 1;
    else parsed[field] = ms;
  }
  let data = null;
  for (const field of DATA_FIELDS) {
    if (Object.hasOwn(parsed, field)) {
      data = { field, ms: parsed[field] };
      break;
    }
  }
  return { data, retrievedMs: parsed.retrieved_at ?? null, invalid };
}

function sourceIdentity(item, linkedIdentity) {
  if (linkedIdentity) return linkedIdentity;
  const provider = item.metadata?.provider;
  if (typeof provider === "string" && provider.trim() !== "") {
    return { id: provider.trim(), basis: "metadata.provider" };
  }
  return { id: `source_type:${item.source_type}`, basis: "source_type" };
}

/**
 * Split one input array into account-scoped accepted items, a foreign-account count, and rejections.
 * Account scope is checked first, so a foreign item is never inspected further or ranked.
 */
function screenItems(kind, items, { accountId, idField, schemaName }) {
  const accepted = [];
  const rejections = [];
  let foreign = 0;

  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      rejections.push({ kind, index, reason: "malformed", paths: ["/"] });
      return;
    }
    if (typeof item.account_id === "string" && item.account_id !== accountId) {
      foreign += 1;
      return;
    }
    const paths = structuralProblems(schemaName, item);
    if (paths.length > 0) {
      rejections.push({ kind, index, reason: "malformed", paths: [...new Set(paths)].sort() });
      return;
    }
    accepted.push({ kind, index, id: item[idField], item });
  });

  return { accepted, rejections, foreign };
}

/** Reject every item that shares an ID with another accepted item of the same kind. */
function rejectDuplicateIds(accepted, rejections) {
  const counts = new Map();
  for (const entry of accepted) {
    const key = `${entry.kind}\u0000${entry.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return accepted.filter((entry) => {
    if (counts.get(`${entry.kind}\u0000${entry.id}`) === 1) return true;
    rejections.push({ kind: entry.kind, index: entry.index, reason: "duplicate_id", id: entry.id });
    return false;
  });
}

function summarizeGroup(group, nowMs) {
  const dataEntries = group.entries.filter((entry) => entry.times.data !== null);
  const retrievedEntries = group.entries.filter((entry) => entry.times.retrievedMs !== null);

  let recency = "unknown";
  let latestMs = null;
  let field = null;
  let supporting = [];

  if (dataEntries.length > 0) {
    recency = "dated";
    latestMs = Math.max(...dataEntries.map((entry) => entry.times.data.ms));
    supporting = dataEntries.filter((entry) => entry.times.data.ms === latestMs);
    const fields = new Set(supporting.map((entry) => entry.times.data.field));
    field = DATA_FIELDS.find((candidate) => fields.has(candidate));
  } else if (retrievedEntries.length > 0) {
    recency = "retrieval_fallback";
    latestMs = Math.max(...retrievedEntries.map((entry) => entry.times.retrievedMs));
    supporting = retrievedEntries.filter((entry) => entry.times.retrievedMs === latestMs);
    field = "retrieved_at";
  }

  const idsOf = (kind) =>
    supporting.filter((entry) => entry.kind === kind).map((entry) => entry.id).sort();

  return {
    rank: null,
    source_id: group.identity.id,
    source_id_basis: group.identity.basis,
    source_types: [...new Set(group.entries.map((entry) => entry.item.source_type))].sort(),
    recency,
    latest_data_at: latestMs === null ? null : formatTimestamp(latestMs),
    latest_data_at_field: field,
    age_days: latestMs === null ? null : ageInDays(latestMs, nowMs),
    record_count: group.entries.length,
    supporting_record_ids: idsOf("record"),
    supporting_evidence_ids: idsOf("evidence"),
    tied_with: [],
    invalid_timestamp_count: group.entries.reduce((sum, entry) => sum + entry.times.invalid, 0),
    _latestMs: latestMs,
  };
}

function orderAndRank(sources) {
  sources.sort(
    (left, right) =>
      TIER[left.recency] - TIER[right.recency] ||
      (right._latestMs ?? 0) - (left._latestMs ?? 0) ||
      compareText(left.source_id, right.source_id) ||
      compareText(left.source_id_basis, right.source_id_basis),
  );

  let rank = 0;
  for (const source of sources) {
    if (source.recency !== "unknown") source.rank = ++rank;
  }

  const byInstant = new Map();
  for (const source of sources) {
    if (source.recency === "unknown") continue;
    const key = `${source.recency}\u0000${source._latestMs}`;
    byInstant.set(key, [...(byInstant.get(key) ?? []), source]);
  }
  for (const peers of byInstant.values()) {
    if (peers.length < 2) continue;
    for (const source of peers) {
      source.tied_with = [
        ...new Set(peers.filter((peer) => peer !== source).map((peer) => peer.source_id)),
      ].sort(compareText);
    }
  }
  return sources;
}

function rejectionError(rejection) {
  const details = {
    array: rejection.kind === "record" ? "records" : "evidence",
    index: rejection.index,
    reason: rejection.reason,
  };
  if (rejection.paths) details.paths = rejection.paths;
  if (rejection.id) details.id = rejection.id;
  return {
    code: "INVALID_INPUT",
    message:
      rejection.reason === "duplicate_id"
        ? "An item shares its ID with another item and was not ranked."
        : "An item failed schema validation and was not ranked.",
    retryable: false,
    details,
  };
}

function foreignWarning(foreign) {
  return {
    code: "FOREIGN_ACCOUNT_RECORDS_EXCLUDED",
    message: `${foreign} item(s) belong to a different account and were excluded; they are not ranked.`,
  };
}

function unresolvedLinkWarning(count) {
  return {
    code: "SOURCE_RECORD_LINK_UNRESOLVED",
    message: `${count} evidence item(s) name a source_record_id that is not an accepted record of this request (absent, rejected, duplicate or foreign) and were excluded; they are not ranked.`,
  };
}

function buildWarnings({ foreign, unresolvedLinks, rejections, invalidTimestamps, sources, nowMs }) {
  const warnings = [];
  if (foreign > 0) warnings.push(foreignWarning(foreign));
  if (unresolvedLinks > 0) warnings.push(unresolvedLinkWarning(unresolvedLinks));
  if (rejections.length > 0) {
    warnings.push({
      code: "RECORDS_REJECTED",
      message: `${rejections.length} item(s) were malformed or had duplicate IDs and were not ranked; see errors for safe reasons.`,
    });
  }
  if (invalidTimestamps > 0) {
    warnings.push({
      code: "INVALID_TIMESTAMP_IGNORED",
      message: `${invalidTimestamps} timestamp value(s) could not be parsed and were treated as missing.`,
    });
  }
  const typeFallback = sources.filter((source) => source.source_id_basis === "source_type").length;
  if (typeFallback > 0) {
    warnings.push({
      code: "SOURCE_ID_FALLBACK",
      message: `${typeFallback} source(s) had no metadata.provider and were grouped by source_type, which is a coarser identifier.`,
    });
  }
  const retrieval = sources.filter((source) => source.recency === "retrieval_fallback").length;
  if (retrieval > 0) {
    warnings.push({
      code: "RETRIEVAL_TIME_FALLBACK",
      message: `${retrieval} source(s) had only retrieved_at; their latest timestamp shows when data was fetched, not how recent the data is, and they are ranked after data-dated sources.`,
    });
  }
  const unknown = sources.filter((source) => source.recency === "unknown").length;
  if (unknown > 0) {
    warnings.push({
      code: "RECENCY_UNKNOWN",
      message: `${unknown} source(s) have no usable timestamp and are listed after the dated sources without a rank.`,
    });
  }
  const tied = sources.filter((source) => source.tied_with.length > 0).length;
  if (tied > 0) {
    warnings.push({
      code: "RECENCY_TIE",
      message: `${tied} source(s) share the same latest timestamp with another source; ties are ordered by source_id ascending.`,
    });
  }
  const future = sources.filter((source) => source._latestMs !== null && source._latestMs > nowMs).length;
  if (future > 0) {
    warnings.push({
      code: "FUTURE_TIMESTAMP",
      message: `${future} source(s) have a latest timestamp later than now; age_days is negative for them.`,
    });
  }
  return warnings;
}

/**
 * Rank the evidence sources of one account by how recent their data is.
 *
 * Recency ordering only: no reliability, authority or quality judgement is made. Deterministic; the
 * system clock is read only when neither `input.now` nor `deps.now` is supplied.
 *
 * @param {{account_id: string, records?: object[], evidence?: object[], now?: string}} input
 * @param {{now?: () => Date}} [deps]
 * @returns {object} skill result envelope
 */
export function rankSources(input, deps = {}) {
  const clock = clockFrom(deps, input?.now);
  const startedAt = new Date(clock.ms).toISOString();
  const finishedAt = () => (clock.provided ? startedAt : undefined);

  const inputResult = validateInput(input);
  if (!inputResult.ok) {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      finishedAt: finishedAt(),
      errors: inputResult.errors,
    });
  }

  const { account_id: accountId, records, evidence } = inputResult.value;

  const recordScreen = screenItems("record", records, {
    accountId,
    idField: "record_id",
    schemaName: "sourceRecord",
  });
  const evidenceScreen = screenItems("evidence", evidence, {
    accountId,
    idField: "claim_id",
    schemaName: "evidence",
  });

  const foreign = recordScreen.foreign + evidenceScreen.foreign;
  const rejections = [...recordScreen.rejections, ...evidenceScreen.rejections];
  const screened = rejectDuplicateIds([...recordScreen.accepted, ...evidenceScreen.accepted], rejections);
  rejections.sort((left, right) => compareText(left.kind, right.kind) || left.index - right.index);

  const recordIdentity = new Map();
  for (const entry of screened) {
    if (entry.kind === "record") recordIdentity.set(entry.id, sourceIdentity(entry.item, null));
  }

  // Evidence that names a source record which is not an accepted record of this request has no
  // trustworthy source identity: it is excluded and counted, never regrouped by source_type.
  const hasUnresolvedLink = (entry) =>
    entry.kind === "evidence" &&
    typeof entry.item.source_record_id === "string" &&
    !recordIdentity.has(entry.item.source_record_id);
  const accepted = screened.filter((entry) => !hasUnresolvedLink(entry));
  const unresolvedLinks = screened.length - accepted.length;

  if (accepted.length === 0) {
    const errors = rejections.map(rejectionError);
    const warnings = [];
    if (foreign > 0) {
      errors.push({
        code: "ACCOUNT_SCOPE_MISMATCH",
        message: "No supplied item belongs to the requested account.",
        retryable: false,
        details: { excluded_foreign_account: foreign },
      });
      warnings.push(foreignWarning(foreign));
    }
    if (unresolvedLinks > 0) warnings.push(unresolvedLinkWarning(unresolvedLinks));
    if (errors.length === 0) {
      errors.push({
        code: "EVIDENCE_REFERENCE_UNAVAILABLE",
        message: "No usable records or evidence were supplied to rank.",
        retryable: false,
      });
    }
    return envelope({
      status: "blocked",
      data: null,
      startedAt,
      finishedAt: finishedAt(),
      errors,
      warnings,
    });
  }

  const groups = new Map();
  for (const entry of accepted) {
    const linked =
      entry.kind === "evidence" && typeof entry.item.source_record_id === "string"
        ? recordIdentity.get(entry.item.source_record_id)
        : undefined; // always resolved here: unresolved links were excluded above
    const identity = sourceIdentity(entry.item, linked);
    const key = `${identity.basis}\u0000${identity.id}`;
    if (!groups.has(key)) groups.set(key, { identity, entries: [] });
    groups.get(key).entries.push({ ...entry, times: readTimestamps(entry.item) });
  }

  const sources = orderAndRank([...groups.values()].map((group) => summarizeGroup(group, clock.ms)));
  const invalidTimestamps = sources.reduce((sum, source) => sum + source.invalid_timestamp_count, 0);

  const countRecency = (recency) => sources.filter((source) => source.recency === recency).length;
  const data = {
    account_id: accountId,
    now: formatTimestamp(clock.ms),
    ranking_basis: "data_recency_only",
    timestamp_precedence: [...TIMESTAMP_PRECEDENCE],
    sources: sources.map(({ _latestMs, ...source }) => source),
    summary_counts: {
      sources: sources.length,
      data_dated: countRecency("dated"),
      retrieval_fallback: countRecency("retrieval_fallback"),
      recency_unknown: countRecency("unknown"),
      records_accepted: accepted.length,
      records_excluded_foreign_account: foreign,
      records_rejected: rejections.length,
      invalid_timestamps: invalidTimestamps,
    },
  };

  const dataCheck = validate("sourceRankResult", data);
  if (!dataCheck.valid) {
    throw new Error("source.rank produced an invalid result: " + JSON.stringify(dataCheck.errors));
  }

  const evidenceIds = [
    ...new Set(data.sources.flatMap((source) => source.supporting_evidence_ids)),
  ].sort();
  const partial = rejections.length > 0 || unresolvedLinks > 0 || countRecency("unknown") > 0;

  return envelope({
    status: partial ? "partial" : "success",
    data,
    startedAt,
    finishedAt: finishedAt(),
    errors: rejections.map(rejectionError),
    warnings: buildWarnings({ foreign, unresolvedLinks, rejections, invalidTimestamps, sources, nowMs: clock.ms }),
    evidenceIds,
  });
}

export default rankSources;
