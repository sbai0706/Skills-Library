import { looksLikeDomain, matchKey, normalizeDomain, tokenize } from "./normalize.js";

/**
 * Conservative matching policy. These are fixed rules, not tuning knobs:
 * changing them requires an explicit decision and updated tests.
 *
 * A candidate is credible only when all hold:
 *  - score >= MIN_CREDIBLE_SCORE
 *  - coverage > MIN_COVERAGE (every reference name token except at most one appears)
 *  - at least one token matched
 * Any number of credible candidates other than one produces a blocked result.
 */
export const MATCHING_RULES = Object.freeze({
  MIN_CREDIBLE_SCORE: 0.6,
  MIN_COVERAGE: 0.5,
  WEIGHT_COVERAGE: 0.7,
  WEIGHT_PRECISION: 0.3,
});

/**
 * @param {string} reference
 * @param {{account_id: string, name: string, domain?: string}} account
 */
export function scoreAccount(reference, account) {
  const referenceTokens = tokenize(reference);
  const accountTokens = tokenize(account.name);
  const accountTokenSet = new Set(accountTokens);
  const matchedTokens = referenceTokens.filter((token) => accountTokenSet.has(token));
  const coverage = referenceTokens.length === 0 ? 0 : matchedTokens.length / referenceTokens.length;
  const precision = accountTokens.length === 0 ? 0 : matchedTokens.length / accountTokens.length;
  const score =
    Math.round(
      (MATCHING_RULES.WEIGHT_COVERAGE * coverage + MATCHING_RULES.WEIGHT_PRECISION * precision) * 10000,
    ) / 10000;

  const referenceKey = matchKey(reference);
  return {
    score,
    coverage,
    precision,
    matched_tokens: matchedTokens,
    exact_raw: typeof account.name === "string" && account.name.trim() === reference.trim(),
    exact_key: referenceKey !== "" && matchKey(account.name) === referenceKey,
    exact_domain: looksLikeDomain(reference) && normalizeDomain(reference) === normalizeDomain(account.domain),
  };
}

/** Credibility gate applied before a candidate may influence the outcome. */
export function isCredible(scored) {
  return (
    scored.score >= MATCHING_RULES.MIN_CREDIBLE_SCORE &&
    scored.coverage > MATCHING_RULES.MIN_COVERAGE &&
    scored.matched_tokens.length > 0
  );
}

/** Human-readable match method for a resolved account. */
export function matchMethod(scored) {
  if (scored.exact_domain) return "domain";
  if (scored.exact_raw) return "exact_name";
  if (scored.exact_key) return "normalized_name";
  return "token_match";
}
