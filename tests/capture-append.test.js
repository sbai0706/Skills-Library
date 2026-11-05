import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCapture } from "../adapters/mcp/index.js";
import { searchArgs } from "../adapters/m365/index.js";
import { nextPageArgs } from "../adapters/salesforce/index.js";
import { NORTHWIND_ACCOUNT_ID } from "./helpers/salesforce-scenarios.js";
import { sfError, sfOk, sid } from "./helpers/salesforce-capture.js";
import { m365Error, m365Hit, m365Page, moreTrailer } from "./helpers/m365-capture.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SF_FIXTURE = resolve(root, "fixtures/salesforce-northwind/capture.json");
const M365_FIXTURE = resolve(root, "fixtures/m365-northwind/capture.json");
const MAPPING = resolve(root, "fixtures/m365-northwind/mapping.yaml");
const tmp = mkdtempSync(join(tmpdir(), "capture-append-"));
const work = join(root, ".captures", `test-append-${process.pid}-${Date.now()}`);
mkdirSync(join(work, "tmp"), { recursive: true });
test.after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const SENTINEL = "SYNTHETIC-PAYLOAD-SENTINEL-7f3a";
const SF_CLI = "bin/salesforce-capture-plan.js";
const M365_CLI = "bin/m365-capture-plan.js";
let counter = 0;

function cli(script, args) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const rel = (path) => relative(root, path).replace(/\\/g, "/");

/** Fresh skeleton under .captures/. */
function skeleton(script, sourceSystemArgs) {
  counter += 1;
  const path = join(work, `capture-${counter}.json`);
  const result = cli(script, ["--init-capture", rel(path), ...sourceSystemArgs]);
  assert.equal(result.status, 0, result.stderr);
  return path;
}
const sfSkeleton = () => skeleton(SF_CLI, ["--source-system", "salesforce"]);
const m365Skeleton = () => skeleton(M365_CLI, []);

