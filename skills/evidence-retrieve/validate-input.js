import { EVIDENCE_SOURCE_IDS } from "../../adapters/evidence-adapter.js";

export const MAX_QUESTIONS = 50;
export const MAX_SOURCES = EVIDENCE_SOURCE_IDS.length;

/**
 * A resolved account ID is a single identifier token. Account names contain
 * spaces, which makes "Northstar Logistics" fail this pattern: the skill never
 * accepts an unresolved name in place of an account ID.
 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
/** A bare domain is an account reference, not a resolved account identifier. */
const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Validate and normalize evidence.retrieve input.
 *
 * Returns {ok: true, value} or {ok: false, errors} where every error is a
 * structured error entry ready for the result envelope. Nothing is repaired:
 * an invalid field is reported, not coerced.
 *
 * @param {unknown} input
 * @returns {{ok: true, value: {account_id: string, questions: {id: string, text: string}[], requested_sources: string[], context: object}} | {ok: false, errors: object[]}}
 */
export function validateInput(input) {
  const errors = [];
  const fail = (code, message, details, retryable = false) =>
    errors.push({ code, message, retryable, ...(details ? { details } : {}) });

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_INPUT", "Input must be an object.");
    return { ok: false, errors };
  }

  const rawAccountId = input.account_id;
  let accountId = "";
  if (typeof rawAccountId !== "string" || rawAccountId.trim() === "") {
    fail("INVALID_INPUT", "account_id is required and must be a non-empty string.");
  } else {
    accountId = rawAccountId.trim();
    if (/\s/.test(accountId)) {
      fail(
        "INVALID_INPUT",
        "account_id must be a resolved account identifier, not an account name; resolve the account first.",
        { provided: accountId },
      );
    } else if (DOMAIN_SHAPE.test(accountId)) {
      fail(
        "INVALID_INPUT",
        "account_id looks like a domain reference, not a resolved account identifier; resolve the account first.",
        { provided: accountId },
      );
    } else if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      fail("INVALID_INPUT", "account_id does not match the accepted identifier format.", {
        provided: accountId,
      });
    }
  }

  const questions = [];
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    fail("INVALID_INPUT", "questions is required and must contain at least one question.");
  } else if (input.questions.length > MAX_QUESTIONS) {
    fail("INVALID_INPUT", `questions must contain at most ${MAX_QUESTIONS} entries.`);
  } else {
    const seen = new Set();
    input.questions.forEach((question, index) => {
      if (typeof question !== "object" || question === null) {
        fail("INVALID_INPUT", `questions[${index}] must be an object.`);
        return;
      }
      const id = typeof question.id === "string" ? question.id.trim() : "";
      const text = typeof question.text === "string" ? question.text.trim() : "";
      if (id === "" || !QUESTION_ID_PATTERN.test(id)) {
        fail("INVALID_INPUT", `questions[${index}].id must be a stable non-empty identifier.`);
        return;
      }
      if (text === "") {
        fail("INVALID_INPUT", `questions[${index}].text is required for ${id}.`);
        return;
      }
      if (seen.has(id)) {
        fail("INVALID_INPUT", `Duplicate question id "${id}".`, { question_id: id });
        return;
      }
      seen.add(id);
      questions.push({ id, text });
    });
  }

  const requestedSources = [];
  if (!Array.isArray(input.requested_sources) || input.requested_sources.length === 0) {
    fail("INVALID_INPUT", "requested_sources is required and must contain at least one source.");
  } else if (input.requested_sources.length > MAX_SOURCES) {
    fail("INVALID_INPUT", `requested_sources must contain at most ${MAX_SOURCES} entries.`);
  } else {
    for (const [index, source] of input.requested_sources.entries()) {
      if (typeof source !== "string" || source.trim() === "") {
        fail("INVALID_INPUT", `requested_sources[${index}] must be a non-empty string.`);
        continue;
      }
      const normalized = source.trim();
      if (!EVIDENCE_SOURCE_IDS.includes(normalized)) {
        fail("UNSUPPORTED_SOURCE", `Unknown source "${normalized}".`, {
          source: normalized,
          supported_sources: [...EVIDENCE_SOURCE_IDS],
        });
        continue;
      }
      if (requestedSources.includes(normalized)) {
        fail("INVALID_INPUT", `Duplicate requested source "${normalized}".`, { source: normalized });
        continue;
      }
      requestedSources.push(normalized);
    }
  }

  const context = {};
  if (input.context !== undefined) {
    if (typeof input.context !== "object" || input.context === null || Array.isArray(input.context)) {
      fail("INVALID_INPUT", "context must be an object when provided.");
    } else {
      if (input.context.requested_by !== undefined) {
        if (typeof input.context.requested_by !== "string" || input.context.requested_by.trim() === "") {
          fail("INVALID_INPUT", "context.requested_by must be a non-empty string when provided.");
        } else {
          context.requested_by = input.context.requested_by.trim();
        }
      }
      if (input.context.roles !== undefined) {
        if (!Array.isArray(input.context.roles) || input.context.roles.some((r) => typeof r !== "string")) {
          fail("INVALID_INPUT", "context.roles must be an array of strings when provided.");
        } else {
          context.roles = [...input.context.roles];
        }
      }
      if (input.context.permitted_classifications !== undefined) {
        const allowed = ["public", "internal", "confidential"];
        const values = input.context.permitted_classifications;
        if (!Array.isArray(values) || values.some((v) => !allowed.includes(v))) {
          fail("INVALID_INPUT", `context.permitted_classifications must be an array of: ${allowed.join(", ")}.`);
        } else {
          context.permitted_classifications = [...values];
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { account_id: accountId, questions, requested_sources: requestedSources, context },
  };
}
