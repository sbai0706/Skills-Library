import { LOCATION_MAX, NAME_MAX, SNIPPET_MAX } from "./constants.js";

/** Replace control characters and whitespace runs with one space; trim. */
export function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
}

const cutTo = (text, max) => {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
};

/** File name as used in lines, claims and metadata: cleaned and cut to NAME_MAX code points. */
export function displayName(name) {
  return cutTo(cleanText(name), NAME_MAX);
}

/** Lower-cased text after the last `.` when it is 1-10 alphanumerics, else null. */
export function fileTypeOf(name) {
  if (typeof name !== "string") return null;
  const index = name.lastIndexOf(".");
  if (index < 0) return null;
  const extension = name.slice(index + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : null;
}

export function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** Decoded pathname without the final (file) segment, host omitted, cleaned and cut. */
export function locationOf(webUrl) {
  const pathname = safeDecode(new URL(webUrl).pathname);
  const index = pathname.lastIndexOf("/");
  return cutTo(cleanText(index > 0 ? pathname.slice(0, index) : pathname), LOCATION_MAX);
}

/** Decoded segment after `/sites/` or `/teams/`, cleaned. */
export function siteOf(webUrl) {
  const segments = safeDecode(new URL(webUrl).pathname).split("/").filter((segment) => segment !== "");
  return cleanText(segments[1] ?? "");
}

/**
 * Cleaned search snippet or null. Source = `content`, else `summary`. Removes `<cN>` highlight
 * tags (keeping their text), turns `<ddd/>` into ` ... `, collapses whitespace, cuts to
 * SNIPPET_MAX code points plus ` [truncated]`. Empty or equal to the cleaned file name -> null.
 */
export function cleanSnippet(hit) {
  const source = typeof hit.content === "string" && hit.content.trim() !== ""
    ? hit.content
    : typeof hit.summary === "string" && hit.summary.trim() !== "" ? hit.summary : null;
  if (source === null) return null;
  const text = cleanText(source.replace(/<\/?c\d+>/g, "").replace(/<ddd\s*\/>/g, " ... "));
  if (text === "" || text === cleanText(hit.name)) return null;
  const chars = [...text];
  return chars.length > SNIPPET_MAX ? `${chars.slice(0, SNIPPET_MAX).join("")} [truncated]` : text;
}

/** `SharePoint document "Example Proposal.pptx"` */
export function headerLine(name) {
  return `SharePoint document "${name}"`;
}

/** `SharePoint document "Example Proposal.pptx" - Last modified: 2026-09-03T15:28:28.000Z` */
export function fieldLine(name, label, value) {
  return `${headerLine(name)} - ${label}: ${value}`;
}

/** The field line minus ` -`: `SharePoint document "Example Proposal.pptx" Last modified: ...` */
export function fieldClaim(name, label, value) {
  return `${headerLine(name)} ${label}: ${value}`;
}

export const SNIPPET_LABEL = "Search snippet (free text from the search index; not a claim; may contain personal or customer data):";
