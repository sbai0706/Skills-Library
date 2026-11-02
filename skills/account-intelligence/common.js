import { createHash, randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";

export const CLASSIFICATION_RANK = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
});

const SEMVER = /^\d+\.\d+\.\d+$/;

export function startedAt(deps) {
  return (deps.now?.() ?? new Date()).toISOString();
}

export function stableId(prefix, components) {
  const digest = createHash("sha256").update(JSON.stringify(components)).digest("hex").slice(0, 20);
  return `${prefix}_${digest}`;
}

export function visibleClaims(accountId, claims, ceiling) {
  const ceilingRank = CLASSIFICATION_RANK[ceiling];
  if (!Array.isArray(claims) || ceilingRank === undefined) {
    return { ok: false, code: "INVALID_INPUT", message: "Normalized claims and a valid classification ceiling are required." };
  }

  const byId = new Map();
  const withheldIds = new Set();
  for (const claim of claims) {
    if (!validate("evidence", claim).valid) {
      return { ok: false, code: "INVALID_INPUT", message: "A normalized claim is invalid." };
    }
    if (claim.account_id !== accountId) {
      return { ok: false, code: "ACCOUNT_SCOPE_MISMATCH", message: "Normalized claims must belong to the requested account." };
    }
    if (byId.has(claim.claim_id)) {
      return { ok: false, code: "INVALID_INPUT", message: "Normalized claim identifiers must be unique." };
    }
    if (CLASSIFICATION_RANK[claim.access_classification] <= ceilingRank) {
      byId.set(claim.claim_id, claim);
    } else {
      withheldIds.add(claim.claim_id);
    }
  }
  return { ok: true, byId, withheldIds };
}

export function resolveClaimIds(ids, claimIndex, withheldIds = new Set()) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length) {
    return { ok: false, code: "INVALID_INPUT", message: "A mapping must contain unique normalized claim references." };
  }
  if (ids.some((id) => !claimIndex.has(id))) {
    if (ids.some((id) => withheldIds.has(id))) {
      return {
        ok: false,
        code: "CLASSIFICATION_RESTRICTED",
        message: "A mapping references evidence above the output classification ceiling.",
      };
    }
    return {
      ok: false,
      code: "EVIDENCE_REFERENCE_UNAVAILABLE",
      message: "A mapping references evidence unavailable in this account and classification scope.",
    };
  }
  return { ok: true, ids: [...ids].sort() };
}

export function referenceEntries(document, key) {
  if (!document || typeof document.version !== "string" || !SEMVER.test(document.version) ||
      !Array.isArray(document[key])) {
    return { ok: false };
  }

  const entries = new Map();
  for (const entry of document[key]) {
    if (typeof entry?.id !== "string" || entry.id === "" ||
        typeof entry.label !== "string" || entry.label === "" || entries.has(entry.id)) {
      return { ok: false };
    }
    entries.set(entry.id, entry);
  }
  return { ok: true, document, entries };
}

export function safeReferenceStatus(document, entriesKey) {
  const registry = referenceEntries(document, entriesKey);
  if (!registry.ok || registry.entries.size === 0) {
    return { version: null, status: "unknown" };
  }
  return {
    version: document.version,
    status: document?.status === "approved" || document?.status === "provisional"
      ? document.status
      : "unknown",
  };
}

export function skillResult({ skill, status, data, started, evidenceIds = [], errors = [], warnings = [] }) {
  const result = {
    skill,
    skill_version: "0.1.0",
    status,
    data,
    evidence_ids: evidenceIds,
    warnings,
    errors,
    trace_id: `trace_${randomUUID()}`,
    started_at: started,
    finished_at: new Date().toISOString(),
  };
  const validation = validate("skillResult", result);
  if (!validation.valid) {
    throw new Error(`${skill} produced an invalid result envelope: ${JSON.stringify(validation.errors)}`);
  }
  return result;
}

export function failedSkill(skill, started, code, message) {
  return skillResult({
    skill,
    status: "failed",
    data: null,
    started,
    errors: [{ code, message, retryable: false }],
  });
}

export function validateSkillInput(schemaName, input) {
  const result = validate(schemaName, input);
  if (!result.valid) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Input does not validate against the skill contract.",
    };
  }
  return { ok: true, value: input };
}
