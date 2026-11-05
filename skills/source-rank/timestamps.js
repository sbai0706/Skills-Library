/**
 * Clock-free, strict RFC 3339 `date-time` parsing for source.rank.
 *
 * Only a string with a date, a time and an explicit offset is usable. Anything else that is present
 * (wrong type, empty string, impossible calendar date, missing offset) is reported as invalid by the
 * caller and treated as missing. Nothing here reads the system clock.
 */

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

const DAY_MS = 86_400_000;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parse an RFC 3339 date-time string to epoch milliseconds (UTC).
 * @param {unknown} value
 * @returns {number|null} epoch milliseconds, or null when the value is not a usable date-time
 */
export function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = DATE_TIME.exec(value);
  if (!match) return null;

  const [, y, mo, d, h, mi, s, fraction, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const millis = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // Date.UTC maps years 0-99 to 1900-1999; reject them rather than misread them.
  if (year < 100 || !Number.isFinite(utc)) return null;
  return utc - offsetMinutes * 60_000;
}

/** Format epoch milliseconds as a UTC ISO string without a redundant ".000" fraction. */
export function formatTimestamp(epochMs) {
  return new Date(epochMs).toISOString().replace(".000Z", "Z");
}

/** Whole days from `fromMs` to `nowMs`; negative when `fromMs` is later than `nowMs`. */
export function ageInDays(fromMs, nowMs) {
  return Math.floor((nowMs - fromMs) / DAY_MS);
}
