/**
 * Deterministic account name normalization. Used for comparison only; the
 * canonical display name is always the one returned by the adapter.
 *
 * Rules (documented in SKILL.md):
 * 1. Unicode NFKD, strip combining marks (so "Müller" == "Muller").
 * 2. Lowercase.
 * 3. "&" becomes "and".
 * 4. Every other non-alphanumeric run becomes a single space.
 * 5. Collapse whitespace and trim.
 * 6. Remove generic legal suffixes so "Acme, Inc." == "Acme".
 *    Only legal suffixes are removed; distinguishing words such as
 *    "group", "holdings", "partners", and "north" are preserved.
 */

const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "llp",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "bv",
  "nv",
  "pty",
  "the",
]);

const DIACRITICS = /\p{M}+/gu;

/** @param {string} value */
export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Significant tokens of a normalized value. Legal suffixes and "the" are
 * dropped. If a name consists only of generic words, the raw tokens are kept
 * so it can still be compared.
 * @param {string} value
 * @returns {string[]}
 */
export function tokenize(value) {
  const tokens = normalizeName(value).split(" ").filter(Boolean);
  const significant = tokens.filter((token) => !LEGAL_SUFFIXES.has(token));
  return significant.length > 0 ? significant : tokens;
}

/** Stable match key: normalized tokens joined by spaces. */
export function matchKey(value) {
  return tokenize(value).join(" ");
}

/** Domains are compared without scheme, "www.", path, or trailing dot. */
export function normalizeDomain(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

/** True when the reference is written as a bare domain. */
export function looksLikeDomain(value) {
  const normalized = normalizeDomain(value);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(normalized);
}