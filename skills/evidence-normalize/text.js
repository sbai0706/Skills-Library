/**
 * Deterministic text normalization used ONLY for comparison:
 *   - claim-support checking (claim tokens vs excerpt tokens),
 *   - duplicate detection (normalized claim text),
 *   - excerpt containment (whitespace-insensitive verbatim check).
 *
 * Never used to rewrite emitted claim or excerpt text: what goes out is what
 * the source and the extractor produced.
 */

/** Grammatical words ignored by the claim-support check. Documented in SKILL.md. */
export const STOPWORDS = Object.freeze(
  new Set([
    "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "of", "in", "on", "at", "to", "for",
    "with", "by", "from", "as", "into", "onto", "over", "under", "about", "across", "after",
    "before", "between", "during", "per", "than", "then", "is", "are", "was", "were", "be",
    "been", "being", "am", "has", "have", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "it", "its", "this", "that", "these",
    "those", "they", "them", "their", "he", "she", "his", "her", "we", "us", "our", "you",
    "your", "i", "me", "my", "s", "t",
  ]),
);

/** Lowercase, strip diacritics, punctuation to spaces, collapse whitespace. */
export function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Collapse all whitespace runs to single spaces and trim. The only permitted
 * deviation from verbatim excerpt matching.
 */
export function collapseWhitespace(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Significant comparison tokens: normalized words excluding stopwords.
 * Numbers survive normalization, so quantities and years stay comparable.
 */
export function significantTokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token !== "" && !STOPWORDS.has(token));
}

/** True when the excerpt appears verbatim in content, ignoring whitespace runs. */
export function excerptOccursIn(excerpt, content) {
  return collapseWhitespace(content).includes(collapseWhitespace(excerpt));
}

/**
 * Conservative direct-support check.
 *
 * Every significant token of the claim must occur in the excerpt. A claim that
 * introduces a name, quantity, date, product, or relationship not present in
 * the excerpt therefore fails. The check is deliberately strict: a claim whose
 * wording departs from the excerpt is rejected rather than guessed at.
 */
export function claimTokensSupported(claim, excerpt) {
  const excerptTokens = new Set(significantTokens(excerpt));
  const unsupported = significantTokens(claim).filter((token) => !excerptTokens.has(token));
  return { supported: unsupported.length === 0, unsupported };
}
