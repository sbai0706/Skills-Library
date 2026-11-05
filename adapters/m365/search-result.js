import { classifyIsErrorResult } from "./errors.js";

/**
 * Parser for the raw `sharepoint_search` tool result (P4 design section 3.3).
 *
 * The tool returns one MCP text block per hit (a JSON object with a string `uri`) plus a final
 * trailer block (`{totalResultCount, moreResults?, nextOffset?, note?}`); zero hits come back as
 * `{content: []}`. `unwrapToolResult` cannot be used for success (it needs one JSON block).
 *
 * @returns {{ok: true, hits: object[], trailer: object|null} | {ok: false, error: object}}
 */

const malformed = (reason) => ({
  ok: false,
  error: {
    code: "ADAPTER_MALFORMED_RESPONSE",
    message: "Microsoft 365 search result is malformed.",
    retryable: false,
    details: { reason: "malformed_search_result", detail: reason },
  },
});

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseSearchResult(result) {
  if (!isObject(result)) return malformed("not_an_object");
  if (result.isError === true) return { ok: false, error: classifyIsErrorResult(result) };
  if (result.structuredContent !== undefined) return malformed("structured_content_present");
  if (!Array.isArray(result.content)) return malformed("content_invalid");
  const hits = [];
  let trailer = null;
  for (let index = 0; index < result.content.length; index += 1) {
    const block = result.content[index];
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return malformed("non_text_block");
    if (trailer !== null) return malformed("trailer_not_last");
    let value;
    try { value = JSON.parse(block.text); } catch { return malformed("unparsable_block"); }
    if (!isObject(value)) return malformed("unknown_block");
    if (typeof value.uri === "string") {
      hits.push(value);
    } else if (Number.isInteger(value.totalResultCount) && value.totalResultCount >= 0) {
      if (value.moreResults !== undefined && typeof value.moreResults !== "boolean") return malformed("invalid_trailer");
      trailer = value;
    } else {
      return malformed("unknown_block");
    }
  }
  return { ok: true, hits, trailer };
}
