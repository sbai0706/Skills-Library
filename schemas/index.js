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
  signalResult: "signal-result.schema.json",
  stakeholderMap: "stakeholder-map.schema.json",
  offeringMatch: "offering-match.schema.json",
  firstMeetingBriefInputV2: "first-meeting-brief-input-v2.schema.json",
  accountIntelligenceAnnotations: "account-intelligence-annotations.schema.json",
  signalExtractInput: "signal-extract-input.schema.json",
  stakeholderMapInput: "stakeholder-map-input.schema.json",
  offeringMatchInput: "offering-match-input.schema.json",
  prepareFirstMeetingV2Input: "prepare-first-meeting-v2-input.schema.json",
  prepareFirstMeetingV2Result: "prepare-first-meeting-v2-result.schema.json",
  opportunityStrategyInput: "opportunity-strategy-input.schema.json",
  opportunityStrategyResult: "opportunity-strategy-result.schema.json",
  opportunityStrategyWorkflowInput: "opportunity-strategy-workflow-input.schema.json",
  opportunityStrategyWorkflowResult: "opportunity-strategy-workflow-result.schema.json",
  qualificationAssessInput: "qualification-assess-input.schema.json",
  qualificationAssessment: "qualification-assessment.schema.json",
  qualificationWorkflowInput: "qualification-workflow-input.schema.json",
  qualificationWorkflowResult: "qualification-workflow-result.schema.json",
  engagementDraftInput: "engagement-draft-input.schema.json",
  engagementDraftData: "engagement-draft-data.schema.json",
  prepareEngagementInput: "prepare-engagement-input.schema.json",
  prepareEngagementResult: "prepare-engagement-result.schema.json",
  workflowInput: "workflow-input.schema.json",
  workflowResult: "workflow-result.schema.json",
  mcpCapture: "mcp-capture.schema.json",
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

const ENRICHMENT_FIELDS = ["signals", "stakeholder_map", "offering_matches"];
const CLASSIFICATION_RANK = Object.freeze({ public: 0, internal: 1, confidential: 2 });
const REFERENCE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function addSemanticError(errors, path, message) {
  errors.push({ path, message });
}

function referenceIds(registryDocument, entriesKey, path, errors) {
  if (
    !registryDocument ||
    typeof registryDocument.version !== "string" ||
    !REFERENCE_VERSION_PATTERN.test(registryDocument.version) ||
    !Array.isArray(registryDocument[entriesKey])
  ) {
    addSemanticError(errors, path, "A versioned reference list is required for this enrichment.");
    return null;
  }

  const ids = registryDocument[entriesKey].map((entry) => entry?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    addSemanticError(errors, path, "The supplied reference list must contain unique stable IDs.");
    return null;
  }
  return new Set(ids);
}

function validateEvidenceReferences(item, path, claimsById, ceilingRank, errors) {
  const claimIds = new Set(item.claim_ids);
  const evidenceIds = new Set(item.evidence_ids);
  const equalSets =
    claimIds.size === evidenceIds.size && [...claimIds].every((claimId) => evidenceIds.has(claimId));

  if (!equalSets) {
    addSemanticError(errors, `${path}/evidence_ids`, "Evidence IDs must identify the same normalized claims as claim_ids.");
  }

  for (const [field, ids] of [["claim_ids", item.claim_ids], ["evidence_ids", item.evidence_ids]]) {
    if (ids.some((id) => !claimsById.has(id))) {
      addSemanticError(errors, `${path}/${field}`, "Every referenced ID must exist in the brief's normalized claims.");
    }
  }

  for (const id of claimIds) {
    const claim = claimsById.get(id);
    if (claim && CLASSIFICATION_RANK[claim.access_classification] > ceilingRank) {
      addSemanticError(errors, `${path}/evidence_ids`, "Linked evidence exceeds the output classification ceiling.");
      break;
    }
  }
}

/**
 * Validate the v2 brief structurally and, when enrichment fields are supplied,
 * check account scope, evidence references, versioned vocabularies, and the
 * enrichment visibility ceiling. This is not authorization and is not wired
 * into the v1 renderer; v2 consumers must call it before consuming enrichment.
 *
 * @param {object} value v2 brief input
 * @param {{referenceRegistry?: {signalTaxonomy?: object, personas?: object, offerings?: object}}} [options]
 * @returns {{valid: boolean, errors: {path: string, message: string}[]}}
 */
