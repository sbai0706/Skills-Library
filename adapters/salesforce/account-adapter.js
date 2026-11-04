import { assertMcpToolClient } from "../mcp/index.js";
import { looksLikeDomain, normalizeDomain } from "../../skills/account-resolve/normalize.js";
import { ACCOUNT_SEARCH_LIMIT, API_VERSION_PATTERN, DEFAULT_API_VERSION, ID_PREFIX } from "./constants.js";
import { SfAdapterError, malformed, toAdapterError } from "./errors.js";
import { cleanText } from "./format.js";
import {
  accountSearchKind, buildAccountExactSoql, buildAccountSearchSoql, prepareTerm,
} from "./soql.js";
import { runQuery } from "./transport.js";

function optionalText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new SfAdapterError(malformed("value_type_mismatch"));
  return cleanText(value);
}

function toAccount(row) {
  if (typeof row.Name !== "string" || row.Name.trim() === "") throw new SfAdapterError(malformed("blank_name"));
  const account = { account_id: `sf_${row.Id}`, name: row.Name };
  const website = optionalText(row.Website);
  if (website !== "" && looksLikeDomain(website)) account.domain = normalizeDomain(website);
  const location = [row.BillingCity, row.BillingState, row.BillingCountry].map(optionalText).filter((part) => part !== "").join(", ");
  if (location !== "") account.location = location;
  const owner = optionalText(row.Owner?.Name);
  if (owner !== "") account.owner_name = owner;
  return account;
}

/**
 * Salesforce AccountAdapter over an injected McpToolClient. SOQL only; over-matches and never
 * decides (account.resolve owns scoring). Never throws after construction.
 * @param {{client: import("../mcp/client.js").McpToolClient, apiVersion?: string}} options
 */
export function createSalesforceAccountAdapter({ client, apiVersion = DEFAULT_API_VERSION } = {}) {
  assertMcpToolClient(client);
  if (typeof apiVersion !== "string" || !API_VERSION_PATTERN.test(apiVersion)) {
    throw new TypeError(`apiVersion must match ${API_VERSION_PATTERN}`);
  }
  const search = (soql, maxRecords) =>
    runQuery(client, soql, { apiVersion, expectObject: "Account", idPrefix: ID_PREFIX.Account, maxRecords });

  return {
    name: `salesforce-account-adapter(${apiVersion})`,
    supportedSources: ["crm"],
    /** `options.limit` is ignored on purpose so canonical call args do not depend on the caller. */
    async searchAccounts(query) {
      try {
        const term = prepareTerm(query);
        if (term === "") return { ok: true, accounts: [] };
        const kind = accountSearchKind(term);
        // A malformed `sf_...` reference is a no-match (empty list, no call), never a broad name search.
        if (kind === "invalid_id") return { ok: true, accounts: [] };
        // Known limitation: if the 50-row cap is hit without an exact name even after the
        // supplementary query, the AccountAdapter contract has no warning/flag field, so the
        // truncation is not surfaced (documented in the P2 design, section 10).
        const first = await search(buildAccountSearchSoql(term), kind === "id" ? 1 : ACCOUNT_SEARCH_LIMIT);
        if (!first.ok) return { ok: false, error: first.error };
        let rows = first.records;
        if (kind === "name" && rows.length === ACCOUNT_SEARCH_LIMIT &&
            !rows.some((row) => typeof row.Name === "string" && row.Name.trim().toLowerCase() === term.toLowerCase())) {
          const exact = await search(buildAccountExactSoql(term), ACCOUNT_SEARCH_LIMIT);
          if (!exact.ok) return { ok: false, error: exact.error };
          const seen = new Set();
          rows = [...exact.records, ...rows].filter((row) => (seen.has(row.Id) ? false : seen.add(row.Id))).slice(0, ACCOUNT_SEARCH_LIMIT);
        }
        return { ok: true, accounts: rows.map(toAccount) };
      } catch (thrown) {
        return { ok: false, error: toAdapterError(thrown) };
      }
    },
  };
}
