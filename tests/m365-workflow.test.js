import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { createCaptureSession, captureExitCode, formatDiagnostic } from "../cli/capture-mode.js";
import { createSourceRouterEvidenceAdapter } from "../adapters/source-router-evidence-adapter.js";
import { validate } from "../schemas/index.js";
import { NORTHWIND_ACCOUNT_ID, scenarios as sfScenarios } from "./helpers/salesforce-scenarios.js";
import { m365CaptureDoc, m365Entry, m365Error, mappingDoc, m365Hit, m365Page } from "./helpers/m365-capture.js";
import { northwindEntries } from "./helpers/m365-scenarios.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SF = resolve(root, "fixtures/salesforce-northwind/capture.json");
const M365 = resolve(root, "fixtures/m365-northwind/capture.json");
const MAPPING = resolve(root, "fixtures/m365-northwind/mapping.yaml");
const UNMAPPED_CAPTURE = resolve(root, "fixtures/m365-unmapped/capture.json");
const tmp = mkdtempSync(join(tmpdir(), "m365-workflow-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(root, "bin", script), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const json = (result) => JSON.parse(result.stdout);
const stable = ({ trace_id: _t, started_at: _s, finished_at: _f, ...rest }) => JSON.stringify(rest).replace(/"retrieved_at":"[^"]+"/g, "");
const write = (name, content) => {
  const path = join(tmp, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};
const stepOf = (workflow, name) => workflow.steps.find((step) => step.step === name);

const WORKFLOWS = [
  { script: "prepare-first-meeting.js", args: ["--account", "Northwind Traders"], status: "success", exit: 0 },
  { script: "prepare-first-meeting-v2.js", args: ["--account", "Northwind Traders"], status: "success", exit: 0 },
  { script: "qualification.js", args: ["--account", "Northwind Traders"], status: "partial", exit: 2 },
  { script: "prepare-engagement.js", args: ["--account", "Northwind Traders"], status: "partial", exit: 2 },
  { script: "opportunity-strategy.js", args: ["--account", "Northwind Traders"], status: "partial", exit: 2 },
];
const both = ["--source", "capture", "--capture", SF, "--capture-m365", M365, "--m365-mapping", MAPPING];

// ---------------------------------------------------------------- both sources, every workflow

for (const cli of WORKFLOWS) {
  test(`${cli.script}: SF + M365 captures give two sources and the same status/exit as Salesforce alone`, () => {
    const result = run(cli.script, [...cli.args, ...both]);
    assert.equal(result.status, cli.exit, result.stderr);
    const workflow = json(result);
    assert.equal(workflow.status, cli.status);
    assert.deepEqual(workflow.errors, []);
    // internal_document is a default source of every workflow in capture mode: the M365 adapter ran.
    assert.match(result.stderr, /capture: M365_PERSONAL_EXCLUDED: 1 hit\(s\)/);
    const retrieve = stepOf(workflow, "evidence.retrieve");
    if (retrieve) {
      assert.equal(retrieve.source_count, 2, "crm and internal_document are the default capture sources");
      assert.equal(retrieve.record_count, 8, "5 Salesforce records + 3 SharePoint documents");
      assert.ok(workflow.artifact.markdown.includes("SharePoint document"), "M365 claims are cited in the artifact");
    }
    assert.ok(!result.stderr.includes("REPLAY_INCOMPLETE"));
    assert.ok(!result.stdout.includes("Unrelated Root File") && !result.stdout.includes("Personal Draft"), "excluded hits never reach the output");
    const again = run(cli.script, [...cli.args, ...both]);
    assert.equal(stable(json(again)), stable(workflow), "deterministic over the same captures");
  });
}

test("first-meeting: M365 claims appear under Additional permitted evidence with citations; diagnostics are counts only", () => {
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", ...both]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = json(result);
  assert.deepEqual(validate("workflowResult", workflow), { valid: true, errors: [] });
  const markdown = workflow.artifact.markdown;
  const section = markdown.slice(markdown.indexOf("## Additional permitted evidence"), markdown.indexOf("## Open questions"));
  assert.match(section, /SharePoint document "Example Proposal\.pptx" Last modified: 2026-09-03T15:28:28\.000Z `\[clm_[0-9a-f]+\]`/);
  assert.match(section, /SharePoint document "Example Delivery Plan\.xlsx" Location: \/sites\/ExampleDelivery\/Shared Documents\/Clients\/Northwind\/Plans/);
  assert.ok(!markdown.includes("Search snippet") && !markdown.includes("outline"), "snippets never reach the brief");
  assert.match(result.stderr, /capture: M365_PERSONAL_EXCLUDED: 1 hit\(s\) in personal OneDrive were excluded/);
  assert.match(result.stderr, /capture: M365_OUTSIDE_MAPPING_EXCLUDED: 1 hit\(s\) outside the mapped locations were excluded/);
  assert.ok(!/Personal Draft|Unrelated|someone_contoso|contoso/.test(result.stderr.replace(/capture: WARNING[^\n]*/g, "")), "diagnostics carry no names or paths");
  assert.deepEqual(workflow.account.account_id, NORTHWIND_ACCOUNT_ID);
});

test("without --capture-m365 the run is identical to the Salesforce-only run (one source, no M365 text)", () => {
  const args = ["--account", "Northwind Traders", "--source", "capture", "--capture", SF];
  const result = run("prepare-first-meeting.js", args);
  assert.equal(result.status, 0, result.stderr);
  const workflow = json(result);
  const retrieve = stepOf(workflow, "evidence.retrieve");
  assert.equal(retrieve.source_count, 1);
  assert.equal(retrieve.record_count, 5);
  assert.ok(!workflow.artifact.markdown.includes("SharePoint"));
  assert.ok(!/M365/.test(result.stderr));
});

// ---------------------------------------------------------------- flag handling

test("flag combinations that are invalid usage exit 1 without a workflow result", () => {
  const cases = [
    [["--source", "capture", "--capture-m365", M365, "--m365-mapping", MAPPING], /--source capture requires --capture PATH\./],
    [["--source", "capture", "--capture", SF, "--m365-mapping", MAPPING], /--m365-mapping requires --capture-m365/],
    [["--capture-m365", M365], /--capture-m365 requires --source capture/],
    [["--m365-mapping", MAPPING], /--m365-mapping requires --source capture/],
    [["--source", "capture", "--capture", SF, "--capture-m365", join(tmp, "missing.json"), "--m365-mapping", MAPPING], /--capture-m365 must be the path of an existing capture file/],
    [["--source", "capture", "--capture", SF, "--capture-m365", M365, "--m365-mapping", join(tmp, "missing.yaml")], /--m365-mapping must be the path of an existing mapping file/],
    [["--source", "capture", "--capture", SF, "--capture-m365", M365], /--m365-mapping must be the path of an existing mapping file \(default local\/m365-account-mapping\.yaml\)/],
    [["--source", "capture", "--capture", SF, "--sources", "internal_document"], /--sources internal_document requires --capture-m365/],
    [["--source", "capture", "--capture", SF, "--sources", "crm,internal_document"], /requires --capture-m365/],
    [["--source", "capture", "--capture", SF, "--capture-m365", M365, "--m365-mapping", MAPPING, "--sources", "public_source"], /only crm \(Salesforce capture\) and internal_document/],
  ];
  for (const [extra, message] of cases) {
    const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", ...extra]);
    // The default-mapping case only fails when the developer has no local mapping; skip it if one exists.
    if (/default local/.test(String(message)) && result.status === 0) continue;
    assert.equal(result.status, 1, `${extra.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "", "invalid usage prints no workflow result");
    assert.match(result.stderr, message);
  }
});

test("--sources internal_document alone is allowed with an M365 capture (the account is still resolved from Salesforce)", () => {
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", ...both, "--sources", "internal_document"]);
  assert.notEqual(result.status, 1, result.stderr);
  const retrieve = stepOf(json(result), "evidence.retrieve");
  assert.equal(retrieve.source_count, 1);
  assert.equal(retrieve.record_count, 3);
});

test("every workflow CLI lists the two new flags in --help and rejects them in fixture mode", () => {
  for (const cli of WORKFLOWS) {
    const help = run(cli.script, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--capture-m365 PATH/);
    assert.match(help.stdout, /--m365-mapping PATH/);
    const fixtureMode = run(cli.script, [...cli.args, "--capture-m365", M365]);
    assert.equal(fixtureMode.status, 1, cli.script);
    assert.match(fixtureMode.stderr, /--capture-m365 requires --source capture/);
  }
});

test("a capture whose source_system is wrong is rejected on either flag", () => {
  const asSalesforce = write("m365-as-sf.json", { ...m365CaptureDoc([]), capture: { ...m365CaptureDoc([]).capture, source_system: "salesforce" } });
  const wrongM365 = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", asSalesforce, "--m365-mapping", MAPPING]);
  assert.equal(wrongM365.status, 1);
  assert.equal(wrongM365.stdout, "");
  assert.match(wrongM365.stderr, /The capture is not an M365 capture/);
  const wrongSf = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", M365, "--capture-m365", M365, "--m365-mapping", MAPPING]);
  assert.equal(wrongSf.status, 1);
  assert.match(wrongSf.stderr, /The capture is not a Salesforce capture/);
});

test("an invalid mapping is rejected with problem kinds only", () => {
  const bad = write("bad-mapping.yaml", YAML.stringify(mappingDoc([{ account_id: "sf_001SYN0000000001AA", locations: [{ web_url_prefix: "https://contoso-my.sharepoint.com/personal/x/Docs/Northwind" }] }])));
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", M365, "--m365-mapping", bad]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /personal_onedrive_host/);
  assert.ok(!/contoso|Northwind Traders\//.test(result.stderr));
});

// ---------------------------------------------------------------- outcomes

test("an unmapped account: no M365 call, a clean empty internal_document source, M365_NOT_MAPPED, workflow not failed", () => {
  const otherMapping = write("other-mapping.yaml", YAML.stringify(mappingDoc([
    { account_id: "sf_001SYN0000000009AA", locations: [{ web_url_prefix: "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Other" }] },
  ])));
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", UNMAPPED_CAPTURE, "--m365-mapping", otherMapping]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = json(result);
  assert.equal(workflow.status, "success");
  const retrieve = stepOf(workflow, "evidence.retrieve");
  assert.equal(retrieve.source_count, 2);
  assert.equal(retrieve.record_count, 5);
  assert.match(result.stderr, /capture: M365_NOT_MAPPED: the account has no SharePoint mapping/);
  assert.ok(!result.stderr.includes("REPLAY_INCOMPLETE"));
});

test("an M365 401 makes the internal_document source unauthorized: partial / exit 2, Salesforce evidence intact", () => {
  const capture = write("m365-401.json", m365CaptureDoc([
    m365Entry("Northwind Traders", 0, { error: m365Error(401) }),
    m365Entry("Northwind", 0, { result: m365Page([]) }),
  ]));
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", capture, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 2, result.stderr);
  const workflow = json(result);
  assert.equal(workflow.status, "partial");
  assert.ok(workflow.warnings.length > 0 || workflow.errors.length > 0);
  assert.ok([...workflow.warnings, ...workflow.errors].some((issue) => /ADAPTER_UNAUTHORIZED|PARTIAL_SOURCES/.test(issue.code)));
  assert.equal(stepOf(workflow, "evidence.retrieve").record_count, 5);
  assert.ok(workflow.artifact.markdown.includes("Northwind"), "an artifact is still produced from the Salesforce evidence");
  assert.ok(!workflow.artifact.markdown.includes("SharePoint document"));
  assert.ok(!result.stdout.includes("secret-file") && !result.stderr.includes("req-synthetic"));
});

test("an M365 capture that misses a planned call forces exit 1 and REPLAY_INCOMPLETE naming m365-capture-plan", () => {
  const capture = write("m365-incomplete.json", m365CaptureDoc([northwindEntries()[0]]));
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", capture, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capture: REPLAY_INCOMPLETE: failed: incomplete capture/);
  assert.match(result.stderr, /npm run m365-capture-plan -- --account-id sf_<Id>/);
  assert.ok(!/salesforce-capture-plan/.test(result.stderr), "only the M365 plan CLI is named for an M365 miss");
});

test("every workflow requests internal_document by default: an incomplete M365 capture fails with REPLAY_INCOMPLETE", () => {
  const capture = write("m365-incomplete-all.json", m365CaptureDoc([northwindEntries()[0]]));
  for (const cli of WORKFLOWS) {
    const result = run(cli.script, [...cli.args, "--source", "capture", "--capture", SF, "--capture-m365", capture, "--m365-mapping", MAPPING]);
    assert.equal(result.status, 1, `${cli.script}: ${result.stderr}`);
    assert.match(result.stderr, /REPLAY_INCOMPLETE/);
    assert.match(result.stderr, /m365-capture-plan/);
  }
});

test("a mapped account with an empty M365 skeleton is a replay miss (the host forgot the searches), not an empty source", () => {
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", UNMAPPED_CAPTURE, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /REPLAY_INCOMPLETE/);
});

test("a Salesforce miss still names only salesforce-capture-plan", () => {
  const doc = sfScenarios()["salesforce-northwind"];
  doc.entries = doc.entries.filter((entry) => !/FROM Contact/.test(entry.args.queryParams?.q ?? ""));
  const result = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", write("sf-incomplete.json", doc), "--capture-m365", M365, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /salesforce-capture-plan/);
  assert.ok(!/m365-capture-plan/.test(result.stderr));
});

// ---------------------------------------------------------------- session wiring

test("createCaptureSession: a string is Salesforce only; the object form adds M365 with a router and default sources", async () => {
  const salesforceOnly = createCaptureSession(SF);
  assert.deepEqual(salesforceOnly.defaultSources, ["crm"]);
  assert.deepEqual(salesforceOnly.deps.evidenceAdapter.supportedSources, ["crm"]);
  assert.equal(salesforceOnly.deps.evidenceAdapter.name.startsWith("salesforce-evidence-adapter"), true, "no router without an M365 capture");
  const objectForm = createCaptureSession({ capturePath: SF });
  assert.deepEqual(objectForm.defaultSources, ["crm"]);

  const multi = createCaptureSession({ capturePath: SF, m365CapturePath: M365, m365MappingPath: MAPPING });
  assert.deepEqual(multi.defaultSources, ["crm", "internal_document"]);
  assert.deepEqual(multi.deps.evidenceAdapter.supportedSources, ["crm", "internal_document"]);
  assert.equal(multi.latestCreatedAt, "2026-11-05T10:00:00Z");
  assert.ok(multi.deps.claimExtractor.name.includes("m365-structured-claim-extractor"));
  const unknown = await multi.deps.evidenceAdapter.retrieve({ source_type: "public_source" });
  assert.equal(unknown.error.code, "UNSUPPORTED_SOURCE");

  const m365Only = createCaptureSession({ m365CapturePath: M365, m365MappingPath: MAPPING });
  assert.deepEqual(m365Only.defaultSources, ["internal_document"]);
  assert.equal(m365Only.deps.accountAdapter, undefined);
});

test("misses record the tool, M365 diagnostics are collected and printed as counts, and the exit code follows the rules", async () => {
  const session = createCaptureSession({ capturePath: SF, m365CapturePath: write("m365-empty.json", m365CaptureDoc([])), m365MappingPath: MAPPING });
  const result = await session.deps.evidenceAdapter.retrieve({ account_id: NORTHWIND_ACCOUNT_ID, questions: [], source_type: "internal_document", context: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(session.misses.map((miss) => miss.tool), ["sharepoint_search"]);
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    assert.equal(captureExitCode(0, session), 1);
    assert.equal(captureExitCode(2, { misses: [], diagnostics: [{ code: "M365_COPIES_MERGED", count: 2 }, { code: "M365_RECORDS_TRUNCATED", count: 60, kept: 50 }] }), 2);
  } finally { process.stderr.write = original; }
  const text = chunks.join("");
  assert.match(text, /capture: M365_COPIES_MERGED: 2 duplicate copy\(ies\) of the same document were merged\./);
  assert.match(text, /capture: M365_RECORDS_TRUNCATED: kept 50 of 60 record\(s\) were found; the per-account record limit applied\./);
  assert.equal(formatDiagnostic({ code: "M365_NOT_MAPPED" }), "capture: M365_NOT_MAPPED: the account has no SharePoint mapping; no M365 call was made and internal_document returned no records.");
});

test("the source router needs adapters, dispatches by source and reports unknown sources", async () => {
  assert.throws(() => createSourceRouterEvidenceAdapter({}), TypeError);
  assert.throws(() => createSourceRouterEvidenceAdapter({ crm: {} }), TypeError);
  const calls = [];
  const router = createSourceRouterEvidenceAdapter({
    crm: { retrieve: async (request) => { calls.push(["crm", request.source_type]); return { ok: true, records: [] }; } },
    internal_document: { retrieve: async (request) => { calls.push(["doc", request.source_type]); return { ok: true, records: [] }; } },
  });
  assert.deepEqual(router.supportedSources, ["crm", "internal_document"]);
  await router.retrieve({ source_type: "internal_document" });
  await router.retrieve({ source_type: "crm" });
  assert.deepEqual(calls, [["doc", "internal_document"], ["crm", "crm"]]);
  assert.equal((await router.retrieve({ source_type: "news" })).error.code, "UNSUPPORTED_SOURCE");
  assert.equal((await router.retrieve(undefined)).error.code, "UNSUPPORTED_SOURCE");
});

test("shuffled hit order in the M365 capture gives identical workflow output", () => {
  const reversed = northwindEntries().map((entry) => {
    const blocks = entry.result.content;
    const trailer = blocks.at(-1);
    return { ...entry, result: { content: [...blocks.slice(0, -1).reverse(), trailer] } };
  });
  const capture = write("m365-shuffled.json", m365CaptureDoc(reversed));
  const base = run("prepare-first-meeting.js", ["--account", "Northwind Traders", ...both]);
  const shuffled = run("prepare-first-meeting.js", ["--account", "Northwind Traders", "--source", "capture", "--capture", SF, "--capture-m365", capture, "--m365-mapping", MAPPING]);
  assert.equal(shuffled.status, 0, shuffled.stderr);
  assert.equal(stable(json(shuffled)), stable(json(base)));
  assert.ok(m365Hit && true);
});
