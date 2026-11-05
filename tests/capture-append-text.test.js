import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCapture } from "../adapters/mcp/index.js";
import { NORTHWIND_ACCOUNT_ID } from "./helpers/salesforce-scenarios.js";
import { sfOk, sid } from "./helpers/salesforce-capture.js";
import { m365Error, m365Hit, m365Page } from "./helpers/m365-capture.js";

/** `--result-text-file` (raw sharepoint_search text) and the duplicate-key guard of `--append`. */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const M365_FIXTURE = resolve(root, "fixtures/m365-northwind/capture.json");
const MAPPING = resolve(root, "fixtures/m365-northwind/mapping.yaml");
const tmp = mkdtempSync(join(tmpdir(), "capture-append-text-"));
const work = join(root, ".captures", `test-append-text-${process.pid}-${Date.now()}`);
mkdirSync(join(work, "tmp"), { recursive: true });
test.after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const SENTINEL = "SYNTHETIC-PAYLOAD-SENTINEL-9c1d";
const SF_CLI = "bin/salesforce-capture-plan.js";
const M365_CLI = "bin/m365-capture-plan.js";
let counter = 0;

function cli(script, args) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const rel = (path) => relative(root, path).replace(/\\/g, "/");

function skeleton(script, extra) {
  counter += 1;
  const path = join(work, `capture-${counter}.json`);
  const result = cli(script, ["--init-capture", rel(path), ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return path;
}
const m365Skeleton = () => skeleton(M365_CLI, []);
const sfSkeleton = () => skeleton(SF_CLI, ["--source-system", "salesforce"]);

/** A payload file under .captures/ (written verbatim). */
function file(content) {
  counter += 1;
  const path = join(work, "tmp", `r${counter}.txt`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}
const entriesOf = (path) => JSON.parse(readFileSync(path, "utf8")).entries;
const m365Append = (capture, extra) => cli(M365_CLI, ["--append", rel(capture), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING, ...extra]);
const sfAppend = (capture, extra) => cli(SF_CLI, ["--append", rel(capture), "--account-id", NORTHWIND_ACCOUNT_ID, ...extra]);
const noPayload = (result) => assert.ok(!`${result.stdout}${result.stderr}`.includes(SENTINEL), "payload content reached stdout or stderr");

function assertRefused(result, message, capture, before) {
  assert.equal(result.status, 1, `expected exit 1, stdout: ${result.stdout}`);
  assert.equal(result.stdout, "", "a refusal prints nothing on stdout");
  assert.match(result.stderr, message);
  noPayload(result);
  assert.ok(!result.stderr.includes("dupkey"), "a refusal never echoes a key");
  assert.equal(readFileSync(capture, "utf8"), before, "the capture file must be unchanged");
}

/** The fixture's two recorded searches. */
const fixtureEntries = JSON.parse(readFileSync(M365_FIXTURE, "utf8")).entries;
/** Raw connector text for a fixture entry: its text blocks concatenated, as `sharepoint_search` prints them. */
const rawText = (entry, separator) => entry.result.content.map((block) => block.text).join(separator);

// ---------------------------------------------------------------- --result-text-file

test("--result-text-file produces entries identical to the fixtures' for the same hits, whatever sits between the objects", () => {
  for (const separator of ["", "\n", "\r\n\r\n", "  \t "]) {
    const capture = m365Skeleton();
    fixtureEntries.forEach((fixture, index) => {
      const result = m365Append(capture, ["--step", `search_${index + 1}`, "--result-text-file", rel(file(`${separator}${rawText(fixture, separator)}${separator}`)), "--captured-at", fixture.captured_at]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(entriesOf(capture)[index], fixture, `entry ${index} (separator ${JSON.stringify(separator)})`);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.outcome, "result");
      assert.equal(summary.hits, fixture.result.content.length - 1);
      assert.equal(summary.result_is_error, false);
    });
    loadCapture(capture); // schema-valid
    const validation = cli(M365_CLI, ["--validate", rel(capture), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING]);
    assert.equal(validation.status, 0, validation.stdout);
  }
});

test("--result-text-file stores each object's original text, braces and escapes in strings included", () => {
  const capture = m365Skeleton();
  const hit = m365Hit({ n: 1, content: 'Example } { "quoted" \\ \\"x\\" é<ddd/>' });
  const original = JSON.stringify(hit);
  const spaced = `{ "totalResultCount" :  1 }`; // not re-serialised: stored as written
  const result = m365Append(capture, ["--step", "search_1", "--result-text-file", rel(file(`${original}\n${spaced}`))]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entriesOf(capture)[0].result, { content: [{ type: "text", text: original }, { type: "text", text: spaced }] });
  assert.equal(JSON.parse(result.stdout).hits, 1);
});

test("--result-text-file: empty or blank text is {content: []}; a BOM is tolerated", () => {
  for (const [index, text] of ["", "\n", " \r\n\t ", "﻿"].entries()) {
    const capture = m365Skeleton();
    const result = m365Append(capture, ["--step", "search_1", "--result-text-file", rel(file(text))]);
    assert.equal(result.status, 0, `${index}: ${result.stderr}`);
    assert.deepEqual(entriesOf(capture)[0].result, { content: [] });
    assert.equal(JSON.parse(result.stdout).hits, 0);
  }
  const capture = m365Skeleton();
  const bom = m365Append(capture, ["--step", "search_1", "--result-text-file", rel(file(`﻿${JSON.stringify(m365Hit({ n: 1 }))}`))]);
  assert.equal(bom.status, 0, bom.stderr);
  assert.equal(entriesOf(capture)[0].result.content.length, 1);
});

test("--result-text-file and --result-file give the same entry for the same page; pagination and --replace-last work", () => {
  const hits = [m365Hit({ n: 1 }), m365Hit({ n: 2 })];
  const trailer = { moreResults: true, nextOffset: 2, totalResultCount: 4, note: "synthetic" };
  const viaFile = m365Skeleton();
  const viaText = m365Skeleton();
  const wrapped = m365Page(hits, trailer);
  const text = [...hits, trailer].map((value) => JSON.stringify(value)).join("\n");
  const common = ["--step", "search_1", "--captured-at", "2026-11-05T10:00:05Z"];
  assert.equal(m365Append(viaFile, [...common, "--result-file", rel(file(wrapped))]).status, 0);
  const first = m365Append(viaText, [...common, "--result-text-file", rel(file(text))]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(entriesOf(viaText), entriesOf(viaFile));
  assert.equal(JSON.parse(first.stdout).more_results, true);
  assert.equal(JSON.parse(first.stdout).next_offset, 2);

  const next = m365Append(viaText, ["--step", "search_1", "--offset", "2", "--result-text-file", rel(file(JSON.stringify(m365Hit({ n: 3 }))))]);
  assert.equal(next.status, 0, next.stderr);
  const replaced = m365Append(viaText, ["--step", "search_1", "--offset", "2", "--replace-last", "--result-text-file", rel(file(`${JSON.stringify(m365Hit({ n: 4 }))}\n{"totalResultCount":1}`))]);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(replaced.stdout).replaced_last, true);
  assert.equal(entriesOf(viaText).length, 2);
});

test("--result-text-file refuses text that is not a sequence of JSON objects, with fixed text and no change", () => {
  const capture = m365Skeleton();
  const before = readFileSync(capture, "utf8");
  const hit = JSON.stringify(m365Hit({ n: 1, name: `Example ${SENTINEL}.docx` }));
  const cases = [
    `not json ${SENTINEL}`,
    `${hit},${hit}`,
    `${hit}\n${SENTINEL}`,
    `[${hit}]`,
    JSON.stringify({ content: [{ type: "text", text: hit }] }).slice(0, -3), // truncated
    hit.slice(0, -2),
    `${hit}}`,
    `"${SENTINEL}"`,
    `${hit}\n[1]`,
    `{"a": ${SENTINEL}}`,
  ];
  for (const text of cases) {
    assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(file(text))]),
      /--result-text-file file is not a sequence of JSON objects; nothing was changed\./, capture, before);
  }
  assert.ok(readdirSync(work).every((name) => !name.endsWith(".tmp") && !name.endsWith(".lock")), "no temp or lock file is left behind");
});