/** Write a payload file under .captures/ (string content is written verbatim). */
function payload(value) {
  counter += 1;
  const path = join(work, "tmp", `r${counter}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}
const entriesOf = (path) => JSON.parse(readFileSync(path, "utf8")).entries;
const dirListing = () => readdirSync(work).sort();

const sfAppend = (capture, extra) => cli(SF_CLI, ["--append", rel(capture), ...extra]);
const m365Append = (capture, extra) => cli(M365_CLI, ["--append", rel(capture), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING, ...extra]);

const sfRow = (n) => ({ Id: sid("001", n), Name: `Example ${SENTINEL} ${n}` });
const noPayload = (result) => {
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SENTINEL), "payload content reached stdout or stderr");
};

function sfPlan(extra) {
  const result = cli(SF_CLI, extra);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertRefused(result, message, capture, before) {
  assert.equal(result.status, 1, `expected exit 1, stdout: ${result.stdout}`);
  assert.equal(result.stdout, "", "a refusal prints nothing on stdout");
  assert.match(result.stderr, message);
  noPayload(result);
  if (capture !== undefined) assert.equal(readFileSync(capture, "utf8"), before, "the capture file must be unchanged");
}

// ---------------------------------------------------------------- Salesforce: plan steps

test("salesforce: append records every Phase 2 plan step with the plan's own tool and args", () => {
  const capture = sfSkeleton();
  const plan = sfPlan(["--account-id", NORTHWIND_ACCOUNT_ID]);
  assert.equal(plan.calls.length, 5);
  plan.calls.forEach((call, index) => {
    const response = sfOk(call.step, [sfRow(index + 1)]);
    // alternate between the step name and the 1-based position
    const result = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", index % 2 === 0 ? call.step : String(index + 1),
      "--result-file", payload(response), "--captured-at", `2026-11-05T10:00:0${index}Z`]);
    assert.equal(result.status, 0, result.stderr);
    noPayload(result);
    assert.equal(result.stderr, "");
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.appended, true);
    assert.equal(summary.replaced_last, false);
    assert.equal(summary.entry_index, index);
    assert.equal(summary.entries, index + 1);
    assert.equal(summary.tool, "dispatch_readonly");
    assert.equal(summary.step, call.step);
    assert.equal(summary.object, call.step);
    assert.equal(summary.outcome, "result");
    assert.equal(summary.records, 1);
    assert.equal(summary.done, true);
    assert.equal(summary.next_page_pending, false);
    assert.equal(summary.captured_at, `2026-11-05T10:00:0${index}Z`);
    const entry = entriesOf(capture)[index];
    assert.deepEqual(entry, { tool: "dispatch_readonly", args: call.args, result: response, captured_at: `2026-11-05T10:00:0${index}Z` });
  });
  assert.equal(entriesOf(capture).length, 5);
  assert.ok(dirListing().every((name) => !name.endsWith(".tmp")), "no temp file is left behind");
  const loaded = loadCapture(capture);
  assert.equal(loaded.entries.length, 5);
});

test("salesforce: Phase 1 steps (search and exact_name_guard) and the default captured_at", () => {
  const capture = sfSkeleton();
  const plan = sfPlan(["--account", "Northwind Traders"]);
  assert.deepEqual(plan.calls.map((call) => call.step), ["search", "exact_name_guard"]);
  const before = Date.now();
  for (const call of plan.calls) {
    const result = sfAppend(capture, ["--account", "Northwind Traders", "--step", call.step, "--result-file", payload(sfOk("Account", [sfRow(1)]))]);
    assert.equal(result.status, 0, result.stderr);
  }
  const entries = entriesOf(capture);
  assert.deepEqual(entries.map((entry) => entry.args), plan.calls.map((call) => call.args));
  for (const entry of entries) {
    const at = Date.parse(entry.captured_at);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "captured_at is the actual append time");
    assert.match(entry.captured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});

test("salesforce: an error payload is stored as error, and must be a JSON object", () => {
  const capture = sfSkeleton();
  const [call] = sfPlan(["--account", "Northwind Traders"]).calls;
  const bad = sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--error-file", payload("[1,2]")]);
  assertRefused(bad, /--error-file must contain a JSON object/, capture, readFileSync(capture, "utf8"));
  const error = sfError(401, "INVALID_AUTH_HEADER", SENTINEL);
  const result = sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--error-file", payload(error)]);
  assert.equal(result.status, 0, result.stderr);
  noPayload(result);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.outcome, "error");
  assert.equal(summary.records, undefined);
  const [entry] = entriesOf(capture);
  assert.deepEqual(entry.args, call.args);
  assert.deepEqual(entry.error, error, "stored exactly as returned, with no redaction at write time");
  assert.equal(entry.result, undefined);
});

test("salesforce: the stored payload is exactly what was parsed (no normalisation, no redaction)", () => {
  const capture = sfSkeleton();
  const response = { status_code: 200, body: { totalSize: 1, done: true, records: [{ Id: sid("001", 1), Email: "someone@example.invalid", Note: SENTINEL, Nested: { a: [1, null, "x"] } }] }, url: "/q" };
  const result = sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--result-file", payload(JSON.stringify(response, null, 4))]);
  assert.equal(result.status, 0, result.stderr);
  noPayload(result);
  assert.deepEqual(entriesOf(capture)[0].result, response);
  // a UTF-8 byte order mark (for example from Windows PowerShell) does not make a file non-JSON
  const bom = sfAppend(capture, ["--account", "Northwind Traders", "--step", "exact_name_guard", "--result-file", payload(`﻿${JSON.stringify(response)}`)]);
  assert.equal(bom.status, 0, bom.stderr);
});

// ---------------------------------------------------------------- Salesforce: pagination

test("salesforce: --page-url appends the {url, method: GET} page call and only after a recorded done:false result", () => {
  const capture = sfSkeleton();
  const next = "/services/data/v66.0/query/01gSYN000000000001-2000";
  const orphan = sfAppend(capture, ["--page-url", next, "--result-file", payload(sfOk("Contact", [sfRow(9)]))]);
  assertRefused(orphan, /--page-url must be the nextRecordsUrl of an already recorded result/, capture, readFileSync(capture, "utf8"));

  const first = sfOk("Contact", [sfRow(1)], { done: false, nextRecordsUrl: next, totalSize: 2 });
  const planStep = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Contact", "--result-file", payload(first)]);
  assert.equal(planStep.status, 0, planStep.stderr);
  assert.equal(JSON.parse(planStep.stdout).next_page_pending, true);

  const wrong = sfAppend(capture, ["--page-url", `${next}9`, "--result-file", payload(sfOk("Contact", [sfRow(9)]))]);
  assertRefused(wrong, /--page-url must be the nextRecordsUrl/, capture, readFileSync(capture, "utf8"));

  const secondResponse = sfOk("Contact", [sfRow(2)]);
  const page = sfAppend(capture, ["--page-url", next, "--result-file", payload(secondResponse), "--captured-at", "2026-11-05T10:00:09Z"]);
  assert.equal(page.status, 0, page.stderr);
  noPayload(page);
  const summary = JSON.parse(page.stdout);
  assert.equal(summary.step, "page");
  assert.equal(summary.object, "page");
  assert.equal(summary.entry_index, 1);
  assert.equal(summary.records, 1);
  assert.deepEqual(entriesOf(capture)[1], { tool: "dispatch_readonly", args: nextPageArgs(next), result: secondResponse, captured_at: "2026-11-05T10:00:09Z" });
  assert.equal(Object.hasOwn(entriesOf(capture)[1].args, "queryParams"), false);
  const validation = cli(SF_CLI, ["--validate", rel(capture)]);
  assert.equal(validation.status, 0, validation.stdout);
});

test("salesforce: invalid flag combinations and unknown steps are refused without writing", () => {
  const capture = sfSkeleton();
  const mixes = [
    ["--page-url", "/services/data/v66.0/query/x", "--step", "Account", "--result-file", payload({})],
    ["--page-url", "/services/data/v66.0/query/x", "--account-id", NORTHWIND_ACCOUNT_ID, "--result-file", payload({})],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account"],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--result-file", payload({})],
    ["--step", "Account", "--result-file", payload({})],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--account", "x", "--step", "Account", "--result-file", payload({})],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account", "--result-file", payload({}), "--error-file", payload({})],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Nope", "--result-file", payload({})],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "9", "--result-file", payload({})],
    ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "0", "--result-file", payload({})],
  ];
  const before = readFileSync(capture, "utf8");
  for (const extra of mixes) {
    const result = sfAppend(capture, extra);
    assertRefused(result, /\S/, capture, before);
  }
  const unknown = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Nope", "--result-file", payload({})]);
  assert.match(unknown.stderr, /valid steps: Account, Opportunity, Contact, Task, Event/);
});

// ---------------------------------------------------------------- Salesforce: refusals

test("salesforce: refusals leave the capture byte-identical and print no payload", () => {
  const capture = sfSkeleton();
  const ok = sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--result-file", payload(sfOk("Account", [sfRow(1)]))]);
  assert.equal(ok.status, 0, ok.stderr);
  const before = readFileSync(capture, "utf8");
  const common = ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account"];

  // result file outside .captures/
  const outside = join(tmp, "outside.json");
  writeFileSync(outside, JSON.stringify(sfOk("Account", [sfRow(2)])));
  assertRefused(sfAppend(capture, [...common, "--result-file", outside]), /--result-file must be a file under the repository's \.captures\/ directory/, capture, before);
  // relative escape out of .captures/
  assertRefused(sfAppend(capture, [...common, "--result-file", `${rel(work)}/../../package.json`]), /--result-file must be a file under/, capture, before);
  // a result file inside .captures/ that is a directory, and a missing one
  assertRefused(sfAppend(capture, [...common, "--result-file", rel(join(work, "tmp"))]), /--result-file must be/, capture, before);
  assertRefused(sfAppend(capture, [...common, "--result-file", rel(join(work, "tmp", "missing.json"))]), /--result-file must be/, capture, before);
  // the capture file as its own payload
  assertRefused(sfAppend(capture, [...common, "--result-file", rel(capture)]), /must not be the capture file itself/, capture, before);
  // non-JSON input; the content must not be echoed
  assertRefused(sfAppend(capture, [...common, "--result-file", payload(`not json ${SENTINEL}`)]), /--result-file file is not valid JSON/, capture, before);
  assertRefused(sfAppend(capture, [...common, "--result-file", payload("")]), /not valid JSON/, capture, before);
  assertRefused(sfAppend(capture, [...common, "--error-file", payload(`{"truncated": "${SENTINEL}`)]), /--error-file file is not valid JSON/, capture, before);
  // duplicate of the last entry without --replace-last
  assertRefused(sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--result-file", payload(sfOk("Account", [sfRow(3)]))]), /already this call/, capture, before);
  // --replace-last must target the same call
  assertRefused(sfAppend(capture, [...common, "--replace-last", "--result-file", payload(sfOk("Account", [sfRow(3)]))]), /--replace-last needs the last entry to be the same call/, capture, before);
  // bad timestamp
  assertRefused(sfAppend(capture, [...common, "--captured-at", "yesterday", "--result-file", payload({})]), /--captured-at must be an RFC 3339/, capture, before);
  assertRefused(sfAppend(capture, [...common, "--captured-at", "2026-11-05 10:00:00", "--result-file", payload({})]), /--captured-at must be an RFC 3339/, capture, before);
  assert.ok(dirListing().every((name) => !name.endsWith(".tmp")), "no temp file is left behind");
});

test("salesforce: the capture must exist, live under .captures/ and have source_system salesforce", () => {
  const file = payload(sfOk("Account", [sfRow(1)]));
  const common = ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account", "--result-file", file];
  assertRefused(cli(SF_CLI, ["--append", rel(join(work, "does-not-exist.json")), ...common]), /--append must be an existing file under the repository's \.captures\/ directory/);
  assert.ok(!existsSync(join(work, "does-not-exist.json")), "append never creates a capture");

  const outside = join(tmp, "outside-capture.json");
  writeFileSync(outside, readFileSync(sfSkeleton()));
  assertRefused(cli(SF_CLI, ["--append", outside, ...common]), /--append must be a file under the repository's \.captures\/ directory/);
  assertRefused(cli(SF_CLI, ["--append", rel(work), ...common]), /--append must be/);

  const m365 = m365Skeleton();
  const before = readFileSync(m365, "utf8");
  assertRefused(cli(SF_CLI, ["--append", rel(m365), ...common]), /appends only to captures with source_system salesforce/, m365, before);
  const sf = sfSkeleton();
  const sfBefore = readFileSync(sf, "utf8");
  assertRefused(cli(M365_CLI, ["--append", rel(sf), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING, "--step", "search_1", "--result-file", payload(m365Page([m365Hit({ n: 1 })]))]),
    /appends only to captures with source_system m365/, sf, sfBefore);

  const broken = join(work, "broken.json");
  writeFileSync(broken, `{"format_version":"mcp-capture/1","capture":{"source_system":"salesforce"},"entries":[]}`);
  assertRefused(cli(SF_CLI, ["--append", rel(broken), ...common]), /existing capture file is not valid/, broken, readFileSync(broken, "utf8"));
  writeFileSync(broken, "not json");
  assertRefused(cli(SF_CLI, ["--append", rel(broken), ...common]), /--append file is not valid JSON/, broken, "not json");
});

test("salesforce: an entry over the 2 MB entry limit is refused before anything is written", () => {
  const capture = sfSkeleton();
  const before = readFileSync(capture, "utf8");
  const huge = sfOk("Account", [{ Id: sid("001", 1), Name: SENTINEL.repeat(Math.ceil((2 * 1024 * 1024) / SENTINEL.length) + 1) }]);
  const result = sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--result-file", payload(huge)]);
  assertRefused(result, /would exceed a capture limit \(Entry 0 exceeds 2097152 bytes\)/, capture, before);
  assert.ok(dirListing().every((name) => !name.endsWith(".tmp")));
});

test("salesforce: the 20 MB file limit and the 1000 entry limit are enforced before writing", () => {
  const capture = sfSkeleton();
  const doc = JSON.parse(readFileSync(capture, "utf8"));
  const filler = "x".repeat(2_000_000); // each entry stays under the 2 MB entry limit
  for (let index = 0; index < 10; index += 1) {
    doc.entries.push({ tool: "dispatch_readonly", args: { url: `/filler/${index}`, method: "GET" }, result: { filler }, captured_at: "2026-11-05T10:00:00Z" });
  }
  writeFileSync(capture, JSON.stringify(doc));
  const before = readFileSync(capture, "utf8");
  assert.ok(Buffer.byteLength(before) < 20 * 1024 * 1024, "the prepared capture itself is within the limit");
  const result = sfAppend(capture, ["--account", "Northwind Traders", "--step", "search", "--result-file", payload({ filler: "y".repeat(1_500_000) })]);
  assertRefused(result, /would exceed a capture limit \(Capture exceeds 20971520 bytes\)/, capture, before);

  const many = sfSkeleton();
  const manyDoc = JSON.parse(readFileSync(many, "utf8"));
  for (let index = 0; index < 1000; index += 1) {
    manyDoc.entries.push({ tool: "dispatch_readonly", args: { url: `/n/${index}`, method: "GET" }, result: {}, captured_at: "2026-11-05T10:00:00Z" });
  }
  writeFileSync(many, JSON.stringify(manyDoc));
  assertRefused(sfAppend(many, ["--account", "Northwind Traders", "--step", "search", "--result-file", payload({})]), /more than 1000 entries/, many, readFileSync(many, "utf8"));
  assert.ok(dirListing().every((name) => !name.endsWith(".tmp")));
});

test("salesforce: --replace-last replaces only the last entry (the retry rule)", () => {
  const capture = sfSkeleton();
  const steps = ["Account", "Opportunity"];
  steps.forEach((step, index) => {
    const result = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", step, "--result-file", payload(sfOk(step, [sfRow(index + 1)])), "--captured-at", `2026-11-05T10:00:0${index}Z`]);
    assert.equal(result.status, 0, result.stderr);
  });
  // the failed attempt of the last call is already recorded; keep only the final attempt
  const failed = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Contact", "--error-file", payload(sfError(401, "INVALID_AUTH_HEADER")), "--captured-at", "2026-11-05T10:00:02Z"]);
  assert.equal(failed.status, 0, failed.stderr);
  const beforeEntries = entriesOf(capture);
  assert.equal(beforeEntries.length, 3);
  const final = sfOk("Contact", [sfRow(3)]);
  const retry = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Contact", "--result-file", payload(final), "--replace-last", "--captured-at", "2026-11-05T10:00:03Z"]);
  assert.equal(retry.status, 0, retry.stderr);
  noPayload(retry);
  const summary = JSON.parse(retry.stdout);
  assert.equal(summary.replaced_last, true);
  assert.equal(summary.entry_index, 2);
  assert.equal(summary.entries, 3);
  const afterEntries = entriesOf(capture);
  assert.equal(afterEntries.length, 3);
  assert.deepEqual(afterEntries.slice(0, 2), beforeEntries.slice(0, 2), "earlier entries are untouched and in order");
  assert.deepEqual(afterEntries[2], { tool: "dispatch_readonly", args: beforeEntries[2].args, result: final, captured_at: "2026-11-05T10:00:03Z" });
  assert.equal(afterEntries[2].error, undefined);
  // --replace-last on an empty capture refuses
  const empty = sfSkeleton();
  assertRefused(sfAppend(empty, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account", "--replace-last", "--result-file", payload({})]), /--replace-last needs the last entry/, empty, readFileSync(empty, "utf8"));
});

test("salesforce: --replace-last, --step and the file flags are only valid with --append", () => {
  for (const extra of [["--replace-last"], ["--step", "Account"], ["--result-file", "x"], ["--captured-at", "2026-11-05T10:00:00Z"], ["--page-url", "/x"]]) {
    const result = cli(SF_CLI, ["--account-id", NORTHWIND_ACCOUNT_ID, ...extra]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /is only valid with --append/);
  }
  const combined = cli(SF_CLI, ["--append", ".captures/x.json", "--init-capture", ".captures/y.json", "--step", "1"]);
  assert.equal(combined.status, 1);
  assert.match(combined.stderr, /Modes cannot be combined/);
  const help = cli(SF_CLI, ["--help"]);
  for (const flag of ["--append", "--step", "--page-url", "--result-file", "--error-file", "--replace-last", "--captured-at"]) assert.ok(help.stdout.includes(flag), `help is missing ${flag}`);
});

test("salesforce: a symlink or junction under .captures/ cannot point the payload outside it", { skip: process.platform === "win32" ? "symlink creation needs privileges on Windows" : false }, () => {
  const capture = sfSkeleton();
  const before = readFileSync(capture, "utf8");
  const target = join(tmp, "linked.json");
  writeFileSync(target, JSON.stringify({ x: SENTINEL }));
  const link = join(work, "tmp", "link.json");
  symlinkSync(target, link);
  assertRefused(sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account", "--result-file", rel(link)]), /--result-file must be a file under/, capture, before);
});

// ---------------------------------------------------------------- M365

const m365Plan = () => {
  const result = cli(M365_CLI, ["--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test("m365: append records every plan step with the plan's own args (by name and by position)", () => {
  const capture = m365Skeleton();
  const plan = m365Plan();
  assert.deepEqual(plan.calls.map((call) => call.step), ["search_1", "search_2"]);
  plan.calls.forEach((call, index) => {
    const response = m365Page([m365Hit({ n: index + 1, name: `Example ${SENTINEL} ${index}.docx` })]);
    const result = m365Append(capture, ["--step", index === 0 ? call.step : String(index + 1), "--result-file", payload(response), "--captured-at", `2026-11-05T10:00:0${index}Z`]);
    assert.equal(result.status, 0, result.stderr);
    noPayload(result);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(
      { ...summary, captured_at: undefined },
      { appended: true, replaced_last: false, entry_index: index, entries: index + 1, tool: "sharepoint_search", step: call.step, offset: 0, outcome: "result", captured_at: undefined, result_is_error: false, hits: 1, more_results: false },
    );
    assert.deepEqual(entriesOf(capture)[index], { tool: "sharepoint_search", args: call.args, result: response, captured_at: `2026-11-05T10:00:0${index}Z` });
  });
  const validation = cli(M365_CLI, ["--validate", rel(capture), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING]);
  assert.equal(validation.status, 0, validation.stdout);
});

test("m365: pagination appends with --offset only when it equals a recorded nextOffset", () => {
  const capture = m365Skeleton();
  const page = (hits, trailer) => m365Page(hits, trailer);
  const first = page([m365Hit({ n: 1 })], moreTrailer(50));
  assert.equal(m365Append(capture, ["--step", "search_1", "--result-file", payload(first)]).status, 0);
  const before = readFileSync(capture, "utf8");

  assertRefused(m365Append(capture, ["--step", "search_1", "--offset", "7", "--result-file", payload(page([m365Hit({ n: 2 })]))]), /--offset must equal the nextOffset of a recorded page/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_2", "--offset", "50", "--result-file", payload(page([m365Hit({ n: 2 })]))]), /--offset must equal the nextOffset/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--offset", "x", "--result-file", payload({})]), /--offset must be a non-negative integer/, capture, before);

  const secondResponse = page([m365Hit({ n: 2 })], moreTrailer(100));
  const second = m365Append(capture, ["--step", "search_1", "--offset", "50", "--result-file", payload(secondResponse), "--captured-at", "2026-11-05T10:00:05Z"]);
  assert.equal(second.status, 0, second.stderr);
  noPayload(second);
  assert.deepEqual(JSON.parse(second.stdout), { appended: true, replaced_last: false, entry_index: 1, entries: 2, tool: "sharepoint_search", step: "search_1", offset: 50, outcome: "result", captured_at: "2026-11-05T10:00:05Z", result_is_error: false, hits: 1, more_results: true, next_offset: 100 });
  assert.deepEqual(entriesOf(capture)[1], { tool: "sharepoint_search", args: searchArgs("Northwind Traders", 50), result: secondResponse, captured_at: "2026-11-05T10:00:05Z" });

  // pages 3 and 4, then the 4-page cap
  assert.equal(m365Append(capture, ["--step", "search_1", "--offset", "100", "--result-file", payload(page([m365Hit({ n: 3 })], moreTrailer(150)))]).status, 0);
  assert.equal(m365Append(capture, ["--step", "search_1", "--offset", "150", "--result-file", payload(page([m365Hit({ n: 4 })], moreTrailer(200)))]).status, 0);
  const capped = readFileSync(capture, "utf8");
  assertRefused(m365Append(capture, ["--step", "search_1", "--offset", "200", "--result-file", payload(page([m365Hit({ n: 5 })]))]), /already has 4 recorded pages/, capture, capped);
});

test("m365: a tool error is stored as error; the retry rule keeps only the final attempt", () => {
  const capture = m365Skeleton();
  const error = m365Error(429, { retryAfter: 2 });
  const failed = m365Append(capture, ["--step", "search_1", "--error-file", payload(error)]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).outcome, "error");
  assert.deepEqual(entriesOf(capture)[0].error, error);
  const before = readFileSync(capture, "utf8");
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-file", payload(m365Page([m365Hit({ n: 1 })]))]), /already this call/, capture, before);
  const retry = m365Append(capture, ["--step", "search_1", "--replace-last", "--result-file", payload(m365Page([m365Hit({ n: 1 })]))]);
  assert.equal(retry.status, 0, retry.stderr);
  const entries = entriesOf(capture);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].error, undefined);
  assert.equal(JSON.parse(retry.stdout).replaced_last, true);
  // an empty result is {"content": []}
  const empty = m365Append(capture, ["--step", "search_2", "--result-file", payload({ content: [] })]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).hits, 0);
});

test("m365: refusals (flags, steps, unmapped account, non-JSON, outside .captures/) leave the file unchanged", () => {
  const capture = m365Skeleton();
  const before = readFileSync(capture, "utf8");
  const file = payload(m365Page([m365Hit({ n: 1 })]));
  const outside = join(tmp, "m365-outside.json");
  writeFileSync(outside, JSON.stringify(m365Page([m365Hit({ n: 1 })])));
  assertRefused(m365Append(capture, ["--step", "search_9", "--result-file", file]), /valid steps: search_1, search_2/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-file", outside]), /--result-file must be a file under/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-file", payload(`oops ${SENTINEL}`)]), /--result-file file is not valid JSON/, capture, before);
  assertRefused(m365Append(capture, ["--step", "search_1", "--error-file", payload(JSON.stringify([SENTINEL]))]), /--error-file must contain a JSON object/, capture, before);
  const unmapped = cli(M365_CLI, ["--append", rel(capture), "--account-id", sid("001", 77), "--m365-mapping", MAPPING, "--step", "search_1", "--result-file", file]);
  assertRefused(unmapped, /\S/, capture, before);
  for (const extra of [
    ["--step", "search_1"],
    ["--result-file", file],
    ["--step", "search_1", "--result-file", file, "--error-file", file],
  ]) {
    assertRefused(cli(M365_CLI, ["--append", rel(capture), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING, ...extra]), /\S/, capture, before);
  }
  assertRefused(cli(M365_CLI, ["--append", rel(capture), "--step", "search_1", "--result-file", file]), /--append needs --account-id/, capture, before);
  const oversize = m365Page([m365Hit({ n: 1, content: SENTINEL.repeat(Math.ceil((2 * 1024 * 1024) / SENTINEL.length) + 1) })]);
  assertRefused(m365Append(capture, ["--step", "search_1", "--result-file", payload(oversize)]), /would exceed a capture limit \(Entry 0 exceeds 2097152 bytes\)/, capture, before);
  for (const flag of [["--step", "search_1"], ["--offset", "50"], ["--replace-last"], ["--result-file", file]]) {
    const result = cli(M365_CLI, ["--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING, ...flag]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is only valid with --append/);
  }
  const help = cli(M365_CLI, ["--help"]);
  for (const flag of ["--append", "--step", "--offset", "--result-file", "--error-file", "--replace-last", "--captured-at"]) assert.ok(help.stdout.includes(flag), `help is missing ${flag}`);
});

// ---------------------------------------------------------------- end to end

const stable = ({ trace_id: _t, started_at: _s, finished_at: _f, ...rest }) => JSON.stringify(rest);
const withoutWarnings = (stderr) => stderr.replace(/capture: WARNING[^\n]*\n/g, "");

/**
 * Rebuild a fixture capture using only `--append`: every entry's raw payload goes into a file under
 * .captures/ and is appended with the step that the plan CLI printed for exactly those args.
 */
function rebuild(fixturePath, { script, init, plans, extra = [] }) {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const capture = skeleton(script, init);
  const printed = plans.map((flags) => ({ flags, calls: JSON.parse(cli(script, [...flags, ...extra]).stdout).calls }));
  fixture.entries.forEach((entry, index) => {
    const match = printed.flatMap((plan) => plan.calls.map((call) => ({ plan, call })))
      .find(({ call }) => call.args && JSON.stringify(call.args) === JSON.stringify(entry.args));
    assert.ok(match, `fixture entry ${index} must match a printed plan call`);
    const flag = entry.error === undefined ? "--result-file" : "--error-file";
    const result = cli(script, ["--append", rel(capture), ...match.plan.flags, ...extra, "--step", match.call.step,
      flag, payload(entry.result ?? entry.error), "--captured-at", entry.captured_at]);
    assert.equal(result.status, 0, result.stderr);
  });
  return { capture, fixture };
}

test("end to end: captures built only with --append replay through prepare-first-meeting and source-rank like the fixtures", () => {
  const sf = rebuild(SF_FIXTURE, {
    script: SF_CLI,
    init: ["--source-system", "salesforce"],
    plans: [["--account", "Northwind Traders"], ["--account-id", NORTHWIND_ACCOUNT_ID]],
  });
  const m365 = rebuild(M365_FIXTURE, { script: M365_CLI, init: [], plans: [["--account-id", NORTHWIND_ACCOUNT_ID]], extra: ["--m365-mapping", MAPPING] });

  // the appended entries are identical to the fixture entries (tool, args, payload, captured_at)
  assert.deepEqual(entriesOf(sf.capture), sf.fixture.entries);
  assert.deepEqual(entriesOf(m365.capture), m365.fixture.entries);

  // `capture.created_at` is skeleton metadata set at --init-capture time; align it with the fixture so
  // the replay clock (source-rank's default --now, retrieval time) is the same for both runs
  for (const built of [sf, m365]) {
    const doc = JSON.parse(readFileSync(built.capture, "utf8"));
    doc.capture.created_at = built.fixture.capture.created_at;
    writeFileSync(built.capture, JSON.stringify(doc));
  }

  const workflowArgs = (sfPath, m365Path) => ["--account", "Northwind Traders", "--source", "capture", "--capture", sfPath, "--capture-m365", m365Path, "--m365-mapping", MAPPING, "--output", "json"];
  const rankArgs = (sfPath, m365Path) => ["--source", "capture", "--account", NORTHWIND_ACCOUNT_ID, "--capture", sfPath, "--capture-m365", m365Path, "--m365-mapping", MAPPING, "--output", "json"];
  for (const [script, build] of [["bin/prepare-first-meeting.js", workflowArgs], ["bin/source-rank.js", rankArgs]]) {
    const expected = cli(script, build(SF_FIXTURE, M365_FIXTURE));
    const actual = cli(script, build(sf.capture, m365.capture));
    assert.ok([0, 2].includes(expected.status), `${script}: ${expected.stderr}`);
    assert.equal(actual.status, expected.status, `${script}: ${actual.stderr}`);
    assert.equal(stable(JSON.parse(actual.stdout)), stable(JSON.parse(expected.stdout)), `${script} output differs`);
    assert.equal(withoutWarnings(actual.stderr), withoutWarnings(expected.stderr));
  }
  // the built captures are what --validate expects
  const sfValid = cli(SF_CLI, ["--validate", rel(sf.capture), "--account", "Northwind Traders", "--account-id", NORTHWIND_ACCOUNT_ID]);
  assert.equal(sfValid.status, 0, sfValid.stdout);
  const m365Valid = cli(M365_CLI, ["--validate", rel(m365.capture), "--account-id", NORTHWIND_ACCOUNT_ID, "--m365-mapping", MAPPING]);
  assert.equal(m365Valid.status, 0, m365Valid.stdout);
});

// ---------------------------------------------------------------- hardening

test("salesforce: --page-url must have the nextRecordsUrl shape, and the URL is never echoed", () => {
  const capture = sfSkeleton();
  const before = readFileSync(capture, "utf8");
  for (const url of [`/evil/${SENTINEL}`, `/services/data/v66.0/query/abc?${SENTINEL}=1`, `https://example.invalid/services/data/v66.0/query/abc${SENTINEL}`, "/services/data/v66.0/sobjects/Account/x", "/services/data/v66.0/query/a/b"]) {
    const result = sfAppend(capture, ["--page-url", url, "--result-file", payload({})]);
    assertRefused(result, /--page-url must be a Salesforce nextRecordsUrl of the form/, capture, before);
  }
});

test("append refuses a busy capture (exclusive lock) and releases the lock afterwards", () => {
  const capture = sfSkeleton();
  const lock = `${capture}.lock`;
  writeFileSync(lock, "");
  const before = readFileSync(capture, "utf8");
  const args = ["--account", "Northwind Traders", "--step", "search", "--result-file", payload(sfOk("Account", [sfRow(1)]))];
  assertRefused(sfAppend(capture, args), /capture is busy/, capture, before);
  assert.ok(existsSync(lock), "a lock held by someone else is not removed");
  const m365 = m365Skeleton();
  writeFileSync(`${m365}.lock`, "");
  assertRefused(m365Append(m365, ["--step", "search_1", "--result-file", payload(m365Page([m365Hit({ n: 1 })]))]), /capture is busy/, m365, readFileSync(m365, "utf8"));
  rmSync(lock);
  const ok = sfAppend(capture, args);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!existsSync(lock), "the lock is released after a successful append");
  assertRefused(sfAppend(capture, args), /already this call/);
  assert.ok(!existsSync(lock), "the lock is released after a refusal");
});

test("a call already recorded anywhere in the capture is refused; --replace-last only replaces the last entry", () => {
  const capture = sfSkeleton();
  const accountArgs = ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", "Account"];
  for (const step of ["Account", "Opportunity"]) {
    const result = sfAppend(capture, ["--account-id", NORTHWIND_ACCOUNT_ID, "--step", step, "--result-file", payload(sfOk(step, [sfRow(1)]))]);
    assert.equal(result.status, 0, result.stderr);
  }
  const before = readFileSync(capture, "utf8");
  assertRefused(sfAppend(capture, [...accountArgs, "--result-file", payload(sfOk("Account", [sfRow(2)]))]), /already recorded in the capture/, capture, before);
  assertRefused(sfAppend(capture, [...accountArgs, "--replace-last", "--result-file", payload(sfOk("Account", [sfRow(2)]))]), /--replace-last needs the last entry/, capture, before);
  // a capture that already holds the call twice: --replace-last on the last one still refuses
  const doc = JSON.parse(before);
  doc.entries.push({ ...doc.entries[0], captured_at: "2026-11-05T10:00:09Z" });
  writeFileSync(capture, JSON.stringify(doc));
  const dup = readFileSync(capture, "utf8");
  assertRefused(sfAppend(capture, [...accountArgs, "--replace-last", "--result-file", payload(sfOk("Account", [sfRow(3)]))]), /already recorded in the capture/, capture, dup);
  // M365: a first page recorded earlier is refused later
  const m365 = m365Skeleton();
  assert.equal(m365Append(m365, ["--step", "search_1", "--result-file", payload(m365Page([m365Hit({ n: 1 })]))]).status, 0);
  assert.equal(m365Append(m365, ["--step", "search_2", "--result-file", payload(m365Page([m365Hit({ n: 2 })]))]).status, 0);
  const m365Before = readFileSync(m365, "utf8");
  assertRefused(m365Append(m365, ["--step", "search_1", "--result-file", payload(m365Page([m365Hit({ n: 3 })]))]), /already recorded in the capture/, m365, m365Before);
});

