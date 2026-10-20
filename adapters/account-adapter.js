/**
 * Account adapter interface.
 *
 * An adapter is the only place account data enters a skill. Skills must not
 * depend on a concrete transport (CRM, fixture file, HTTP client); they depend
 * on this shape so a Salesforce adapter can later replace the fixture adapter
 * without changing the skill contract.
 *
 * Implementations must return a SearchAccountsResult, never throw raw transport
 * errors. Transport failures are reported as {ok: false, error: {code, message,
 * retryable}} so the skill can map them to structured errors.
 *
 * @typedef {Object} AdapterAccount
 * @property {string} account_id      Stable system identifier, e.g. sf_001... . Required.
 * @property {string} name            Account name as stored in the source system. Required.
 * @property {string} [domain]        Primary web domain, e.g. northstar-logistics.example.
 * @property {string} [location]      Human-readable location, e.g. "Columbus, OH".
 * @property {string} [owner_name]    Account owner display name.
 * @property {boolean} [active]       Defaults to true when omitted.
 *
 * @typedef {Object} AdapterError
 * @property {"ADAPTER_UNAUTHORIZED"|"ADAPTER_UNAVAILABLE"|"ADAPTER_MALFORMED_RESPONSE"} code
 * @property {string} message
 * @property {boolean} retryable
 *
 * @typedef {Object} SearchAccountsResult
 * @property {true} ok
 * @property {AdapterAccount[]} accounts
 * @property {string} [next_page_token]  Reserved for real pagination; absent means complete.
 *   OR
 * @property {false} ok
 * @property {AdapterError} error
 *
 * @typedef {Object} AccountAdapter
 * @property {string} name
 * @property {(query: string, options?: {limit?: number}) => Promise<SearchAccountsResult>} searchAccounts
 *   Return accounts whose name plausibly matches the query. Implementations may
 *   over-match; account.resolve is responsible for conservative scoring.
 */

/**
 * Validate an adapter account record. Returns a list of human-readable problems.
 * The skill uses this to detect malformed adapter data instead of guessing.
 * @param {unknown} account
 * @returns {string[]}
 */
export function accountProblems(account) {
  if (typeof account !== "object" || account === null) return ["account is not an object"];
  const problems = [];
  if (typeof account.account_id !== "string" || account.account_id.trim() === "") {
    problems.push("account_id missing or empty");
  }
  if (typeof account.name !== "string" || account.name.trim() === "") {
    problems.push("name missing or empty");
  }
  return problems;
}

/**
 * Validate a whole search result. Returns null when valid, otherwise an
 * AdapterError describing the malformation.
 * @param {unknown} result
 * @returns {AdapterError|null}
 */
export function resultProblems(result) {
  const malformed = (message) => ({
    code: "ADAPTER_MALFORMED_RESPONSE",
    message,
    retryable: false,
  });
  if (typeof result !== "object" || result === null) return malformed("adapter returned a non-object result");
  if (result.ok === false) {
    const error = result.error;
    if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
      return malformed("adapter failure is missing a structured error");
    }
    return null;
  }
  if (result.ok !== true) return malformed("adapter result lacks a boolean 'ok' field");
  if (!Array.isArray(result.accounts)) return malformed("adapter result 'accounts' is not an array");
  if (result.accounts.length > 50) return malformed("adapter returned more accounts than the contract permits");
  const problems = result.accounts.flatMap((account, index) =>
    accountProblems(account).map((problem) => `accounts[${index}]: ${problem}`),
  );
  return problems.length === 0 ? null : malformed(problems.join("; "));
}