export function validateFirstMeetingBriefInputV2(value, { referenceRegistry } = {}) {
  const structural = validate("firstMeetingBriefInputV2", value);
  if (!structural.valid || !ENRICHMENT_FIELDS.some((field) => Object.hasOwn(value, field))) {
    return structural;
  }

  const errors = [];
  const accountId = value.account.account_id;
  const ceilingRank = CLASSIFICATION_RANK[value.classification_ceiling];
  const claimsById = new Map();
  const claimIds = new Set();

  if (value.gap_result.account_id !== accountId) {
    addSemanticError(errors, "/gap_result/account_id", "The gap result must belong to the brief account.");
  }

  value.claims.forEach((claim, index) => {
    if (claim.account_id !== accountId) {
      addSemanticError(errors, `/claims/${index}/account_id`, "Evidence must belong to the brief account.");
    }
    if (claimIds.has(claim.claim_id)) {
      addSemanticError(errors, "/claims", "Normalized claim IDs must be unique within the brief.");
    }
    claimIds.add(claim.claim_id);
    claimsById.set(claim.claim_id, claim);
  });

  value.gap_result.questions.forEach((question, index) => {
    question.supporting_evidence_ids.forEach((id) => {
      const claim = claimsById.get(id);
      if (!claim) {
        addSemanticError(
          errors,
          `/gap_result/questions/${index}/supporting_evidence_ids`,
          "Every gap evidence ID must exist in the brief's normalized claims.",
        );
      } else if (CLASSIFICATION_RANK[claim.access_classification] > ceilingRank) {
        addSemanticError(
          errors,
          `/gap_result/questions/${index}/supporting_evidence_ids`,
          "Gap evidence exceeds the output classification ceiling.",
        );
      }
    });
  });

  const signalIds = new Set();
  if (Object.hasOwn(value, "signals")) {
    if (value.signals.account_id !== accountId) {
      addSemanticError(errors, "/signals/account_id", "Signals must belong to the brief account.");
    }
    const signalTypeIds = value.signals.signals.length > 0
      ? referenceIds(referenceRegistry?.signalTaxonomy, "signals", "/referenceRegistry/signalTaxonomy", errors)
      : new Set();

    value.signals.signals.forEach((signal, index) => {
      const path = `/signals/signals/${index}`;
      if (signalIds.has(signal.signal_id)) {
        addSemanticError(errors, "/signals/signals", "Signal IDs must be unique within the brief.");
      }
      signalIds.add(signal.signal_id);
      if (signalTypeIds && !signalTypeIds.has(signal.signal_type_id)) {
        addSemanticError(errors, `${path}/signal_type_id`, "The signal type is not in the supplied versioned reference list.");
      }
      validateEvidenceReferences(signal, path, claimsById, ceilingRank, errors);
    });
  }

  if (Object.hasOwn(value, "stakeholder_map")) {
    if (value.stakeholder_map.account_id !== accountId) {
      addSemanticError(errors, "/stakeholder_map/account_id", "Stakeholders must belong to the brief account.");
    }
    const personaIds = value.stakeholder_map.stakeholders.length > 0
      ? referenceIds(referenceRegistry?.personas, "personas", "/referenceRegistry/personas", errors)
      : new Set();

    value.stakeholder_map.stakeholders.forEach((stakeholder, index) => {
      const path = `/stakeholder_map/stakeholders/${index}`;
      if (personaIds && !personaIds.has(stakeholder.persona_id)) {
        addSemanticError(errors, `${path}/persona_id`, "The persona is not in the supplied versioned reference list.");
      }
      validateEvidenceReferences(stakeholder, path, claimsById, ceilingRank, errors);
      const mappingTextOccursInEvidence = stakeholder.claim_ids.some((id) => {
        const excerpt = claimsById.get(id)?.excerpt;
        return typeof excerpt === "string" &&
          excerpt.includes(stakeholder.display_name) &&
          excerpt.includes(stakeholder.role_evidence);
      });
      if (!mappingTextOccursInEvidence) {
        addSemanticError(
          errors,
          `${path}/role_evidence`,
          "The caller-supplied name and role text must occur in a cited claim excerpt; this does not verify their relationship.",
        );
      }
    });
  }

  if (Object.hasOwn(value, "offering_matches")) {
    if (value.offering_matches.account_id !== accountId) {
      addSemanticError(errors, "/offering_matches/account_id", "Offering matches must belong to the brief account.");
    }
    const offeringIds = value.offering_matches.matches.length > 0
      ? referenceIds(referenceRegistry?.offerings, "offerings", "/referenceRegistry/offerings", errors)
      : new Set();

    value.offering_matches.matches.forEach((match, index) => {
      const path = `/offering_matches/matches/${index}`;
      if (offeringIds && !offeringIds.has(match.offering_id)) {
        addSemanticError(errors, `${path}/offering_id`, "The offering is not in the supplied versioned reference list.");
      }
      if (match.signal_ids?.some((id) => !signalIds.has(id))) {
        addSemanticError(errors, `${path}/signal_ids`, "Every signal ID must refer to a signal in this brief.");
      }
      validateEvidenceReferences(match, path, claimsById, ceilingRank, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}
