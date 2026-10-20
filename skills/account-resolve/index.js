import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { isCredible, MATCHING_RULES, matchMethod, scoreAccount } from "./match.js";
import { toSearchTerm, searchAccounts } from "./search.js";

export const SKILL_NAME = "account.resolve";
export const SKILL_VERSION = "0.1.0";

/**
 * Fields that appear in the resolved payload. Only identifiers that the adapter
 * actually returned are included; the skill never invents an account ID.
 */
const IDENTIFIER_FIELDS = ["domain", "location", "owner_name"];

/** Shape of one blocked/failed reason, mirrored in SKILL.md and skill.yaml. */
const REASON = {
  AMBIGUOUS_ACCOUNT: "ambiguous_account",
  ACCOUNT_NOT_FOUND: "account_not_found",
};

const trace = () => `trace_${randomUUID()}`;

/**
 * @param {object} params
 * @param {string} params.status
 * @param {object|null} params.data
 * @param {string} params.startedAt
 * @param {Array<{code: string, message: string, retryable: boolean, details?: object, occurred_at?: string}>} [params.errors]
 * @param {Array<{code: string, message: string}>} [params.warnings]
 * @param {string[]} [params.evidenceIds]
 */
function envelope({ status, data, startedAt, errors = [], warnings = [], evidenceIds = [] }) {
  const result = {
    skill: SKILL_NAME,
    skill_version: SKILL_VERSION,
    status,
    data,
    evidence_ids: evidenceIds,
    warnings,
    errors,
    trace_id: trace(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  const { valid, errors: schemaErrors } = validate("skillResult", result);
  if (!valid) {
    throw new Error(`account.resolve produced an invalid envelope: ${JSON.stringify(schemaErrors)}`);
  }
  return result;
}

/**
 * Resolve an account reference to exactly one credible account.
 *
 * Outcomes:
 *  - resolved: status success, data.outcome "resolved"
 *  - ambiguous: status blocked with all credible candidates (never auto-picked)
 *  - not_found: status blocked with a structured reason
 *  - failed: status failed with a structured error and null data
 *
 * @param {{account_reference: string}} input
 * @param {{adapter: import("../../adapters/account-adapter.js").AccountAdapter, now?: () => Date}} deps
 * @returns {Promise<object>} skill result envelope
 */
export async function resolveAccount(input, deps) {
  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const errors = [];

  if (typeof input?.account_reference !== "string" || input.account_reference.trim() === "") {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: [
        {
          code: "INVALID_INPUT",
          message: "account_reference must be a non-empty string",
          retryable: false,
          occurred_at: startedAt,
        },
      ],
    });
  }

  const accountReference = input.account_reference.trim();
  const searchTerm = toSearchTerm(accountReference);
  const search = await searchAccounts(deps.adapter, accountReference);

  if (!search.ok) {
    return envelope({
      status: "failed",
      data: null,
      startedAt,
      errors: [
        {
          code: search.code,
          message: search.message,
          retryable: search.code === "ADAPTER_UNAVAILABLE",
          details: search.details,
          occurred_at: startedAt,
        },
      ],
    });
  }

  const scored = search.accounts.map((account) => ({ account, ...scoreAccount(searchTerm, account) }));
  const credible = scored
    .filter(isCredible)
    .sort((a, b) =>
      b.score - a.score ||
      Number(b.exact_key) - Number(a.exact_key) ||
      a.account.account_id.localeCompare(b.account.account_id),
    );

  if (credible.length === 0) {
    return envelope({
      status: "blocked",
      data: {
        outcome: "not_found",
        reason: REASON.ACCOUNT_NOT_FOUND,
        account_reference: accountReference,
        search_term: searchTerm,
        candidates_seen: search.accounts.length,
      },
      startedAt,
      errors: [
        {
          code: "ACCOUNT_NOT_FOUND",
          message: `No credible account matched "${accountReference}".`,
          retryable: false,
          details: { candidates_seen: search.accounts.length },
          occurred_at: startedAt,
        },
      ],
    });
  }

  if (credible.length > 1) {
    return envelope({
      status: "blocked",
      data: {
        outcome: "ambiguous",
        reason: REASON.AMBIGUOUS_ACCOUNT,
        account_reference: accountReference,
        search_term: searchTerm,
        candidates: credible.map((c) => ({
          account_id: c.account.account_id,
          name: c.account.name,
          ...IDENTIFIER_FIELDS.reduce((acc, field) => {
            if (c.account[field] !== undefined && c.account[field] !== null) acc[field] = c.account[field];
            return acc;
          }, {}),
          score: c.score,
          matched_tokens: c.matched_tokens,
        })),
        clarification_needed: "Which account is intended? Provide a domain, location, or exact account ID.",
      },
      startedAt,
      errors: [
        {
          code: "AMBIGUOUS_ACCOUNT",
          message: `${credible.length} credible accounts matched "${accountReference}"; a human must disambiguate.`,
          retryable: false,
          details: { candidate_count: credible.length },
          occurred_at: startedAt,
        },
      ],
    });
  }

  const [best] = credible;
  return envelope({
    status: "success",
    data: {
      outcome: "resolved",
      account_reference: accountReference,
      search_term: searchTerm,
      account: {
        account_id: best.account.account_id,
        name: best.account.name,
        ...IDENTIFIER_FIELDS.reduce((acc, field) => {
          if (best.account[field] !== undefined && best.account[field] !== null) acc[field] = best.account[field];
          return acc;
        }, {}),
      },
      match: {
        method: matchMethod(best),
        score: best.score,
        matched_tokens: best.matched_tokens,
        rules_version: "matching-rules-0.1.0",
        min_credible_score: MATCHING_RULES.MIN_CREDIBLE_SCORE,
      },
    },
    startedAt,
    warnings: best.score < 1 ? [
      {
        code: "FUZZY_MATCH",
        message: `Resolved by token match (score ${best.score}); confirm the account before downstream use.`,
      },
    ] : [],
  });
}

export default resolveAccount;
