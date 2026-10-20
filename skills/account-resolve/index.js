import { randomUUID } from "node:crypto";
import { validate } from "../../schemas/index.js";
import { isCredible, isExactMatch, MATCHING_RULES, matchMethod, scoreAccount } from "./match.js";
import { toSearchTerm, searchAccounts } from "./search.js";

export const SKILL_NAME = "account.resolve";
export const SKILL_VERSION = "0.2.0";

/**
 * Identifiers that may appear in a resolved account. Only values the adapter
 * actually returned are included; the skill never invents an account ID.
 */
const IDENTIFIER_FIELDS = ["domain", "location", "owner_name"];

/**
 * Identifiers that may appear in a candidate list. Candidates are unconfirmed,
 * so only non-restricted identifying fields are exposed: never owner, location,
 * revenue, contacts, or any other account detail.
 */
const CANDIDATE_FIELDS = ["domain"];

/** Shape of one blocked/failed reason, mirrored in SKILL.md and skill.yaml. */
const REASON = {
  AMBIGUOUS_ACCOUNT: "ambiguous_account",
  ACCOUNT_NOT_FOUND: "account_not_found",
  CONFIRMATION_REQUIRED: "confirmation_required",
};

const trace = () => `trace_${randomUUID()}`;

function pick(source, fields) {
  return fields.reduce((acc, field) => {
    if (source[field] !== undefined && source[field] !== null) acc[field] = source[field];
    return acc;
  }, {});
}

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
 * Resolve an account reference to exactly one exact account.
 *
 * Outcomes:
 *  - resolved: status success, data.outcome "resolved" (exact match only)
 *  - confirmation_required: status blocked, fuzzy or partial-name match, never auto-accepted
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
  // Credibility is measured against the account name, so an exact account ID or
  // authoritative domain match bypasses the token gate: those are identifiers,
  // not names. Every other candidate must pass the normal credibility rules.
  const credible = scored
    .filter((candidate) => isExactMatch(candidate) || isCredible(candidate))
    .sort((a, b) =>
      b.score - a.score ||
      Number(Boolean(b.exact_id || b.exact_raw || b.exact_key)) -
        Number(Boolean(a.exact_id || a.exact_raw || a.exact_key)) ||
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
          ...pick(c.account, CANDIDATE_FIELDS),
          match_type: matchMethod(c),
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

  // A single credible candidate is not automatically the intended account.
  // Only an exact identifier match may resolve.
  if (!isExactMatch(best)) {
    return envelope({
      status: "blocked",
      data: {
        outcome: "confirmation_required",
        reason: REASON.CONFIRMATION_REQUIRED,
        account_reference: accountReference,
        search_term: searchTerm,
        candidates: [
          {
            account_id: best.account.account_id,
            name: best.account.name,
            ...pick(best.account, CANDIDATE_FIELDS),
            match_type: matchMethod(best),
            score: best.score,
            matched_tokens: best.matched_tokens,
          },
        ],
        confirmation_needed:
          "Confirm this is the intended account, then call again with its exact account ID or canonical name.",
      },
      startedAt,
      errors: [
        {
          code: "CONFIRMATION_REQUIRED",
          message: `"${accountReference}" only partially matches "${best.account.name}"; the account must be confirmed before use.`,
          retryable: false,
          details: { candidate_count: 1, match_type: matchMethod(best), score: best.score },
          occurred_at: startedAt,
        },
      ],
    });
  }

  return envelope({
    status: "success",
    data: {
      outcome: "resolved",
      account_reference: accountReference,
      search_term: searchTerm,
      account: {
        account_id: best.account.account_id,
        name: best.account.name,
        ...pick(best.account, IDENTIFIER_FIELDS),
      },
      match: {
        method: matchMethod(best),
        score: best.score,
        matched_tokens: best.matched_tokens,
        rules_version: "matching-rules-0.1.1",
        min_credible_score: MATCHING_RULES.MIN_CREDIBLE_SCORE,
      },
    },
    startedAt,
    warnings: [],
  });
}

export default resolveAccount;
