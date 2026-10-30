const CLASSIFICATION_RANK = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
});

const CITATION_PATTERN = /`\[(clm_[A-Za-z0-9_-]+)\]`/g;

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function citationsInMarkdown(markdown) {
  const ids = [];
  for (const match of markdown.matchAll(CITATION_PATTERN)) ids.push(match[1]);
  return uniqueSorted(ids);
}

/**
 * Verify the workflow-level provenance invariants before exposing an artifact.
 * A failure returns a safe problem code only; no claim text, source content,
 * withheld ID, or intermediate record is included.
 */
export function verifyProvenance({ claims, gapResult, renderResult, classificationCeiling }) {
  if (!Object.hasOwn(CLASSIFICATION_RANK, classificationCeiling) ||
      claims.some((claim) => !claim || !Object.hasOwn(CLASSIFICATION_RANK, claim.access_classification))) {
    return { ok: false, problem: "unknown_classification" };
  }
  const claimById = new Map(claims.map((claim) => [claim.claim_id, claim]));
  const ceilingRank = CLASSIFICATION_RANK[classificationCeiling];

  const artifact = renderResult.data?.rendered_artifact;
  if (typeof artifact !== "string" || artifact.trim() === "") {
    return { ok: false, problem: "missing_rendered_artifact" };
  }
  if (renderResult.data.classification !== classificationCeiling ||
      !Array.isArray(renderResult.data.cited_evidence_ids) ||
      !Array.isArray(renderResult.data.omitted_evidence_ids) ||
      !Array.isArray(renderResult.evidence_ids) ||
      [...renderResult.data.cited_evidence_ids, ...renderResult.data.omitted_evidence_ids,
        ...renderResult.evidence_ids].some((id) => typeof id !== "string")) {
    return { ok: false, problem: "invalid_renderer_metadata" };
  }

  const citations = citationsInMarkdown(artifact);
  const cited = uniqueSorted(renderResult.data.cited_evidence_ids ?? []);
  const envelopeEvidence = uniqueSorted(renderResult.evidence_ids ?? []);

  if (!same(citations, cited)) {
    return { ok: false, problem: "citation_list_mismatch" };
  }
  if (!same(citations, envelopeEvidence)) {
    return { ok: false, problem: "envelope_evidence_mismatch" };
  }

  for (const claimId of citations) {
    const claim = claimById.get(claimId);
    if (!claim) return { ok: false, problem: "unknown_citation" };
    if (CLASSIFICATION_RANK[claim.access_classification] > ceilingRank) {
      return { ok: false, problem: "citation_above_ceiling" };
    }
  }

  const omitted = uniqueSorted(renderResult.data.omitted_evidence_ids ?? []);
  const expectedOmitted = uniqueSorted(
    claims
      .filter((claim) => CLASSIFICATION_RANK[claim.access_classification] > ceilingRank)
      .map((claim) => claim.claim_id),
  );
  if (!same(omitted, expectedOmitted)) {
    return { ok: false, problem: "omitted_list_mismatch" };
  }

  const accountedFor = new Set([...citations, ...omitted]);
  for (const claimId of claimById.keys()) {
    if (!accountedFor.has(claimId)) {
      return { ok: false, problem: "claim_not_accounted_for" };
    }
  }

  for (const question of gapResult.questions) {
    for (const claimId of question.supporting_evidence_ids) {
      if (!claimById.has(claimId)) {
        return { ok: false, problem: "gap_evidence_not_normalized" };
      }
    }
  }

  return { ok: true, cited, omitted };
}
