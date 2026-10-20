import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * Load a fixture directory. Each fixture contains accounts.json (adapter data)
 * and expected.json (the behavior the tests assert). Unreadable fixtures throw
 * because that is a setup error, not an adapter runtime failure.
 */
export function loadFixture(name) {
  const dir = join(fixturesDir, name);
  return {
    name,
    accounts: JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")),
    expected: JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")),
  };
}

/**
 * Fixture-backed account adapter for tests and local demos. It implements the
 * AccountAdapter interface in adapters/account-adapter.js and performs no
 * network calls.
 *
 * The search is intentionally permissive: it returns every account that shares
 * at least one significant name token with the query. Deciding which result is
 * credible belongs to account.resolve, not to the adapter.
 *
 * @param {object} [options]
 * @param {string} [options.fixture] Name of a directory under fixtures/.
 * @param {Array<object>} [options.accounts] Inline accounts, overriding the fixture file.
 * @param {"ok"|"unauthorized"|"unavailable"|"throw"|"malformed"|"malformed_envelope"} [options.mode]
 * @returns {import("./account-adapter.js").AccountAdapter}
 */
export function createFixtureAccountAdapter(options = {}) {
  const { fixture, accounts: inlineAccounts, mode = "ok" } = options;
  if (mode === "ok" && !fixture && !inlineAccounts) {
    throw new Error("createFixtureAccountAdapter requires a fixture name or inline accounts in ok mode");
  }
  const accounts = inlineAccounts ?? (fixture ? loadFixture(fixture).accounts.accounts : []);

  return {
    name: `fixture-account-adapter(${fixture ?? "inline"})`,
    async searchAccounts(query) {
      if (mode === "throw") throw new Error("Simulated adapter transport failure");
      if (mode === "unauthorized") {
        return {
          ok: false,
          error: {
            code: "ADAPTER_UNAUTHORIZED",
            message: "Caller is not permitted to search accounts.",
            retryable: false,
          },
        };
      }
      if (mode === "unavailable") {
        return {
          ok: false,
          error: {
            code: "ADAPTER_UNAVAILABLE",
            message: "Account service did not respond within the timeout.",
            retryable: true,
          },
        };
      }
      if (mode === "malformed") {
        return { ok: true, accounts: [{ account_id: "sf_bad", name: "" }] };
      }
      if (mode === "malformed_envelope") {
        return { ok: true, accounts: "not-an-array" };
      }

      const queryTokens = new Set(
        query
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(" ")
          .filter(Boolean),
      );
      const exactId = accounts.filter((account) => account.account_id === query);
      if (exactId.length > 0) return { ok: true, accounts: exactId };

      const matches = accounts.filter((account) => {
        const accountTokens = account.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(" ")
          .filter(Boolean);
        return (
          accountTokens.some((token) => queryTokens.has(token)) ||
          (account.domain ? query.toLowerCase().includes(account.domain.toLowerCase()) : false)
        );
      });
      return { ok: true, accounts: matches };
    },
  };
}
