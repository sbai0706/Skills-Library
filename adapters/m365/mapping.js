import { readFileSync } from "node:fs";
import YAML from "yaml";
import { validate } from "../../schemas/index.js";
import { FOLDER_NAME_MAX, MAX_LOCATIONS_PER_ACCOUNT, PREFIX_MAX } from "./constants.js";
import { parseWebUrl, safeDecode } from "./format.js";

/**
 * Account -> SharePoint location mapping (P4 design section 2, with Decisions 1 and 2 of
 * 2026-11-05). Locations are `https://<tenant>.sharepoint.com/sites/<site>/<library>[/<folder>]`
 * or `.../teams/<site>/<library>[/<folder>]`. Personal OneDrive and root-site libraries are rejected.
 * The whole file is rejected on the first problem class (fail closed). Messages carry only the
 * problem kind and entry indexes, never a URL, folder or customer name.
 */

export class M365MappingError extends Error {
  /** @param {string[]} problems */
  constructor(message, problems = []) {
    super(message);
    this.name = "M365MappingError";
    this.problems = problems;
  }
}

const SF_ID = /^sf_001[A-Za-z0-9]{15}$/;
const ACCT_ID = /^acct_[a-z0-9_]{1,60}$/;
const HOST = /^[a-z0-9-]+\.sharepoint\.com$/i;
const ROOTS = new Set(["sites", "teams"]);

/** `sf_001...` (18-character Salesforce Account Id) or a mapped `acct_...` id. */
export function isValidAccountId(accountId) {
  return typeof accountId === "string" && (SF_ID.test(accountId) || ACCT_ID.test(accountId));
}

/** trim, strip trailing slashes; case is kept for display. */
export function normalizePrefix(prefix) {
  return String(prefix).trim().replace(/\/+$/, "");
}

/** Problem kind for a prefix, or null when it is acceptable. Never returns the value itself. */
function prefixProblem(prefix) {
  const text = normalizePrefix(prefix);
  if ([...text].length > PREFIX_MAX) return "too_long";
  if (/[\u0000-\u001f\u007f\\]/.test(text)) return "invalid_characters";
  if (!/^https:\/\//i.test(text)) return "not_https";
  if (/[?#]/.test(text)) return "query_or_fragment";
  const rest = text.slice("https://".length);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash + 1);
  if (!HOST.test(host)) return "host_not_sharepoint";
  if (/-my\.sharepoint\.com$/i.test(host)) return "personal_onedrive_host";
  if (/%[0-9A-Fa-f]{2}/.test(path)) return "percent_encoded";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) return "empty_segment";
  if (segments.some((segment) => segment === "." || segment === "..")) return "dot_segment";
  if (segments.some((segment) => segment.toLowerCase() === "personal")) return "personal_segment";
  if (segments.length < 3 || !ROOTS.has(segments[0].toLowerCase())) return "not_site_library_path";
  return null;
}

function lastSegment(prefix) {
  const text = normalizePrefix(prefix);
  return text.slice(text.lastIndexOf("/") + 1);
}

/**
 * Validate a parsed mapping document and return a frozen normalized mapping:
 * `{status, accounts: [{account_id, label?, locations: [{prefix, key, folder_name, classification|null}]}]}`.
 * @throws {M365MappingError}
 */
export function validateM365AccountMapping(doc) {
  const { valid, errors } = validate("m365AccountMapping", doc);
  if (!valid) {
    const problems = errors.slice(0, 10).map((error) => `schema: ${error.path} ${error.message}`);
    throw new M365MappingError("The M365 account mapping does not match its schema.", problems);
  }
  const problems = [];
  const seenAccounts = new Set();
  const accounts = doc.accounts.map((account, i) => {
    if (!isValidAccountId(account.account_id)) problems.push(`accounts[${i}].account_id: invalid_account_id`);
    if (seenAccounts.has(account.account_id)) problems.push(`accounts[${i}].account_id: duplicate_account`);
    seenAccounts.add(account.account_id);
    if (account.locations.length > MAX_LOCATIONS_PER_ACCOUNT) problems.push(`accounts[${i}].locations: too_many_locations`);
    const seenPrefixes = new Set();
    const locations = account.locations.map((location, j) => {
      const where = `accounts[${i}].locations[${j}]`;
      const problem = prefixProblem(location.web_url_prefix);
      if (problem) problems.push(`${where}.web_url_prefix: ${problem}`);
      const prefix = normalizePrefix(location.web_url_prefix);
      const key = prefix.toLowerCase();
      if (seenPrefixes.has(key)) problems.push(`${where}.web_url_prefix: duplicate_prefix`);
      seenPrefixes.add(key);
      if (location.search_folder_name !== undefined) {
        const folder = location.search_folder_name.trim();
        if (folder === "" || [...folder].length > FOLDER_NAME_MAX) problems.push(`${where}.search_folder_name: invalid_folder_name`);
      }
      const folderName = (location.search_folder_name ?? lastSegment(prefix)).trim();
      return Object.freeze({ prefix, key, folder_name: folderName, classification: location.classification ?? null });
    });
    return Object.freeze({
      account_id: account.account_id,
      ...(account.label !== undefined ? { label: account.label } : {}),
      locations: Object.freeze(locations),
    });
  });
  if (problems.length > 0) throw new M365MappingError("The M365 account mapping is invalid.", problems.slice(0, 20));
  return Object.freeze({ status: doc.status, accounts: Object.freeze(accounts) });
}

/** Read, parse and validate a mapping file. Messages never contain file contents. */
export function loadM365AccountMapping(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new M365MappingError("The M365 account mapping file cannot be read.");
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch {
    throw new M365MappingError("The M365 account mapping file is not valid YAML.");
  }
  return validateM365AccountMapping(doc);
}

/** The mapping entry for an account ID, or null. */
export function findAccountMapping(mapping, accountId) {
  return mapping.accounts.find((account) => account.account_id === accountId) ?? null;
}

/** True for personal OneDrive: a `-my.sharepoint.com` host or any `personal` path segment. */
export function isPersonalUrl(webUrl) {
  let url;
  try { url = new URL(webUrl); } catch { return false; }
  if (/-my\.sharepoint\.com$/i.test(url.hostname)) return true;
  const rawPath = webUrl.replace(/^[a-z]+:\/\/[^/]*/i, "").split(/[?#]/)[0];
  return [url.pathname, rawPath].some((path) => path.split("/").some((segment) => safeDecode(segment).toLowerCase() === "personal"));
}

/**
 * Locations whose prefix contains `webUrl` at a path-segment boundary. The URL is parsed from its
 * raw string into host + percent-decoded segments (see `parseWebUrl`); a URL with a `.`/`..`
 * segment, an encoded or literal `/` or `\` inside a segment, userinfo, a port or a non-https
 * scheme matches nothing (it counts as outside the mapping). Host and segments are compared
 * case-insensitively as arrays, never by string prefix. Prefixes are unencoded as written.
 */
export function matchPrefix(webUrl, locations) {
  const url = parseWebUrl(webUrl);
  if (url === null) return [];
  const lower = url.segments.map((segment) => segment.toLowerCase());
  return locations.filter((location) => {
    const prefix = parseWebUrl(location.prefix);
    if (prefix === null || prefix.host !== url.host) return false;
    if (prefix.segments.length >= lower.length) return false; // the document sits strictly below the folder
    return prefix.segments.every((segment, index) => segment.toLowerCase() === lower[index]);
  });
}
