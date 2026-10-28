import { resultProblems } from "./claim-extractor.js";

/**
 * Fixture claim extractor. Deterministic, no model, no prose parsing.
 *
 * Candidates live in the record's flat metadata as a JSON string under
 * `claim_candidates_json`, because schemas/source-record.schema.json restricts
 * metadata values to scalars. Each element has the ClaimCandidate shape from
 * adapters/claim-extractor.js:
 *
 *   { "claim": "...", "excerpt": "...", "completeness": "complete",
 *     "conflict_key": "...", "access_classification": "..." }
 *
 * A record without the key simply yields no candidates.
 *
 * Modes for tests:
 *   ok (default) | throw | malformed (non-array candidates) | error (ok:false)
 *
 * @param {object} [options]
 * @param {"ok"|"throw"|"malformed"|"error"} [options.mode]
 * @returns {import("./claim-extractor.js").ClaimExtractor}
 */
export function createFixtureClaimExtractor(options = {}) {
  const mode = options.mode ?? "ok";
  return {
    name: `fixture-claim-extractor(${mode})`,
    async extract(record) {
      if (mode === "throw") throw new Error("Simulated extractor failure");
      if (mode === "malformed") return { ok: true, candidates: "not-an-array" };
      if (mode === "error") {
        return {
          ok: false,
          error: { code: "EXTRACTOR_UNAVAILABLE", message: "Simulated extractor error.", retryable: true },
        };
      }

      const encoded = record?.metadata?.claim_candidates_json;
      if (encoded === undefined || encoded === null) return { ok: true, candidates: [] };
      if (typeof encoded !== "string") {
        return {
          ok: false,
          error: {
            code: "EXTRACTOR_MALFORMED_RESPONSE",
            message: "metadata.claim_candidates_json must be a JSON string.",
            retryable: false,
          },
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(encoded);
      } catch {
        return {
          ok: false,
          error: {
            code: "EXTRACTOR_MALFORMED_RESPONSE",
            message: "metadata.claim_candidates_json is not valid JSON.",
            retryable: false,
          },
        };
      }
      return { ok: true, candidates: parsed };
    },
  };
}