test("--result-text-file: exactly one payload flag, M365 only, and the same .captures/ rules as --result-file", () => {
  const capture = m365Skeleton();
  const before = readFileSync(capture, "utf8");
  const text = file(JSON.stringify(m365Hit({ n: 1 })));
  const json = file(m365Page([m365Hit({ n: 1 })]));
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(text), "--result-file", rel(json)]), /--append needs exactly one of --result-file, --result-text-file and --error-file/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(text), "--error-file", rel(json)]), /--append needs exactly one of/, capture, before);
  const outside = join(tmp, "outside.txt");
  writeFileSync(outside, JSON.stringify(m365Hit({ n: 1 })));
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", outside]), /--result-text-file must be a file under the repository's \.captures\/ directory/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(join(work, "tmp", "missing.txt"))]), /--result-text-file must be an existing file/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(capture)]), /must not be the capture file itself/, capture, before);
  const notAppend = cli(M365_CLI, ["--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING, "--result-text-file", rel(text)]);
  assert.equal(notAppend.status, 1);
  assert.match(notAppend.stderr, /--result-text-file is only valid with --append/);
  const sf = cli(SF_CLI, ["--append", rel(sfSkeleton()), "--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account", "--result-text-file", rel(text)]);
  assert.equal(sf.status, 1);
  assert.match(sf.stderr, /Unknown option: --result-text-file/);
  assert.ok(cli(M365_CLI, ["--help"]).stdout.includes("--result-text-file"));
});

