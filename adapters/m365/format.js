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

/**
 * Parse a document `webUrl` into `{host, segments}` from the RAW string (WHATWG URL parsing would
 * silently resolve `..`, so it is not used for the path). The path is split on `/` and each
 * segment is percent-decoded once. Returns null (the hit counts as outside every mapping) for:
 * a non-https URL, userinfo, a port, a query-less/fragment-less cut that leaves no path, an empty
 * segment, a `.` or `..` segment (raw or decoded), a segment that contains `/` or `\` after
 * decoding, or a malformed percent escape.
 */
export function parseWebUrl(webUrl) {
  if (typeof webUrl !== "string") return null;
  const match = /^https:\/\/([^/?#]*)([^?#]*)/i.exec(webUrl.trim());
  if (!match) return null;
  const authority = match[1];
  if (authority === "" || /[@:\s]/.test(authority)) return null;
  const rawSegments = match[2].split("/").slice(1);
  if (rawSegments.length === 0) return null;
  const segments = [];
  for (const raw of rawSegments) {
    if (raw === "" || raw === "." || raw === "..") return null;
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) return null;
    segments.push(decoded);
  }
  return { host: authority.toLowerCase(), segments };
}

/** Decoded folder path (host omitted, final file segment dropped), from the same segments that were matched. */
export function locationOf(webUrl) {
  const parsed = parseWebUrl(webUrl);
  return cutTo(cleanText(`/${(parsed?.segments ?? []).slice(0, -1).join("/")}`), LOCATION_MAX);
}

/** Decoded segment after `/sites/` or `/teams/`, cleaned, from the same segments that were matched. */
export function siteOf(webUrl) {
  return cleanText(parseWebUrl(webUrl)?.segments[1] ?? "");
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
  let stripped = source;
  for (let previous = null; previous !== stripped;) {
    previous = stripped;
    stripped = stripped.replace(/<\/?c\d+>/gi, "").replace(/<ddd\s*\/>/gi, " ... ");
  }
  const text = cleanText(stripped);
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
