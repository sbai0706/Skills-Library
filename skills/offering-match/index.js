import { validate } from "../../schemas/index.js";
import { loadAccountIntelligenceReferences } from "../../reference/account-intelligence.js";
import {
  failedSkill,
  referenceEntries,
  resolveClaimIds,
  skillResult,
  startedAt,
  visibleClaims,
} from "../account-intelligence/common.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "offering.match";
export const SKILL_VERSION = "0.1.0";

const RATIONALE =
  "Caller-supplied mapping only; cited evidence records account activity, not offering fit.";
const DISCOVERY_QUESTIONS = Object.freeze([
  "What outcome and constraints should be used to assess fit?",
  "What scope, responsibilities, timeline, and measures of success should be confirmed?",
]);

function fail(started, code, message) {
  return failedSkill(SKILL_NAME, started, code, message);
}

function validateSignals(signals, accountId, claimIndex, withheldIds, taxonomyEntries) {
  if (signals === undefined) return { ok: true, byId: new Set() };
  if (!validate("signalResult", signals).valid || signals.account_id !== accountId) {
    return { ok: false, code: "ACCOUNT_SCOPE_MISMATCH", message: "Supplied signals must belong to the requested account." };
  }
  if (signals.signals.length > 0 && !taxonomyEntries) {
    return { ok: false, code: "REFERENCE_INVALID", message: "A valid versioned signal vocabulary is required for supplied signals." };
  }

  const byId = new Set();
  for (const signal of signals.signals) {
    if (!taxonomyEntries.has(signal.signal_type_id)) {
      return { ok: false, code: "UNKNOWN_REFERENCE_ID", message: "A supplied signal references an unknown vocabulary ID." };
    }
    const references = resolveClaimIds(signal.claim_ids, claimIndex, withheldIds);
    if (!references.ok || signal.evidence_ids.length !== references.ids.length ||
        references.ids.some((id) => !signal.evidence_ids.includes(id)) || byId.has(signal.signal_id)) {
      return { ok: false, code: "INVALID_INPUT", message: "Supplied signal references are inconsistent." };
    }
    byId.add(signal.signal_id);
  }
  return { ok: true, byId };
}

export function matchOfferings(input, deps = {}) {
  const started = startedAt(deps);
  const inputResult = validateInput(input);
  if (!inputResult.ok) return fail(started, inputResult.code, inputResult.message);

  const value = inputResult.value;
  const claimResult = visibleClaims(value.account_id, value.claims, value.classification_ceiling);
  if (!claimResult.ok) return fail(started, claimResult.code, claimResult.message);

  let registry;
  try {
    registry = deps.referenceRegistry ?? loadAccountIntelligenceReferences();
  } catch {
    return fail(started, "REFERENCE_UNAVAILABLE", "The offering reference vocabulary could not be loaded.");
  }
  const offerings = referenceEntries(registry.offerings, "offerings");
  if (value.annotations.length > 0 && !offerings.ok) {
    return fail(started, "REFERENCE_INVALID", "A valid versioned offering vocabulary is required for mapped offerings.");
  }
  const taxonomy = referenceEntries(registry.signalTaxonomy, "signals");
  const signalResult = validateSignals(
    value.signals,
    value.account_id,
    claimResult.byId,
    claimResult.withheldIds,
    taxonomy.ok ? taxonomy.entries : null,
  );
  if (!signalResult.ok) return fail(started, signalResult.code, signalResult.message);

  const matches = [];
  const seen = new Set();
  for (const annotation of value.annotations) {
    const offering = offerings.entries.get(annotation.offering_id);
    if (!offering) {
      return fail(started, "UNKNOWN_REFERENCE_ID", "An offering mapping references an unknown vocabulary ID.");
    }

    const evidence = resolveClaimIds(annotation.claim_ids, claimResult.byId, claimResult.withheldIds);
    if (!evidence.ok) return fail(started, evidence.code, evidence.message);
    const signalIds = [...(annotation.signal_ids ?? [])].sort();
    if (signalIds.some((id) => !signalResult.byId.has(id))) {
      return fail(started, "SIGNAL_REFERENCE_UNAVAILABLE", "An offering mapping references a signal unavailable in this result.");
    }

    const signature = JSON.stringify([annotation.offering_id, evidence.ids, signalIds]);
    if (seen.has(signature)) {
      return fail(started, "INVALID_INPUT", "Offering mappings must be unique.");
    }
    seen.add(signature);

    const uncertainties = ["No offering-specific fit criteria or customer priorities were supplied."];
    if (registry.offerings.status !== "approved" ||
        offering.review_status === "placeholder_business_review_required") {
      uncertainties.unshift("The offering vocabulary or entry is provisional and requires business review.");
    }
    if (evidence.ids.some((id) => claimResult.byId.get(id).verification_status === "conflicting")) {
      uncertainties.push("At least one cited claim is marked as conflicting; it has not been resolved.");
    }

    matches.push({
      offering_id: annotation.offering_id,
      match_status: "candidate_hypothesis",
      rationale: RATIONALE,
      uncertainties,
      discovery_questions: [...DISCOVERY_QUESTIONS],
      claim_ids: evidence.ids,
      evidence_ids: evidence.ids,
      signal_ids: signalIds,
    });
  }

  matches.sort((left, right) =>
    left.offering_id.localeCompare(right.offering_id) ||
    left.claim_ids.join("\u0000").localeCompare(right.claim_ids.join("\u0000")),
  );
  const data = { account_id: value.account_id, matches };
  const result = validate("offeringMatch", data);
  if (!result.valid) throw new Error(`offering.match produced invalid data: ${JSON.stringify(result.errors)}`);

  const evidenceIds = [...new Set(matches.flatMap((item) => item.evidence_ids))].sort();
  const conflictsPresent = evidenceIds.some(
    (id) => claimResult.byId.get(id).verification_status === "conflicting",
  );
  return skillResult({
    skill: SKILL_NAME,
    status: "success",
    data,
    started,
    evidenceIds,
    warnings: conflictsPresent
      ? [{ code: "CONFLICTED_EVIDENCE", message: "Mapped evidence includes unresolved conflicting claims." }]
      : [],
  });
}

export default matchOfferings;
