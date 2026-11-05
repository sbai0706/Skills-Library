import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { searchAccounts } from "../skills/account-resolve/search.js";
import { createSalesforceAccountAdapter } from "../adapters/salesforce/index.js";
import { nextPageArgs } from "../adapters/salesforce/capture-plan.js";
import { northwindRows, scenarios } from "./helpers/salesforce-scenarios.js";
import { pageEntry, sfError, sfOk, textEnvelope } from "./helpers/salesforce-capture.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NORTHWIND = resolve(root, "fixtures/salesforce-northwind/capture.json");
const tmp = mkdtempSync(join(tmpdir(), "sf-capture-gate-"));
const work = join(root, ".captures", `test-gate-${process.pid}-${Date.now()}`);
test.after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(root, "bin", script), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const plan = (args) => run("salesforce-capture-plan.js", args);
const json = (result) => JSON.parse(result.stdout);

function write(dir, name, doc) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const OUTSIDE = "--init-capture refuses any target outside the repository's .captures/ directory.\n";
const DIRECTORY = "--init-capture needs a file path such as .captures/<slug>.json, not a directory.\n";

// ---------------------------------------------------------------- --init-capture enforcement

test("--init-capture refuses every target outside <repo>/.captures/ with a fixed message and no override", () => {
  const targets = [
    join(tmp, "skeleton.json"),
    "skeleton-at-root.json",
    "../escape.json",
    ".captures/../escape.json",
    "fixtures/skeleton.json",
    ".captures-other/skeleton.json",
  ];
  for (const target of targets) {
    const result = plan(["--init-capture", target, "--source-system", "salesforce"]);
    assert.equal(result.status, 1, target);
    assert.equal(result.stderr, OUTSIDE, target);
    assert.equal(result.stdout, "");
  }
  assert.ok(!existsSync(join(tmp, "skeleton.json")));
  assert.ok(!existsSync(resolve(root, "skeleton-at-root.json")));
  assert.ok(!existsSync(resolve(root, "..", "escape.json")));
  const override = plan(["--init-capture", join(tmp, "o.json"), "--source-system", "salesforce", "--force"]);
  assert.equal(override.status, 1);
  assert.match(override.stderr, /Unknown option: --force/);
});

test("--init-capture gives a directory-specific message for directory targets", () => {
  mkdirSync(join(work, "existing-dir"), { recursive: true });
  const cases = [".captures", ".captures/", ".captures/test-dir/", `.captures/${work.split(/[\\/]/).pop()}/existing-dir`];
  for (const target of cases) {
    const result = plan(["--init-capture", target, "--source-system", "salesforce"]);
    assert.equal(result.status, 1, target);
    assert.equal(result.stderr, DIRECTORY, target);
  }
  assert.ok(!existsSync(resolve(root, ".captures", "test-dir")), "no directory was created for a rejected target");
});

// ---------------------------------------------------------------- git-ignore warning

const WARNING = /capture: WARNING: the capture file is not git-ignored/;

test("a capture that is not git-ignored warns on stderr for --validate and every capture-mode run, without changing exit codes", () => {
  const validated = plan(["--validate", NORTHWIND]);
  assert.equal(validated.status, 0);
  assert.match(validated.stderr, WARNING);
  assert.equal(json(validated).valid, true);

  for (const [script, extra] of [
    ["prepare-first-meeting.js", []], ["prepare-first-meeting-v2.js", []], ["qualification.js", []],
    ["prepare-engagement.js", []], ["opportunity-strategy.js", []],
  ]) {
    const result = run(script, ["--account", "Northwind Traders", ...extra, "--source", "capture", "--capture", NORTHWIND]);
    assert.match(result.stderr, WARNING, script);
    assert.ok([0, 2].includes(result.status), `${script}: ${result.status}`);
    assert.ok(!result.stdout.includes("not git-ignored"), "the warning never goes to stdout");
    assert.equal(JSON.parse(result.stdout).errors.length, 0);
  }
  const bad = run("prepare-first-meeting.js", ["--account", "Zzz Unknown", "--source", "capture", "--capture", NORTHWIND]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, WARNING);
});

test("no warning for a git-ignored capture under .captures/ or for a file outside any repository", () => {
  const ignored = join(work, "ignored-copy.json");
  mkdirSync(work, { recursive: true });
  copyFileSync(NORTHWIND, ignored);
  for (const path of [ignored, write(tmp, "outside.json", scenarios()["salesforce-northwind"])]) {
    const validated = plan(["--validate", path]);
    assert.equal(validated.status, 0);
    assert.ok(!validated.stderr.includes("WARNING"), path);
    const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", path]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes("WARNING"), path);
  }
});

// ---------------------------------------------------------------- --validate gate: pagination and source_system

const NEXT = "/services/data/v66.0/query/01gSYN000000001AAA-2000";
const opportunityIndex = (entries) => entries.findIndex((e) => /FROM Opportunity/.test(e.args.queryParams?.q ?? ""));

/** Northwind capture whose Opportunity query is split over two pages; `page` controls the second entry. */
function paginated(page, { wrapFirst = false } = {}) {
  const doc = structuredClone(scenarios()["salesforce-northwind"]);
  const index = opportunityIndex(doc.entries);
  const [first, second] = northwindRows.Opportunity;
  const firstResult = sfOk("Opportunity", [first], { done: false, nextRecordsUrl: NEXT });
  doc.entries[index].result = wrapFirst ? textEnvelope(firstResult) : firstResult;
  if (page === "ok") doc.entries.splice(index + 1, 0, pageEntry(NEXT, { result: sfOk("Opportunity", [second]) }));
  if (page === "error") doc.entries.splice(index + 1, 0, pageEntry(NEXT, { error: sfError(500, "UNKNOWN_EXCEPTION") }));
  if (page === "before") doc.entries.splice(index, 0, pageEntry(NEXT, { result: sfOk("Opportunity", [second]) }));
  if (page === "wrong-url") doc.entries.splice(index + 1, 0, pageEntry(`${NEXT}9`, { result: sfOk("Opportunity", [second]) }));
  return { doc, index };
}

