import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../schemas/index.js";
import { createCaptureSession, captureExitCode } from "../cli/capture-mode.js";
import {
  createSalesforceAccountAdapter, createSalesforceEvidenceAdapter,
} from "../adapters/salesforce/index.js";
import { buildAccountByIdSoql } from "../adapters/salesforce/soql.js";
import {
  captureDoc, evidenceEntries, northwindRows, northwindSearchRow, NORTHWIND_ACCOUNT_ID, NORTHWIND_ID, LOGISTICS_ID,
  scenarios, searchEntries,
} from "./helpers/salesforce-scenarios.js";
import { queryEntry, sfOk, sid } from "./helpers/salesforce-capture.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NORTHWIND = resolve(root, "fixtures/salesforce-northwind/capture.json");
const AMBIGUOUS = resolve(root, "fixtures/salesforce-ambiguous/capture.json");
const tmp = mkdtempSync(join(tmpdir(), "sf-capture-cli-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(root, "bin", script), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const json = (result) => JSON.parse(result.stdout);

function writeCapture(name, doc) {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const CLIS = [
  { script: "prepare-first-meeting.js", workflow: "prepare-first-meeting", fixture: "workflow-first-meeting-success", args: ["--account", "Northwind Traders"], status: "success", exit: 0 },
  { script: "prepare-first-meeting-v2.js", workflow: "prepare-first-meeting-v2", fixture: "workflow-first-meeting-success", args: ["--account", "Northwind Traders"], status: "success", exit: 0 },
  { script: "qualification.js", workflow: "qualification", fixture: "workflow-first-meeting-success", args: ["--account", "Northwind Traders"], status: "partial", exit: 2 },
  { script: "prepare-engagement.js", workflow: "prepare-engagement", fixture: "engagement-initial", args: ["--account", "Northwind Traders"], status: "partial", exit: 2 },
  { script: "opportunity-strategy.js", workflow: "opportunity-strategy", fixture: "northstar-example", args: ["--account", "Northwind Traders"], status: "partial", exit: 2 },
];

// ---------------------------------------------------------------- flag parsing and invalid combinations

for (const cli of CLIS) {
  test(`${cli.script}: invalid source/capture combinations exit 1 without running a workflow`, () => {
    const cases = [
      [["--source", "capture"], /requires --capture/],
      [["--capture", NORTHWIND], /requires --source capture/],
      [["--source", "live", "--capture", NORTHWIND], /--source must be fixture or capture/],
      [["--source", "capture", "--capture", join(tmp, "does-not-exist.json")], /existing capture file/],
      [["--source", "capture", "--capture", tmp], /existing capture file/],
      [["--source", "capture", "--capture", NORTHWIND, "--fixture", cli.fixture], /--fixture cannot be used/],
      [["--source", "fixture", "--source", "capture", "--capture", NORTHWIND], /only be provided once/],
    ];
    for (const [extra, message] of cases) {
      const result = run(cli.script, [...cli.args, ...extra]);
      assert.equal(result.status, 1, `${extra.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, "", "invalid usage prints no workflow result");
      assert.match(result.stderr, message);
    }
  });

  test(`${cli.script}: help documents the source flags`, () => {
    const help = run(cli.script, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--source MODE/);
    assert.match(help.stdout, /--capture PATH/);
  });
}

test("capture mode rejects caller inputs that reference fixture evidence IDs", () => {
  const capture = ["--source", "capture", "--capture", NORTHWIND];
  const cases = [
    ["prepare-first-meeting-v2.js", ["--account", "Northwind Traders", "--mapping-fixture", "none", ...capture], /--mapping-fixture cannot be used/],
    ["qualification.js", ["--account", "Northwind Traders", "--assessment-fixture", "northstar-provisional", ...capture], /--assessment-fixture cannot be used/],
    ["prepare-engagement.js", ["--account", "Northwind Traders", "--mode", "follow_up", ...capture], /--mode follow_up cannot be used/],
    ["prepare-engagement.js", [...capture], /--account is required/],
    ["opportunity-strategy.js", [...capture], /--account is required/],
    ["prepare-first-meeting.js", ["--account", "Northwind Traders", "--sources", "crm,public_source", ...capture], /only crm/],
    ["qualification.js", ["--account", "Northwind Traders", "--sources", "public_source", ...capture], /only crm/],
  ];
  for (const [script, args, message] of cases) {
    const result = run(script, args);
    assert.equal(result.status, 1, `${script} ${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});

test("opportunity-strategy accepts --account only together with --source capture", () => {
  const result = run("opportunity-strategy.js", ["--account", "Northwind Traders"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--account requires --source capture/);
});

// ---------------------------------------------------------------- fixture default unchanged

test("fixture remains the default: explicit --source fixture matches the implicit run", () => {
  const stable = (result) => {
    const { trace_id: _t, started_at: _s, finished_at: _f, ...rest } = json(result);
    return rest;
  };
  const implicit = run("prepare-first-meeting.js", ["--account", "Northstar Logistics"]);
  const explicit = run("prepare-first-meeting.js", ["--account", "Northstar Logistics", "--source", "fixture"]);
  assert.equal(implicit.status, 0);
  assert.equal(explicit.status, 0);
  assert.deepEqual(stable(explicit), stable(implicit));
  assert.equal(json(implicit).account.canonical_name, "Northstar Logistics");

  const engagement = run("prepare-engagement.js", ["--fixture", "engagement-initial", "--mode", "initial", "--source", "fixture"]);
  assert.equal(engagement.status, 0);
  const strategy = run("opportunity-strategy.js", ["--fixture", "northstar-example", "--source", "fixture"]);
  assert.equal(strategy.status, 2);
});

// ---------------------------------------------------------------- capture-mode success per CLI

for (const cli of CLIS) {
  test(`${cli.script}: capture mode runs on the Northwind capture (status ${cli.status}, exit ${cli.exit})`, () => {
    const args = [...cli.args, "--source", "capture", "--capture", NORTHWIND];
    const result = run(cli.script, args);
    assert.equal(result.status, cli.exit, result.stderr);
    const workflow = json(result);
    assert.equal(workflow.workflow, cli.workflow);
    assert.equal(workflow.status, cli.status);
    assert.equal(workflow.account.account_id, NORTHWIND_ACCOUNT_ID);
    assert.equal(workflow.account.canonical_name, "Northwind Traders");
    assert.ok(workflow.artifact?.markdown, "artifact present");
    assert.ok(!result.stdout.includes("Northstar"), "no fixture content leaks into capture mode");
    assert.ok(!result.stderr.includes("REPLAY_INCOMPLETE"));
    assert.deepEqual(workflow.errors, []);
    if (cli.workflow === "prepare-first-meeting") assert.deepEqual(validate("workflowResult", workflow), { valid: true, errors: [] });
    // Deterministic apart from retrieval timestamps and the trace id.
    const again = json(run(cli.script, args));
    const stable = ({ trace_id: _t, started_at: _s, finished_at: _f, ...rest }) => JSON.stringify(rest).replace(/"retrieved_at":"[^"]+"/g, "");
    assert.equal(stable(again), stable(workflow));
  });
}

test("first-meeting markdown output in capture mode contains only the brief", () => {
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--output", "markdown", "--source", "capture", "--capture", NORTHWIND]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# First-meeting brief — Northwind Traders/);
  assert.ok(!result.stdout.includes('"workflow"'));
});

test("qualification in capture mode stays advisory (no assessment mapping, no decision)", () => {
  const workflow = json(run("qualification.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", NORTHWIND]));
  assert.equal(workflow.assessment.qualification_decision, "not_determined");
});

test("a single capture with Phase 1 + Phase 2 supports both a name and an sf_<Id> reference", () => {
  const rows = [northwindSearchRow];
  const combined = captureDoc([
    ...searchEntries("Northwind Traders", rows),
    queryEntry(buildAccountByIdSoql(NORTHWIND_ID), { result: sfOk("Account", rows) }),
    ...evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows),
  ], "synthetic combined capture");
  const path = writeCapture("combined.json", combined);
  for (const reference of ["Northwind Traders", NORTHWIND_ACCOUNT_ID]) {
    const result = run("prepare-first-meeting.js", ["--account", reference, "--source", "capture", "--capture", path]);
    assert.equal(result.status, 0, `${reference}: ${result.stderr}`);
    assert.equal(json(result).account.account_id, NORTHWIND_ACCOUNT_ID);
  }
});

test("ambiguous capture blocks with exit 3; choosing an Id (Phase 1 ID query + Phase 2) then succeeds", () => {
  const blocked = run("prepare-first-meeting.js", ["--account", "Northwind", "--source", "capture", "--capture", AMBIGUOUS]);
  assert.equal(blocked.status, 3, blocked.stderr);
  const workflow = json(blocked);
  assert.equal(workflow.status, "blocked");
  assert.equal(workflow.artifact, null);
  assert.equal(workflow.account_candidates.length, 2);
  assert.ok(workflow.account_candidates.some((c) => c.account_id === NORTHWIND_ACCOUNT_ID));
  assert.ok(workflow.account_candidates.some((c) => c.account_id === `sf_${LOGISTICS_ID}`));
  for (const cli of CLIS.filter((c) => c.script !== "prepare-first-meeting.js")) {
    const result = run(cli.script, ["--account", "Northwind", "--source", "capture", "--capture", AMBIGUOUS]);
    assert.equal(result.status, 3, `${cli.script}: ${result.stderr}`);
    assert.equal(json(result).status, "blocked");
  }

  const rows = [northwindSearchRow];
  const picked = writeCapture("picked.json", captureDoc([
    ...scenarios()["salesforce-ambiguous"].entries,
    queryEntry(buildAccountByIdSoql(NORTHWIND_ID), { result: sfOk("Account", rows) }),
    ...evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows),
  ], "synthetic: ambiguous search, then the chosen Id"));
  const still = run("prepare-first-meeting.js", ["--account", "Northwind", "--source", "capture", "--capture", picked]);
  assert.equal(still.status, 3);
  const resolved = run("prepare-first-meeting.js", ["--account", NORTHWIND_ACCOUNT_ID, "--source", "capture", "--capture", picked]);
  assert.equal(resolved.status, 0, resolved.stderr);
});

// ---------------------------------------------------------------- failures: no fixture fallback

test("a capture missing Phase 2 fails with exit 1 and a re-capture message", () => {
  const doc = scenarios()["salesforce-northwind"];
  const path = writeCapture("no-phase2.json", { ...doc, entries: doc.entries.slice(0, 1) });
  for (const cli of CLIS) {
    const result = run(cli.script, [...cli.args, "--source", "capture", "--capture", path]);
    assert.equal(result.status, 1, `${cli.script}: ${result.stderr}`);
    assert.match(result.stderr, /REPLAY_INCOMPLETE/);
    assert.match(result.stderr, /Re-capture/);
    assert.match(result.stderr, /salesforce-capture-plan/);
    const workflow = json(result);
    assert.equal(workflow.status, "failed");
    assert.equal(workflow.artifact, null);
    assert.ok(!result.stdout.includes("Northstar"), "no fixture fallback");
  }
});

test("a capture for a different account fails instead of falling back to fixtures", () => {
  const result = run("prepare-first-meeting.js", ["--account", "Northstar Logistics", "--source", "capture", "--capture", NORTHWIND]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REPLAY_INCOMPLETE/);
  assert.equal(json(result).status, "failed");
  assert.ok(!result.stdout.includes("Meridian") && !result.stdout.includes("\"canonical_name\":\"Northstar"));
});

test("markdown output of a failed capture run prints no artifact and exits 1", () => {
  const result = run("prepare-first-meeting.js", ["--account", "Zzz Unknown", "--output", "markdown", "--source", "capture", "--capture", NORTHWIND]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /No artifact was produced/);
});

test("unreadable or invalid capture files fail with exit 1 and no payload in the message", () => {
  const notJson = join(tmp, "not-json.json");
  writeFileSync(notJson, "{ not json SECRET-PAYLOAD");
  const badSchema = writeCapture("bad-schema.json", { format_version: "mcp-capture/9", capture: {}, entries: [] });
  for (const path of [notJson, badSchema]) {
    const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /The capture could not be loaded \(CAPTURE_(UNREADABLE|INVALID)\)/);
    assert.ok(!result.stderr.includes("SECRET-PAYLOAD"));
  }
});

test("exhausted replay is a miss: the session reports it and forces exit code 1", async () => {
  const session = createCaptureSession(NORTHWIND);
  assert.equal((await session.deps.accountAdapter.searchAccounts("Northwind Traders")).ok, true);
  assert.equal(session.misses.length, 0);
  const second = await session.deps.accountAdapter.searchAccounts("Northwind Traders");
  assert.equal(second.ok, false);
  assert.deepEqual(session.misses.map((m) => m.reason), ["replay_exhausted"]);
  assert.equal(captureExitCode(0, undefined), 0, "fixture runs have no session and keep their code");
  assert.equal(captureExitCode(0, { misses: [] }), 0);
  const stderr = process.stderr.write;
  let written = "";
  process.stderr.write = (chunk) => { written += chunk; return true; };
  try { assert.equal(captureExitCode(0, session), 1); } finally { process.stderr.write = stderr; }
  assert.match(written, /Re-capture/);
});

test("capture mode uses the Salesforce adapters: crm evidence only, structured claims", async () => {
  const session = createCaptureSession(NORTHWIND);
  assert.match(session.deps.accountAdapter.name, /^salesforce-account-adapter/);
  assert.match(session.deps.evidenceAdapter.name, /^salesforce-evidence-adapter/);
  assert.match(session.deps.claimExtractor.name, /^composite-claim-extractor\(salesforce-structured-claim-extractor\)$/);
});

// ---------------------------------------------------------------- plan CLI

const planCli = (args) => run("salesforce-capture-plan.js", args);

test("plan CLI Phase 2 args equal exactly what the evidence adapter calls (byte-identical, deterministic)", async () => {
  const printed = planCli(["--account-id", NORTHWIND_ACCOUNT_ID]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(planCli(["--account-id", NORTHWIND_ACCOUNT_ID]).stdout, printed.stdout, "deterministic output");
  const plan = json(printed);
  assert.equal(plan.phase, "evidence");
  assert.deepEqual(plan.calls.map((c) => c.step), ["Account", "Opportunity", "Contact", "Task", "Event"]);
  assert.ok(plan.calls.every((c) => c.tool === "dispatch_readonly"));
  assert.ok(typeof plan.pagination === "string" && plan.pagination.includes("nextRecordsUrl"));
  assert.ok(plan.host_rules.some((rule) => /401/.test(rule) && /once/.test(rule)));

  const calls = [];
  const client = {
    listTools: async () => ({ tools: [{ name: "dispatch_readonly" }] }),
    async callTool(name, args) {
      calls.push({ name, args });
      return sfOk(/FROM (\w+)/.exec(args.queryParams.q)[1], []);
    },
  };
  const result = await createSalesforceEvidenceAdapter({ client }).retrieve({
    account_id: NORTHWIND_ACCOUNT_ID, source_type: "crm", questions: [], classification_ceiling: "internal",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.name), plan.calls.map(() => "dispatch_readonly"));
  assert.equal(JSON.stringify(calls.map((c) => c.args)), JSON.stringify(plan.calls.map((c) => c.args)));
});

test("plan CLI Phase 1 args equal exactly what the account adapter calls, including the exact-name guard", async () => {
  const plan = json(planCli(["--account", "Northwind Traders (US)"]));
  assert.equal(plan.phase, "account_search");
  assert.equal(plan.term, "Northwind Traders", "same search term account.resolve derives");
  assert.deepEqual(plan.calls.map((c) => c.step), ["search", "exact_name_guard"]);
  assert.match(plan.calls[1].condition, /exactly 50 rows/);

  const calls = [];
  const fifty = Array.from({ length: 50 }, (_, i) => ({ Id: sid("001", 100 + i), Name: `Northwind Other ${i}` }));
  const client = {
    listTools: async () => ({ tools: [{ name: "dispatch_readonly" }] }),
    async callTool(name, args) {
      calls.push(args);
      return sfOk("Account", calls.length === 1 ? fifty : []);
    },
  };
  await createSalesforceAccountAdapter({ client }).searchAccounts("Northwind Traders");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls), JSON.stringify(plan.calls.map((c) => c.args)));
});

test("plan CLI Phase 1 for an sf_<Id> reference is the ID query; malformed and empty references need no call", async () => {
  const plan = json(planCli(["--account", NORTHWIND_ACCOUNT_ID]));
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].kind, "id");
  assert.equal(plan.calls[0].args.queryParams.q, buildAccountByIdSoql(NORTHWIND_ID));
  const malformed = json(planCli(["--account", "sf_001short"]));
  assert.deepEqual(malformed.calls, []);
  assert.match(malformed.note, /No call is needed/);
});

test("plan CLI rejects invalid usage with exit 1", () => {
  const cases = [
    [[], /Choose a mode/],
    [["--account", "A", "--account-id", NORTHWIND_ACCOUNT_ID], /cannot be combined/],
    [["--account-id", "001SYN0000000001AA"], /--account-id must be sf_/],
    [["--account-id", "sf_001SYN"], /--account-id must be sf_/],
    [["--account"], /Missing value/],
    [["--account", "  "], /Missing value/],
    [["--bogus", "x"], /Unknown option/],
    [["--account", "A", "--source-system", "salesforce"], /only valid with --init-capture/],
    [["--init-capture", join(tmp, "x.json")], /requires --source-system salesforce/],
    [["--init-capture", join(tmp, "x.json"), "--source-system", "m365"], /requires --source-system salesforce/],
  ];
  for (const [args, message] of cases) {
    const result = planCli(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
  assert.equal(planCli(["--help"]).status, 0);
});

test("plan CLI never prints tool names other than dispatch_readonly", () => {
  for (const args of [["--account", "Northwind"], ["--account-id", NORTHWIND_ACCOUNT_ID]]) {
    const plan = json(planCli(args));
    assert.ok(plan.calls.every((c) => c.tool === "dispatch_readonly" && c.args.method === "GET"));
  }
});

test("--init-capture writes a valid empty skeleton under .captures/ and refuses to overwrite", () => {
  const dir = `.captures/test-init-${process.pid}-${Date.now()}`;
  const path = join(root, dir, "skeleton.json");
  test.after(() => rmSync(join(root, dir), { recursive: true, force: true }));
  const created = planCli(["--init-capture", `${dir}/skeleton.json`, "--source-system", "salesforce"]);
  assert.equal(created.status, 0, created.stderr);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.format_version, "mcp-capture/1");
  assert.equal(doc.capture.source_system, "salesforce");
  assert.deepEqual(doc.entries, []);
  assert.deepEqual(validate("mcpCapture", doc), { valid: true, errors: [] });
  const checked = planCli(["--validate", path]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(json(checked).entries, 0);
  assert.ok(!checked.stderr.includes("WARNING"), "a file under .captures/ is git-ignored");

  const again = planCli(["--init-capture", path, "--source-system", "salesforce"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /refusing to overwrite/);
});

// ---------------------------------------------------------------- --validate

test("--validate reports a payload-free summary and checks planned call coverage", () => {
  const result = planCli(["--validate", NORTHWIND, "--account", "Northwind Traders", "--account-id", NORTHWIND_ACCOUNT_ID]);
  assert.equal(result.status, 0, result.stderr);
  const summary = json(result);
  assert.equal(summary.valid, true);
  assert.equal(summary.source_system, "salesforce");
  assert.equal(summary.entries, 6);
  assert.equal(summary.planned_calls_checked, 6);
  assert.deepEqual(summary.entries_by_tool, { dispatch_readonly: 6 });
  assert.deepEqual(summary.queries_by_object, { Account: 2, Opportunity: 1, Contact: 1, Task: 1, Event: 1 });
  assert.deepEqual(summary.problems, []);
  for (const secret of ["Jordan", "northwind-traders", "Avery", "Phoenix", "SELECT", "001SYN"]) {
    assert.ok(!result.stdout.includes(secret), `summary must not print ${secret}`);
  }
});

test("--validate flags missing planned calls, disallowed tools and unreadable files with exit 1", () => {
  const doc = scenarios()["salesforce-northwind"];
  const partial = writeCapture("partial.json", { ...doc, entries: doc.entries.slice(0, 3) });
  const missing = planCli(["--validate", partial, "--account", "Northwind Traders", "--account-id", NORTHWIND_ACCOUNT_ID]);
  assert.equal(missing.status, 1);
  const summary = json(missing);
  assert.equal(summary.valid, false);
  assert.deepEqual(summary.problems, ["missing planned call: evidence/Contact.", "missing planned call: evidence/Task.", "missing planned call: evidence/Event."]);

  const wrongAccount = planCli(["--validate", NORTHWIND, "--account", "Contoso Example"]);
  assert.equal(wrongAccount.status, 1);
  assert.deepEqual(json(wrongAccount).problems, ["missing planned call: account_search/search."]);

  const writeTool = writeCapture("write-tool.json", {
    ...doc,
    entries: [{ tool: "dispatch", args: { url: "/x", method: "POST" }, result: { status_code: 200 }, captured_at: "2026-11-04T10:00:00Z" }],
  });
  const forbidden = planCli(["--validate", writeTool]);
  assert.equal(forbidden.status, 1);
  assert.ok(json(forbidden).problems.some((p) => /tool dispatch is not allowed/.test(p)));
  assert.ok(json(forbidden).problems.some((p) => /method must be GET/.test(p)));

  const garbage = join(tmp, "garbage.json");
  writeFileSync(garbage, "nope");
  const unreadable = planCli(["--validate", garbage]);
  assert.equal(unreadable.status, 1);
  assert.equal(json(unreadable).valid, false);
  const absent = planCli(["--validate", join(tmp, "absent.json")]);
  assert.equal(absent.status, 1);
  assert.match(json(absent).problems[0], /CAPTURE_UNREADABLE/);
});

test("--validate counts recorded errors without printing them", () => {
  const doc = scenarios()["salesforce-northwind"];
  const entries = structuredClone(doc.entries);
  const { result: _drop, ...base } = entries[3];
  entries[3] = { ...base, error: { error_code: "API_ERROR", status_code: 400, body: "[{\"message\":\"TOP-SECRET\",\"errorCode\":\"INVALID_FIELD\"}]" } };
  const path = writeCapture("with-error.json", { ...doc, entries });
  const result = planCli(["--validate", path]);
  assert.equal(result.status, 0);
  assert.equal(json(result).recorded_errors, 1);
  assert.ok(!result.stdout.includes("TOP-SECRET"));
});

test("raw captures stay git-ignored and the npm script exists", () => {
  assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^\.captures\/$/m);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["salesforce-capture-plan"], "node bin/salesforce-capture-plan.js");
  assert.ok(existsSync(resolve(root, "bin/salesforce-capture-plan.js")));
});
