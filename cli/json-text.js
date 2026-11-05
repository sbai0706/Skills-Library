/**
 * Small, dependency-free JSON text helpers for the capture `--append` tool.
 *
 * - `splitJsonObjects(text)`: streaming scanner that splits raw text holding several concatenated
 *   top-level JSON objects (the raw `sharepoint_search` connector text) into each value's
 *   original text. No regular expressions; strings and escapes are tracked, so braces inside
 *   string values never confuse it.
 * - `hasDuplicateKeys(text)`: true when any object in a JSON document repeats a key (after
 *   decoding escapes), which `JSON.parse` would silently collapse.
 *
 * Neither function ever includes input content in what it throws or returns.
 */

const isWhitespace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** Index of the closing quote of the string literal that opens at `start` (a `"`), or -1. */
function skipString(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 0x5c) index += 1; // backslash: skip the escaped character
    else if (char === 0x22) return index;
  }
  return -1;
}

/**
 * Split text into the original texts of its top-level JSON objects. Whitespace (spaces, tabs,
 * newlines) between values is tolerated; nothing else is (no commas, no arrays, no scalars).
 * @param {string} text
 * @returns {string[]} the original text of each object, in order (an empty array for blank text)
 * @throws {SyntaxError} fixed message; when the text is not a sequence of well-formed JSON objects
 */
export function splitJsonObjects(text) {
  const fail = () => { throw new SyntaxError("not a sequence of JSON objects"); };
  const values = [];
  let index = 0;
  while (index < text.length) {
    if (isWhitespace(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    if (text[index] !== "{") fail();
    const start = index;
    let depth = 0;
    let closed = false;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        index = skipString(text, index);
        if (index === -1) fail();
      } else if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth < 0) fail();
        if (depth === 0) {
          if (char !== "}") fail();
          closed = true;
          index += 1;
          break;
        }
      }
    }
    if (!closed) fail();
    const value = text.slice(start, index);
    let parsed;
    try { parsed = JSON.parse(value); } catch { fail(); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail();
    values.push(value);
  }
  return values;
}

/**
 * True when any JSON object in `text` has two members with the same key (compared after decoding
 * escapes, so `"a"` and `"a"` are the same key). The text must already be valid JSON
 * (callers run `JSON.parse` first); iterative, so deep nesting cannot overflow the stack.
 * @param {string} text
 * @returns {boolean}
 */
export function hasDuplicateKeys(text) {
  const stack = []; // one entry per open container: a Set of keys (object) or null (array)
  let expectKey = false; // inside an object, the next string is a key
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = skipString(text, index);
      if (end === -1) return false; // not valid JSON; the caller's JSON.parse decides
      if (expectKey) {
        let key;
        try { key = JSON.parse(text.slice(index, end + 1)); } catch { return false; }
        const keys = stack[stack.length - 1];
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      index = end;
    } else if (char === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (char === "[") {
      stack.push(null);
      expectKey = false;
    } else if (char === "}" || char === "]") {
      stack.pop();
      expectKey = false;
    } else if (char === ",") {
      expectKey = stack.length > 0 && stack[stack.length - 1] !== null;
    }
  }
  return false;
}