test("--validate requires a later successful page for every done:false result", () => {
  for (const wrapFirst of [false, true]) {
    const good = plan(["--validate", write(tmp, `page-ok-${wrapFirst}.json`, paginated("ok", { wrapFirst }).doc)]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(json(good).valid, true);
    assert.deepEqual(json(good).queries_by_object.page, 1);

    const { doc, index } = paginated("none", { wrapFirst });
    const missing = plan(["--validate", write(tmp, `page-missing-${wrapFirst}.json`, doc)]);
    assert.equal(missing.status, 1);
    assert.deepEqual(json(missing).problems, [`entry ${index}: missing pagination page.`]);
  }
  for (const page of ["error", "before", "wrong-url"]) {
    const { doc } = paginated(page);
    const result = plan(["--validate", write(tmp, `page-${page}.json`, doc)]);
    assert.equal(result.status, 1, page);
    const problems = json(result).problems;
    assert.equal(problems.length, 1, page);
    assert.match(problems[0], /^entry \d+: missing pagination page\.$/, page);
  }
});

test("--validate treats a source_system other than salesforce as a problem", () => {
  const doc = structuredClone(scenarios()["salesforce-northwind"]);
  doc.capture.source_system = "m365";
  const result = plan(["--validate", write(tmp, "m365.json", doc)]);
  assert.equal(result.status, 1);
  assert.deepEqual(json(result).problems, ["capture.source_system must be salesforce."]);
});

test("capture-mode CLIs reject a non-salesforce capture with a fixed message (exit 1)", () => {
  const doc = structuredClone(scenarios()["salesforce-northwind"]);
  doc.capture.source_system = "m365";
  const path = write(tmp, "m365-run.json", doc);
  for (const [script, args] of [
    ["prepare-first-meeting.js", ["--account", "Northwind Traders"]],
    ["prepare-first-meeting-v2.js", ["--account", "Northwind Traders"]],
    ["qualification.js", ["--account", "Northwind Traders"]],
    ["prepare-engagement.js", ["--account", "Northwind Traders"]],
    ["opportunity-strategy.js", ["--account", "Northwind Traders"]],
  ]) {
    const result = run(script, [...args, "--source", "capture", "--capture", path]);
    assert.equal(result.status, 1, script);
    assert.equal(result.stdout, "", script);
    assert.equal(result.stderr, "The capture is not a Salesforce capture (capture.source_system must be salesforce).\n", script);
  }
});

// ---------------------------------------------------------------- REPLAY_INCOMPLETE contract

test("a missing pagination page makes the CLI fail with exit 1 and REPLAY_INCOMPLETE on stderr only", () => {
  const { doc } = paginated("none");
  const path = write(tmp, "missing-page.json", doc);
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", path]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capture: REPLAY_INCOMPLETE: failed: incomplete capture/);
  assert.match(result.stderr, /ignore the status and artifact/);
  const workflow = json(result);
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.artifact, null);
  assert.ok(!JSON.stringify(workflow).includes("REPLAY_INCOMPLETE"), "the JSON contract is not modified");
  assert.equal(result.stdout.trim().split("\n").length, 1, "stdout stays a single JSON document");
  assert.equal(JSON.parse(result.stdout).errors[0].code, "ADAPTER_UNAVAILABLE");

  const complete = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", write(tmp, "with-page.json", paginated("ok").doc)]);
  assert.equal(complete.status, 0, complete.stderr);
  assert.ok(!complete.stderr.includes("REPLAY_INCOMPLETE"));
  assert.equal(json(complete).status, "success");
});

// ---------------------------------------------------------------- plan vs adapter: domain kind and suffix references

async function adapterCalls(reference) {
  const calls = [];
  const client = {
    listTools: async () => ({ tools: [{ name: "dispatch_readonly" }] }),
    async callTool(name, args) {
      calls.push({ name, args });
      return sfOk("Account", []);
    },
  };
  // account.resolve reaches the adapter through searchAccounts(adapter, reference) (toSearchTerm applied there).
  const result = await searchAccounts(createSalesforceAccountAdapter({ client }), reference);
  assert.equal(result.ok, true);
  return calls;
}

test("plan args equal the adapter calls for a domain reference and for a 'Foo, Inc.' reference", async () => {
  const domain = json(plan(["--account", "northwind-traders.example"]));
  assert.equal(domain.calls[0].kind, "domain");
  assert.equal(domain.calls.length, 1);
  const domainCalls = await adapterCalls("northwind-traders.example");
  assert.equal(JSON.stringify(domainCalls.map((c) => c.args)), JSON.stringify(domain.calls.map((c) => c.args)));

  const suffix = json(plan(["--account", "Foo, Inc."]));
  assert.equal(suffix.term, "Foo");
  assert.equal(suffix.calls[0].kind, "name");
  const suffixCalls = await adapterCalls("Foo, Inc.");
  assert.equal(suffixCalls.length, 1);
  assert.ok(suffixCalls.every((c) => c.name === "dispatch_readonly"));
  assert.equal(JSON.stringify(suffixCalls[0].args), JSON.stringify(suffix.calls[0].args));
  assert.deepEqual(nextPageArgs(NEXT), { url: NEXT, method: "GET" });
});
