import { validate } from "../../schemas/index.js";
import { loadAccountIntelligenceReferences } from "../../reference/account-intelligence.js";
import {
  failedSkill,
  referenceEntries,
  resolveClaimIds,
  safeReferenceStatus,
  skillResult,
  stableId,
  startedAt,
  visibleClaims,
} from "../account-intelligence/common.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "signal.extract";
export const SKILL_VERSION = "0.1.0";

function fail(started, code, message) {
  return failedSkill(SKILL_NAME, started, code, message);
}

export function extractSignals(input, deps = {}) {
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
    return fail(started, "REFERENCE_UNAVAILABLE", "The signal reference vocabulary could not be loaded.");
  }
  const taxonomy = referenceEntries(registry.signalTaxonomy, "signals");
  if (value.annotations.length > 0 && !taxonomy.ok) {
    return fail(started, "REFERENCE_INVALID", "A valid versioned signal vocabulary is required for mapped signals.");
  }

  const signals = [];
  const seen = new Set();
  for (const annotation of value.annotations) {
    if (!taxonomy.entries.has(annotation.signal_type_id)) {
      return fail(started, "UNKNOWN_REFERENCE_ID", "A signal mapping references an unknown vocabulary ID.");
    }

    const evidence = resolveClaimIds(annotation.claim_ids, claimResult.byId, claimResult.withheldIds);
    if (!evidence.ok) return fail(started, evidence.code, evidence.message);

    const signature = JSON.stringify([
      annotation.signal_type_id,
      evidence.ids,
      annotation.observed_at ?? null,
    ]);
    if (seen.has(signature)) {
      return fail(started, "INVALID_INPUT", "Signal mappings must be unique.");
    }
    seen.add(signature);
    signals.push({
      signal_id: stableId("sig", [value.account_id, signature]),
      signal_type_id: annotation.signal_type_id,
      claim_ids: evidence.ids,
      evidence_ids: evidence.ids,
      ...(Object.hasOwn(annotation, "observed_at") ? { observed_at: annotation.observed_at } : {}),
    });
  }

  signals.sort((left, right) => left.signal_id.localeCompare(right.signal_id));
  const data = { account_id: value.account_id, signals };
  const result = validate("signalResult", data);
  if (!result.valid) throw new Error(`signal.extract produced invalid data: ${JSON.stringify(result.errors)}`);

  const evidenceIds = [...new Set(signals.flatMap((signal) => signal.evidence_ids))].sort();
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

export default extractSignals;
