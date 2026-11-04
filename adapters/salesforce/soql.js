import { looksLikeDomain, normalizeDomain } from "../../skills/account-resolve/normalize.js";
import { ACCOUNT_SEARCH_LIMIT, DEFAULT_OBJECT_LIMITS } from "./constants.js";
import { selectList } from "./fields.js";
import { cleanText } from "./format.js";

/** Pure SOQL builders. Nothing here performs I/O. */

const ACCOUNT_SEARCH_SELECT =
  "SELECT Id, Name, Website, BillingCity, BillingState, BillingCountry, Owner.Name FROM Account";
const SF_ACCOUNT_ID = /^sf_(001[A-Za-z0-9]{15})$/;
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "gmbh", "ag", "sa", "bv", "nv", "pty", "the",
]);
/** `sf_<something>` without whitespace that is not a valid 18-character Account ID (checked after the valid-ID case). */
const INVALID_SF_REFERENCE = /^sf_\S*$/;
const MAX_TOKENS = 6;
const MAX_TERM_CODE_POINTS = 255;

/** Escape a string for use inside a single-quoted SOQL literal. */
export function escapeSoqlLiteral(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Escape for a SOQL LIKE pattern: literal escaping, then `%` and `_`. */
export function escapeSoqlLike(value) {
  return escapeSoqlLiteral(value).replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** `sf_<18-char Account Id>` -> Id, else null. */
export function parseSfAccountId(accountId) {
  const match = typeof accountId === "string" ? SF_ACCOUNT_ID.exec(accountId) : null;
  return match ? match[1] : null;
}

/** Whitespace-normalised term cut to 255 code points. */
export function prepareTerm(term) {
  return [...cleanText(typeof term === "string" ? term : "")].slice(0, MAX_TERM_CODE_POINTS).join("").trim();
}

/** Name tokens for LIKE matching: letters/digits, length >= 2, no legal suffixes, deduped, max 6. */
export function searchTokens(term) {
  const seen = new Set();
  const tokens = [];
  for (const token of String(term).split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if ([...token].length < 2) continue;
    const key = token.toLowerCase();
    if (LEGAL_SUFFIXES.has(key) || seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length === MAX_TOKENS) break;
  }
  return tokens;
}

const ORDER = `ORDER BY Name ASC, Id ASC LIMIT ${ACCOUNT_SEARCH_LIMIT}`;

/** `... WHERE Id = '<id>' LIMIT 1` */
export function buildAccountByIdSoql(sfId) {
  if (!/^001[A-Za-z0-9]{15}$/.test(sfId)) throw new TypeError("Invalid Salesforce Account Id");
  return `${ACCOUNT_SEARCH_SELECT} WHERE Id = '${sfId}' LIMIT 1`;
}

/** Exact-name query (also the supplementary truncation-guard query). */
export function buildAccountExactSoql(term) {
  return `${ACCOUNT_SEARCH_SELECT} WHERE Name = '${escapeSoqlLiteral(prepareTerm(term))}' ${ORDER}`;
}

/** Search query for a prepared term: exact ID, domain, or name (exact OR token LIKEs). */
export function buildAccountSearchSoql(rawTerm) {
  const term = prepareTerm(rawTerm);
  const sfId = parseSfAccountId(term);
  if (sfId) return buildAccountByIdSoql(sfId);
  if (INVALID_SF_REFERENCE.test(term)) throw new TypeError("Malformed sf_ account reference: no query is built");
  if (looksLikeDomain(term)) {
    return `${ACCOUNT_SEARCH_SELECT} WHERE Name = '${escapeSoqlLiteral(term)}' OR Website LIKE '%${escapeSoqlLike(normalizeDomain(term))}%' ${ORDER}`;
  }
  const clauses = [`Name = '${escapeSoqlLiteral(term)}'`, ...searchTokens(term).map((token) => `Name LIKE '%${escapeSoqlLike(token)}%'`)];
  return `${ACCOUNT_SEARCH_SELECT} WHERE ${clauses.join(" OR ")} ${ORDER}`;
}

/** Which variant `buildAccountSearchSoql` will use for a term. */
export function accountSearchKind(rawTerm) {
  const term = prepareTerm(rawTerm);
  if (parseSfAccountId(term)) return "id";
  if (INVALID_SF_REFERENCE.test(term)) return "invalid_id";
  return looksLikeDomain(term) ? "domain" : "name";
}

const ORDER_BY = Object.freeze({
  Opportunity: "ORDER BY CloseDate DESC, Id ASC",
  Contact: "ORDER BY Name ASC, Id ASC",
  Task: "ORDER BY ActivityDate DESC NULLS LAST, Id ASC",
  Event: "ORDER BY StartDateTime DESC NULLS LAST, Id ASC",
});

/**
 * Evidence query for one object. `keep` is the number of records kept; the SOQL LIMIT is
 * `keep + 1` so truncation is detectable.
 * @param {string} objectName
 * @param {string} sfId 18-character Account Id
 * @param {{limits?: object}} [options]
 */
export function buildObjectSoql(objectName, sfId, options = {}) {
  if (!/^001[A-Za-z0-9]{15}$/.test(sfId)) throw new TypeError("Invalid Salesforce Account Id");
  const keep = options.limits?.[objectName] ?? DEFAULT_OBJECT_LIMITS[objectName];
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError(`Invalid limit for ${objectName}`);
  const select = selectList(objectName);
  if (objectName === "Account") return `SELECT ${select} FROM Account WHERE Id = '${sfId}' LIMIT 1`;
  return `SELECT ${select} FROM ${objectName} WHERE AccountId = '${sfId}' ${ORDER_BY[objectName]} LIMIT ${keep + 1}`;
}
