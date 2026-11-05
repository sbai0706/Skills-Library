import test from "node:test";
import assert from "node:assert/strict";
import { hasDuplicateKeys, splitJsonObjects } from "../cli/json-text.js";

test("splitJsonObjects returns each top-level object's original text, tolerating any whitespace between them", () => {
  const a = '{"uri":"file:///x/1","name":"a } b {"}';
  const b = '{"nested":{"k":[1,2,{"z":"\\"}"}]},"s":"\\\\"}';
  const c = '{"totalResultCount":2}';
  assert.deepEqual(splitJsonObjects(`${a}${b}${c}`), [a, b, c], "touching objects");
  assert.deepEqual(splitJsonObjects(`\n  ${a}\r\n\r\n\t${b} \n${c}\n`), [a, b, c], "newlines, CRLF, tabs and spaces");
  assert.deepEqual(splitJsonObjects("{}"), ["{}"]);
});

test("splitJsonObjects keeps the exact source text (no re-serialisation)", () => {
  const spaced = '{ "a" : 1,\n  "b" :  [ 1 , 2 ] }';
  assert.deepEqual(splitJsonObjects(spaced), [spaced]);
  assert.deepEqual(splitJsonObjects('{"big":12345678901234567890}'), ['{"big":12345678901234567890}']);
});

test("splitJsonObjects: blank text has no values", () => {
  assert.deepEqual(splitJsonObjects(""), []);
  assert.deepEqual(splitJsonObjects(" \n\r\t "), []);
});

test("splitJsonObjects refuses anything that is not a sequence of well-formed objects, with fixed text", () => {
  const bad = [
    "[]", "[{}]", "1", '"s"', "null", "true", "garbage", '{"a":1} garbage', 'garbage {"a":1}', '{"a":1},{"b":2}', '{"a":1};{"b":2}',
    '{"a":1', '{"a":"unterminated}', '{"a":1}}', '{"a":[1}', '{"a":}', "{'a':1}", '{"a":1,}', '{"a" 1}', '{"a":1}\u0000',
  ];
  for (const text of bad) {
    assert.throws(() => splitJsonObjects(text), (error) => error instanceof SyntaxError && error.message === "not a sequence of JSON objects", JSON.stringify(text));
  }
});

test("hasDuplicateKeys finds a repeated key in any object and nowhere else", () => {
  const dup = [
    '{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"x":[{"k":1},{"k":1,"k":2}]}', '{"a":1,"b":{"c":1},"a":3}', '{"a":1,"\\u0061":2}',
    '{ "k" : 1 ,\n "k" : 2 }', '{"a":{"a":1},"b":2,"b":3}', '[{"a":1,"a":1}]',
  ];
  for (const text of dup) assert.equal(hasDuplicateKeys(text), true, text);
  const fine = [
    "{}", "[]", '{"a":1,"b":2}', '{"a":{"a":1},"b":{"a":2}}', '{"a":[{"a":1},{"a":2}]}', '{"a":"a","b":"a"}',
    '{"a":"{\\"b\\":1,\\"b\\":2}"}', '[{"a":1},{"a":2}]', '{"a,b":1,"a":2}', '{"a":"x,\\"y\\"","b":1}', "1", '"s"', "",
  ];
  for (const text of fine) assert.equal(hasDuplicateKeys(text), false, text);
});

test("hasDuplicateKeys is iterative: very deep nesting does not overflow the stack", () => {
  const depth = 50000;
  const text = `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  assert.equal(hasDuplicateKeys(text), false);
  assert.equal(hasDuplicateKeys(`${'{"a":'.repeat(depth)}{"b":1,"b":2}${"}".repeat(depth)}`), true);
});
