import { validate } from "../../schemas/index.js";
import { parseTimestamp } from "./timestamps.js";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/**
 * Request-level validation. Per-item validation (account scope, schema shape, duplicates) happens in
 * index.js so that one bad item never fails the whole request.
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: object[]}}
 */
export function validateInput(input) {
  const errors = [];
  const fail = (message, details) =>
    errors.push({
      code: "INVALID_INPUT",
      message,
      retryable: false,
      ...(details ? { details } : {}),
    });

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Input must be an object.");
    return { ok: false, errors };
  }

  const structural = validate("sourceRankInput", input);
  if (!structural.valid) {
    for (const problem of structural.errors) {
      fail("Input does not match the source.rank input schema.", {
        path: problem.path,
        reason: problem.message,
      });
    }
    return { ok: false, errors };
  }

  const accountId = input.account_id.trim();
  if (/\s/.test(accountId)) {
    fail("account_id must be a resolved account identifier, not an account name; resolve the account first.");
  } else if (DOMAIN_SHAPE.test(accountId)) {
    fail("account_id looks like a domain reference, not a resolved account identifier; resolve the account first.");
  } else if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    fail("account_id does not match the accepted identifier format.");
  }

  let nowMs = null;
  if (input.now !== undefined) {
    nowMs = parseTimestamp(input.now);
    if (nowMs === null) fail("now must be a valid RFC 3339 date-time with an explicit offset.");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      account_id: accountId,
      records: input.records ?? [],
      evidence: input.evidence ?? [],
      nowMs,
    },
  };
}
