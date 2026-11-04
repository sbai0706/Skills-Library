import { DEFAULT_CLAIM_LIMITS } from "./constants.js";
import { optionalDateTime } from "./format.js";

/**
 * Brief-size limits; user decision 2026-11-04; selection is ordering only, not prioritisation
 * policy. Per object, the primary date (an already-selected field) sorts descending with nulls
 * last, then LastModifiedDate descending, then Id ascending. No stage/status value is interpreted.
 */
const PRIMARY_DATE = Object.freeze({
  Opportunity: (row) => (typeof row.CloseDate === "string" && row.CloseDate !== "" ? row.CloseDate : null),
  Task: (row) => (typeof row.ActivityDate === "string" && row.ActivityDate !== "" ? row.ActivityDate : null),
  Event: (row) => optionalDateTime(row.StartDateTime),
  Contact: () => null,
});

/** Validate claim limits (may only LOWER the defaults) and merge with the defaults. */
export function resolveClaimLimits(limits = {}) {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) throw new TypeError("claimLimits must be an object");
  const effective = { ...DEFAULT_CLAIM_LIMITS };
  for (const [objectName, value] of Object.entries(limits)) {
    if (!(objectName in DEFAULT_CLAIM_LIMITS)) throw new TypeError(`claimLimits: unknown object ${objectName}`);
    if (!Number.isInteger(value) || value < 0 || value > DEFAULT_CLAIM_LIMITS[objectName]) {
      throw new TypeError(`claimLimits.${objectName} must be an integer between 0 and ${DEFAULT_CLAIM_LIMITS[objectName]}`);
    }
    effective[objectName] = value;
  }
  return effective;
}

const descNullsLast = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a > b ? -1 : 1);

/** Ids of the rows that may produce claims (all rows when the object has no cap or is under it). */
export function selectClaimRowIds(objectName, rows, cap) {
  if (cap === undefined || rows.length <= cap) return new Set(rows.map((row) => row.Id));
  const primary = PRIMARY_DATE[objectName];
  const keyed = rows.map((row) => ({ id: row.Id, p: primary(row), m: optionalDateTime(row.LastModifiedDate) }));
  keyed.sort((a, b) => descNullsLast(a.p, b.p) || descNullsLast(a.m, b.m) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(keyed.slice(0, cap).map((entry) => entry.id));
}
