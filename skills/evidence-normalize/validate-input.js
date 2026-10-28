/**
 * A resolved account ID is a single identifier token. Account names contain
 * spaces, which makes "Northstar Logistics" fail this pattern: the skill
 * never accepts an unresolved name in place of an account ID. Same rule as
 * evidence-retrieve/validate-input.js.
 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export const MAX_RECORDS = 500;

/**
 * Validate and normalize evidence.normalize input.
 *
 * Returns {ok: true, value} or {ok: false, errors}. Record contents are NOT
 * validated here: records are processed one by one so that a bad record can
 * be rejected without failing the whole request. Only request-level problems
 * (account_id, records not being an array) fail here.
 *
 * @param {unknown} input
 */
export function validateInput(input) {
  const errors = [];
  const fail = (message, details) => errors.push({
    code: "INVALID_INPUT",
    message,
    retryable: false,
    ...(details ? { details } : {}),
  });

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Input must be an object.");
    return { ok: false, errors };
  }

  let accountId = "";
  const rawAccountId = input.account_id;
  if (typeof rawAccountId !== "string" || rawAccountId.trim() === "") {
    fail("account_id is required and must be a non-empty string.");
  } else {
    accountId = rawAccountId.trim();
    if (/\s/.test(accountId)) {
      fail(
        "account_id must be a resolved account identifier, not an account name; resolve the account first.",
        { provided: accountId },
      );
    } else if (DOMAIN_SHAPE.test(accountId)) {
      fail(
        "account_id looks like a domain reference, not a resolved account identifier; resolve the account first.",
        { provided: accountId },
      );
    } else if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      fail("account_id does not match the accepted identifier format.", { provided: accountId });
    }
  }

  if (!Array.isArray(input.records)) {
    fail("records is required and must be an array.");
  } else if (input.records.length > MAX_RECORDS) {
    fail("records must contain at most " + MAX_RECORDS + " entries.");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { account_id: accountId, records: input.records } };
}