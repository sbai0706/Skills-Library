import { MAX_VALUE_LENGTH } from "./constants.js";
import { SfAdapterError, malformed } from "./errors.js";

/** Replace control characters and whitespace runs with one space; trim. */
export function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
}

function bad(reason, extra) {
  return new SfAdapterError(malformed(reason, extra));
}

/** True for a real calendar day (no month/day rollover, e.g. 2026-02-31 is not). */
function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Salesforce `2026-03-01T10:00:00.000+0000` -> `2026-03-01T10:00:00.000Z`. Invalid -> malformed. */
export function normalizeDateTime(raw) {
  if (typeof raw !== "string") throw bad("invalid_datetime");
  const text = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) throw bad("invalid_datetime");
  const [, year, month, day, hour, minute, second] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!isRealDate(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw bad("invalid_datetime");
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = Date.parse(normalized);
  if (Number.isNaN(time)) throw bad("invalid_datetime");
  return new Date(time).toISOString();
}

/** Like normalizeDateTime but absent (null/blank) -> null. */
export function optionalDateTime(raw) {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "") ? null : normalizeDateTime(raw);
}

/**
 * Salesforce `date` (`2026-10-01`) -> `2026-10-01T00:00:00.000Z`; absent -> null; wrong shape ->
 * malformed; an impossible calendar date (`2026-02-31`) is treated as missing (null) so the next
 * `occurred_at` fallback applies.
 */
export function dateToDateTime(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw bad("value_type_mismatch", { value_type: "date" });
  if (raw.trim() === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw bad("invalid_date");
  return isRealDate(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)), Number(raw.slice(8, 10))) ? `${raw}T00:00:00.000Z` : null;
}

function cut(text) {
  const chars = [...text];
  return chars.length > MAX_VALUE_LENGTH ? `${chars.slice(0, MAX_VALUE_LENGTH).join("")} [truncated]` : text;
}

const TEXT_TYPES = new Set(["string", "picklist", "combobox", "url", "textarea", "multipicklist"]);

/**
 * Format a raw field value as a content/claim string. Returns null when the value is absent
 * (null, undefined, blank). A wrong JSON type for the declared type is malformed (no repair).
 */
export function formatValue(type, raw) {
  if (raw === null || raw === undefined) return null;
  if (TEXT_TYPES.has(type)) {
    if (typeof raw !== "string") throw bad("value_type_mismatch", { value_type: type });
    const text = cleanText(raw);
    return text === "" ? null : cut(text);
  }
  if (type === "int" || type === "double" || type === "currency" || type === "percent") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw bad("value_type_mismatch", { value_type: type });
    return type === "percent" ? `${String(raw)}%` : String(raw);
  }
  if (type === "date") {
    if (typeof raw !== "string") throw bad("value_type_mismatch", { value_type: type });
    if (raw.trim() === "") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw bad("invalid_date");
    return raw;
  }
  if (type === "datetime") {
    if (typeof raw === "string" && raw.trim() === "") return null;
    return normalizeDateTime(raw);
  }
  throw bad("unknown_value_type", { value_type: String(type) });
}

/** `Salesforce Opportunity "Phoenix Upgrade"` */
export function headerLine(objectName, recordName) {
  return `Salesforce ${objectName} "${recordName}"`;
}

/** `Opportunity "Phoenix Upgrade" - Stage [StageName]: Awareness` (`[api]` only when label differs). */
export function fieldLine(objectName, recordName, { api, label, value }) {
  return `${objectName} "${recordName}" - ${label}${label === api ? "" : ` [${api}]`}: ${value}`;
}

/** The field line minus ` -` and `[api]`: `Opportunity "Phoenix Upgrade" Stage: Awareness`. */
export function fieldClaim(objectName, recordName, { label, value }) {
  return `${objectName} "${recordName}" ${label}: ${value}`;
}

/** `Opportunity "Phoenix Upgrade" - Last modified: 2026-10-20T12:30:00.000Z` (content only, never a claim). */
export function lastModifiedLine(objectName, recordName, isoDateTime) {
  return `${objectName} "${recordName}" - Last modified: ${isoDateTime}`;
}
