import { accountProblems, resultProblems } from "../../adapters/account-adapter.js";

/**
 * Extract a usable search term from free-form account references.
 * Plain names are sent as-is (trimmed). References that carry a suffix after a
 * comma or parenthesis, such as "Northstar Logistics (US)", are reduced to the
 * name portion because adapters index on the account name.
 */
export function toSearchTerm(accountReference) {
  const trimmed = accountReference.trim();
  const [namePart] = trimmed.split(/[,;(]/);
  const candidate = namePart.trim();
  return candidate.length > 0 ? candidate : trimmed;
}

/**
 * Call an account adapter and normalize its response into a result the skill
 * can trust. Never throws for transport failures: every failure is returned as
 * a structured result so account.resolve can map it to an error code.
 *
 * @param {import("../../adapters/account-adapter.js").AccountAdapter} adapter
 * @param {string} accountReference
 * @returns {Promise<{ok: true, accounts: object[]} | {ok: false, code: string, message: string, details?: object}>}
 */
export async function searchAccounts(adapter, accountReference) {
  if (!adapter || typeof adapter.searchAccounts !== "function") {
    return {
      ok: false,
      code: "ADAPTER_MALFORMED_RESPONSE",
      message: "Account adapter does not implement searchAccounts",
    };
  }

  let raw;
  try {
    raw = await adapter.searchAccounts(toSearchTerm(accountReference), { limit: 25 });
  } catch (error) {
    return {
      ok: false,
      code: "ADAPTER_UNAVAILABLE",
      message: `Account adapter threw while searching: ${error instanceof Error ? error.message : "unknown error"}`,
      details: { adapter: adapter.name ?? "unnamed" },
    };
  }

  const problem = resultProblems(raw);
  if (problem) {
    return {
      ok: false,
      code: problem.code,
      message: problem.message,
      details: { adapter: adapter.name ?? "unnamed" },
    };
  }

  if (raw.ok === false) {
    return {
      ok: false,
      code: raw.error.code,
      message: raw.error.message,
      details: { adapter: adapter.name ?? "unnamed", retryable: raw.error.retryable === true },
    };
  }

  // Defense in depth: resultProblems already checked shape, but re-check the
  // records the skill will actually use.
  const badRecords = raw.accounts.flatMap((account, index) =>
    accountProblems(account).map((p) => `accounts[${index}]: ${p}`),
  );
  if (badRecords.length > 0) {
    return {
      ok: false,
      code: "ADAPTER_MALFORMED_RESPONSE",
      message: badRecords.join("; "),
      details: { adapter: adapter.name ?? "unnamed" },
    };
  }

  return { ok: true, accounts: raw.accounts };
}
