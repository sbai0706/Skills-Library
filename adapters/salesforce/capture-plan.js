import { API_VERSION_PATTERN, DEFAULT_API_VERSION, OBJECT_ORDER, SF_TOOL } from "./constants.js";
import { resolveLimits } from "./limits.js";
import {
  accountSearchKind, buildAccountExactSoql, buildAccountSearchSoql, buildObjectSoql, parseSfAccountId, prepareTerm,
} from "./soql.js";

/**
 * Pure canonical-args builders. The adapters call the connector with exactly these args and the
 * host must record captures for exactly these args (never hand-written SOQL).
 */

export function assertApiVersion(apiVersion) {
  if (typeof apiVersion !== "string" || !API_VERSION_PATTERN.test(apiVersion)) {
    throw new TypeError(`apiVersion must match ${API_VERSION_PATTERN}`);
  }
  return apiVersion;
}

/** Args for a first-page query call. */
export function queryArgs(apiVersion, soql) {
  return { url: `/services/data/${assertApiVersion(apiVersion)}/query`, method: "GET", queryParams: { q: soql } };
}

/** Args for a pagination call (`nextRecordsUrl`); no `queryParams` key. */
export function nextPageArgs(url) {
  return { url, method: "GET" };
}

/**
 * Capture plan for account search phase.
 * @param {string} term search term as produced by account.resolve (`toSearchTerm`)
 */
export function accountSearchPlan(term, { apiVersion = DEFAULT_API_VERSION } = {}) {
  const prepared = prepareTerm(term);
  const kind = accountSearchKind(prepared);
  // Empty terms and malformed `sf_...` references make no call (the adapter returns no match).
  const calls = prepared === "" || kind === "invalid_id"
    ? []
    : [{ step: "search", kind, args: queryArgs(apiVersion, buildAccountSearchSoql(prepared)) }];
  if (calls.length > 0 && kind === "name") {
    calls.push({
      step: "exact_name_guard",
      condition: "only when the search returned exactly 50 rows and none has a trimmed, case-insensitive Name equal to the term",
      args: queryArgs(apiVersion, buildAccountExactSoql(prepared)),
    });
  }
  return {
    phase: "account_search",
    tool: SF_TOOL,
    term: prepared,
    calls,
    pagination: "After any call that returns done:false, also record the call {url: nextRecordsUrl, method: \"GET\"}.",
  };
}

/**
 * Capture plan for the evidence phase of a resolved account (`sf_<Id>`), in adapter call order.
 * @param {string} accountId `sf_001...`
 * @param {{apiVersion?: string, limits?: object}} [options] must match the adapter's options
 */
export function evidencePlan(accountId, { apiVersion = DEFAULT_API_VERSION, limits = {} } = {}) {
  const sfId = parseSfAccountId(accountId);
  if (!sfId) throw new TypeError("accountId must be sf_<18-character Salesforce Account Id>");
  const effectiveLimits = resolveLimits(limits);
  return {
    phase: "evidence",
    tool: SF_TOOL,
    account_id: accountId,
    calls: OBJECT_ORDER.map((objectName) => ({
      step: objectName,
      args: queryArgs(apiVersion, buildObjectSoql(objectName, sfId, { limits: effectiveLimits })),
    })),
    pagination: "After any call that returns done:false, also record the call {url: nextRecordsUrl, method: \"GET\"}.",
  };
}
