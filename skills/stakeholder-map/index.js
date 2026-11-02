import { validate } from "../../schemas/index.js";
import { loadAccountIntelligenceReferences } from "../../reference/account-intelligence.js";
import {
  failedSkill,
  referenceEntries,
  resolveClaimIds,
  skillResult,
  stableId,
  startedAt,
  visibleClaims,
} from "../account-intelligence/common.js";
import { validateInput } from "./validate-input.js";

export const SKILL_NAME = "stakeholder.map";
export const SKILL_VERSION = "0.1.0";

function fail(started, code, message) {
  return failedSkill(SKILL_NAME, started, code, message);
}

export function mapStakeholders(input, deps = {}) {
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
    return fail(started, "REFERENCE_UNAVAILABLE", "The persona reference vocabulary could not be loaded.");
  }
  const personas = referenceEntries(registry.personas, "personas");
  if (value.annotations.length > 0 && !personas.ok) {
    return fail(started, "REFERENCE_INVALID", "A valid versioned persona vocabulary is required for mapped stakeholders.");
  }

  const stakeholders = [];
  const seen = new Set();
  for (const annotation of value.annotations) {
    if (!personas.entries.has(annotation.persona_id)) {
      return fail(started, "UNKNOWN_REFERENCE_ID", "A stakeholder mapping references an unknown persona ID.");
    }

    const evidence = resolveClaimIds(annotation.claim_ids, claimResult.byId, claimResult.withheldIds);
    if (!evidence.ok) return fail(started, evidence.code, evidence.message);

    const evidenceSupportsMapping = evidence.ids.some((id) => {
      const excerpt = claimResult.byId.get(id).excerpt;
      return excerpt.includes(annotation.display_name) && excerpt.includes(annotation.role_evidence);
    });
    if (!evidenceSupportsMapping) {
      return fail(started, "UNSUPPORTED_MAPPING", "A stakeholder name and role must appear in cited evidence.");
    }

    const signature = JSON.stringify([
      annotation.display_name,
      annotation.persona_id,
      annotation.role_evidence,
      evidence.ids,
    ]);
    if (seen.has(signature)) {
      return fail(started, "INVALID_INPUT", "Stakeholder mappings must be unique.");
    }
    seen.add(signature);
    stakeholders.push({
      stakeholder_id: stableId("stkh", [value.account_id, signature]),
      display_name: annotation.display_name,
      role_evidence: annotation.role_evidence,
      persona_id: annotation.persona_id,
      claim_ids: evidence.ids,
      evidence_ids: evidence.ids,
    });
  }

  stakeholders.sort((left, right) => left.stakeholder_id.localeCompare(right.stakeholder_id));
  const data = { account_id: value.account_id, stakeholders };
  const result = validate("stakeholderMap", data);
  if (!result.valid) throw new Error(`stakeholder.map produced invalid data: ${JSON.stringify(result.errors)}`);

  const evidenceIds = [...new Set(stakeholders.flatMap((item) => item.evidence_ids))].sort();
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

export default mapStakeholders;