// ---------------------------------------------------------------- duplicate-key guard

const DUPLICATE_PAYLOADS = {
  "top level": '{"a":1,"dupkey":1,"dupkey":2}',
  nested: '{"a":{"b":{"dupkey":1,"dupkey":1}}}',
  "inside an array": '{"records":[{"Id":"x"},{"dupkey":"v1","dupkey":"v2"}]}',
  "escaped spelling": '{"dupkey":1,"dup\\u006bey":2}',
  "after other members": '{"dupkey":1,"b":{"c":[1,2]},"dupkey":3}',
};

test("--append refuses a result or error file with a duplicate key in any object (both CLIs), without echoing the key or value", () => {
  const sf = sfSkeleton();
  const m365 = m365Skeleton();
  const sfBefore = readFileSync(sf, "utf8");
  const m365Before = readFileSync(m365, "utf8");
  for (const text of Object.values(DUPLICATE_PAYLOADS)) {
    const message = /--(?:result|error)-file file contains an object with duplicate keys, which would collapse silently; fix the file\. Nothing was changed\./;
    assertRefused(sfAppend(sf, ["--step", "Account", "--result-file", rel(file(text))]), message, sf, sfBefore);
    assertRefused(sfAppend(sf, ["--step", "Account", "--error-file", rel(file(text))]), /--error-file file contains an object with duplicate keys/, sf, sfBefore);
    assertRefused(m365Append(m365, ["--step", "search_1", "--result-file", rel(file(text))]), message, m365, m365Before);
    assertRefused(m365Append(m365, ["--step", "search_1", "--error-file", rel(file(text))]), /--error-file file contains an object with duplicate keys/, m365, m365Before);
  }
  // a value that merely equals another key, or the same key in sibling objects, is fine
  const fine = '{"a":"a","b":{"a":1},"c":[{"a":1},{"a":2}]}';
  assert.equal(sfAppend(sf, ["--step", "Account", "--result-file", rel(file(fine))]).status, 0);
});

test("a duplicate key in any object of a --result-text-file value is refused too", () => {
  const capture = m365Skeleton();
  const before = readFileSync(capture, "utf8");
  const hit = JSON.stringify(m365Hit({ n: 1 }));
  for (const text of Object.values(DUPLICATE_PAYLOADS)) {
    assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(file(`${hit}\n${text}`))]),
      /--result-text-file file contains an object with duplicate keys, which would collapse silently/, capture, before);
  }
  const hitWithDup = `${hit.slice(0, -1)},"name":"${SENTINEL}"}`; // the hit already has a "name"
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-text-file", rel(file(hitWithDup))]), /duplicate keys/, capture, before);
});

test("the duplicate-key guard does not affect a valid payload with distinct keys, or a recorded error", () => {
  const capture = m365Skeleton();
  const ok = m365Append(capture, ["--step", "search_1", "--error-file", rel(file(m365Error(429, { retryAfter: 3 })))]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).outcome, "error");
  const retried = m365Append(capture, ["--step", "search_1", "--replace-last", "--result-file", rel(file(m365Page([m365Hit({ n: 1 })])))]);
  assert.equal(retried.status, 0, retried.stderr);
  const sf = sfSkeleton();
  assert.equal(sfAppend(sf, ["--step", "Account", "--result-file", rel(file(sfOk("Account", [{ Id: sid("001", 1), Name: "Example" }])))]).status, 0);
});
