import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validate } from "../schemas/index.js";
import { NORTHWIND_ACCOUNT_ID } from "./helpers/salesforce-scenarios.js";
import { SALES_PREFIX, m365CaptureDoc, m365Entry, m365Error, m365Hit, m365Page, mappingDoc } from "./helpers/m365-capture.js";
import { northwindEntries } from "./helpers/m365-scenarios.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SF = resolve(root, "fixtures/salesforce-northwind/capture.json");
const M365 = resolve(root, "fixtures/m365-northwind/capture.json");
const MAPPING = resolve(root, "fixtures/m365-northwind/mapping.yaml");
const tmp = mkdtempSync(join(tmpdir(), "source-rank-capture-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function rank(args) {
  const result = spawnSync(process.execPath, [resolve(root, "bin/source-rank.js"), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const json = (result) => JSON.parse(result.stdout);
const stable = ({ trace_id: _t, started_at: _s, finished_at: _f, ...rest }) => JSON.stringify(rest);
const write = (name, content) => {
  const path = join(tmp, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};
const withoutWarnings = (stderr) => stderr.replace(/capture: WARNING[^\n]*\n/g, "");

const capture = ["--source", "capture", "--account", NORTHWIND_ACCOUNT_ID];
const bothCaptures = [...capture, "--capture", SF, "--capture-m365", M365, "--m365-mapping", MAPPING];
const m365Doc = (entries) => write(`m365-${Math.random().toString(36).slice(2)}.json`, m365CaptureDoc(entries));
const northwindMapping = (locationExtra = {}, accountId = NORTHWIND_ACCOUNT_ID) => write(`mapping-${Math.random().toString(36).slice(2)}.yaml`, YAML.stringify(mappingDoc([
  { account_id: accountId, locations: [{ web_url_prefix: SALES_PREFIX, ...locationExtra }] },
])));
const salesOnly = (hits) => [m365Entry("Northwind Traders", 0, { result: m365Page(hits) })];

// ---------------------------------------------------------------- Salesforce + M365

test("capture mode ranks salesforce and m365_sharepoint on their data timestamps", () => {
  const result = rank([...bothCaptures, "--output", "json"]);
  assert.equal(result.status, 0, result.stderr);
  const skill = json(result);
  assert.equal(skill.skill, "source.rank");
  assert.equal(skill.status, "success");
  assert.deepEqual(validate("skillResult", skill), { valid: true, errors: [] });
  assert.equal(skill.data.account_id, NORTHWIND_ACCOUNT_ID);
  assert.equal(skill.data.now, "2026-11-05T10:00:00Z", "default clock = the latest capture.created_at");
  assert.deepEqual(skill.data.sources.map((s) => [s.rank, s.source_id, s.recency, s.latest_data_at, s.latest_data_at_field, s.record_count]), [
    [1, "salesforce", "dated", "2026-10-20T12:30:00Z", "occurred_at", 5],
    [2, "m365_sharepoint", "dated", "2026-10-12T09:15:00Z", "occurred_at", 3],
  ]);
  assert.ok(!skill.warnings.some((w) => w.code === "RETRIEVAL_TIME_FALLBACK"), "no source falls back to retrieval time");
  assert.deepEqual(skill.data.sources.map((s) => s.source_types), [["crm_activity", "crm_record"], ["internal_document"]]);
  assert.match(result.stderr, /capture: M365_PERSONAL_EXCLUDED: 1 hit\(s\)/);
  assert.ok(!/Personal Draft|Example|contoso/.test(withoutWarnings(result.stderr)));
});

test("the capture-mode result is deterministic and --now overrides the clock", () => {
  const a = json(rank(bothCaptures));
  const b = json(rank(bothCaptures));
  assert.equal(stable(a), stable(b));
  const later = json(rank([...bothCaptures, "--now", "2026-12-05T10:00:00Z"]));
  assert.equal(later.data.now, "2026-12-05T10:00:00Z");
  assert.equal(later.data.sources[0].age_days, a.data.sources[0].age_days + 30);
});

test("Markdown output lists both sources as a recency-only table", () => {
  const result = rank([...bothCaptures, "--output", "markdown"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Recency ordering only/);
  assert.match(result.stdout, /\| 1 \| salesforce \| 2026-10-20T12:30:00Z \| occurred_at \|/);
  assert.match(result.stdout, /\| 2 \| m365_sharepoint \| 2026-10-12T09:15:00Z \| occurred_at \|/);
});

test("Salesforce-only and M365-only runs rank one source each", () => {
  const sfOnly = json(rank([...capture, "--capture", SF]));
  assert.deepEqual(sfOnly.data.sources.map((s) => s.source_id), ["salesforce"]);
  const m365Only = rank([...capture, "--capture-m365", M365, "--m365-mapping", MAPPING]);
  assert.equal(m365Only.status, 0, m365Only.stderr);
  const skill = json(m365Only);
  assert.deepEqual(skill.data.sources.map((s) => [s.source_id, s.latest_data_at]), [["m365_sharepoint", "2026-10-12T09:15:00Z"]]);
  assert.equal(skill.data.now, "2026-11-05T10:00:00Z");
});

test("with only M365 a mapped acct_ id is accepted; with a Salesforce capture it must be an sf_ id", () => {
  const mapping = northwindMapping({}, "acct_northwind_001");
  const entries = m365Doc(salesOnly([m365Hit({ n: 1 })]));
  const ok = rank(["--source", "capture", "--account", "acct_northwind_001", "--capture-m365", entries, "--m365-mapping", mapping]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(json(ok).data.sources.map((s) => s.source_id), ["m365_sharepoint"]);
  const bad = rank(["--source", "capture", "--account", "acct_northwind_001", "--capture", SF]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--account must be a resolved account id: sf_/);
});

test("an unmapped account ranks the Salesforce source alone and reports M365_NOT_MAPPED", () => {
  const otherMapping = northwindMapping({}, "sf_001SYN0000000009AA");
  const result = rank([...capture, "--capture", SF, "--capture-m365", M365, "--m365-mapping", otherMapping]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(result).data.sources.map((s) => s.source_id), ["salesforce"]);
  assert.match(result.stderr, /capture: M365_NOT_MAPPED:/);
});

test("M365 alone with an unmapped account has nothing to rank: blocked, exit 3", () => {
  const result = rank([...capture, "--capture-m365", M365, "--m365-mapping", northwindMapping({}, "sf_001SYN0000000009AA")]);
  assert.equal(result.status, 3, result.stderr);
  const skill = json(result);
  assert.equal(skill.status, "blocked");
  assert.equal(skill.data, null);
  assert.match(result.stderr, /M365_NOT_MAPPED/);
});

// ---------------------------------------------------------------- retrieval outcomes

/** Blocked or failed retrieval with `--output json`: a parseable source.rank envelope, no ranking. */
function assertStopEnvelope(result, status) {
  const skill = json(result);
  assert.equal(skill.skill, "source.rank");
  assert.equal(skill.status, status);
  assert.equal(skill.data, null);
  assert.deepEqual(skill.evidence_ids, []);
  assert.ok(skill.errors.length > 0, "the retrieval's errors are carried over");
  assert.deepEqual(validate("skillResult", skill), { valid: true, errors: [] });
  assert.ok(!result.stdout.includes("req-synthetic") && !result.stdout.includes("secret-file"), "no payload content on stdout");
  return skill;
}

test("a blocked or failed capture-mode ranking prints the JSON envelope for --output json and nothing for markdown", () => {
  const blockedEntries = m365Doc([m365Entry("Northwind Traders", 0, { error: m365Error(403) }), m365Entry("Northwind", 0, { result: m365Page([]) })]);
  const blockedArgs = [...capture, "--capture-m365", blockedEntries, "--m365-mapping", MAPPING];
  for (const args of [blockedArgs, [...blockedArgs, "--output", "json"]]) {
    const result = rank(args);
    assert.equal(result.status, 3, result.stderr);
    assert.ok(assertStopEnvelope(result, "blocked").errors.some((error) => error.code === "ADAPTER_UNAUTHORIZED"));
  }
  const markdown = rank([...blockedArgs, "--output", "markdown"]);
  assert.equal(markdown.status, 3);
  assert.equal(markdown.stdout, "");
  assert.match(markdown.stderr, /source\.rank: RETRIEVAL_BLOCKED: ADAPTER_UNAUTHORIZED/);

  const failedEntries = m365Doc([m365Entry("Northwind Traders", 0, { error: m365Error(500) }), m365Entry("Northwind", 0, { result: m365Page([]) })]);
  const failed = rank([...capture, "--capture-m365", failedEntries, "--m365-mapping", MAPPING, "--output", "json"]);
  assert.equal(failed.status, 1);
  assertStopEnvelope(failed, "failed");
});

test("a failing M365 source (401) is a partial retrieval: the Salesforce ranking is printed and the exit is 2", () => {
  const entries = m365Doc([m365Entry("Northwind Traders", 0, { error: m365Error(401) }), m365Entry("Northwind", 0, { result: m365Page([]) })]);
  const result = rank([...capture, "--capture", SF, "--capture-m365", entries, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(json(result).data.sources.map((s) => s.source_id), ["salesforce"]);
  assert.match(result.stderr, /evidence\.retrieve: ADAPTER_UNAUTHORIZED \(source internal_document\)/);
  assert.match(result.stderr, /source\.rank: PARTIAL_SOURCES/);
  assert.ok(!result.stderr.includes("req-synthetic") && !result.stdout.includes("secret-file"));
});

test("when every source fails with an authorization error retrieval is blocked: exit 3, no ranking", () => {
  const entries = m365Doc([m365Entry("Northwind Traders", 0, { error: m365Error(403) }), m365Entry("Northwind", 0, { result: m365Page([]) })]);
  const result = rank([...capture, "--capture-m365", entries, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 3);
  assertStopEnvelope(result, "blocked");
  assert.match(result.stderr, /source\.rank: RETRIEVAL_BLOCKED: ADAPTER_UNAUTHORIZED/);
});

test("when every source fails with an execution error retrieval failed: exit 1, no ranking", () => {
  const entries = m365Doc([m365Entry("Northwind Traders", 0, { error: m365Error(500) }), m365Entry("Northwind", 0, { result: m365Page([]) })]);
  const result = rank([...capture, "--capture-m365", entries, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 1);
  assertStopEnvelope(result, "failed");
  assert.match(result.stderr, /source\.rank: RETRIEVAL_FAILED: ADAPTER_UNAVAILABLE/);
});

test("a replay miss in either capture forces exit 1 with REPLAY_INCOMPLETE (the ranking is still printed when produced)", () => {
  const m365Miss = rank([...capture, "--capture", SF, "--capture-m365", m365Doc([northwindEntries()[0]]), "--m365-mapping", MAPPING]);
  assert.equal(m365Miss.status, 1);
  assert.match(m365Miss.stderr, /REPLAY_INCOMPLETE/);
  assert.match(m365Miss.stderr, /m365-capture-plan/);
  assert.deepEqual(json(m365Miss).data.sources.map((s) => s.source_id), ["salesforce"], "rank JSON of the remaining source is printed");

  const doc = JSON.parse(readFileSync(SF, "utf8"));
  doc.entries = doc.entries.filter((entry) => !/FROM Contact/.test(entry.args.queryParams?.q ?? ""));
  const sfMiss = rank([...capture, "--capture", write("sf-miss.json", doc), "--capture-m365", M365, "--m365-mapping", MAPPING]);
  assert.equal(sfMiss.status, 1);
  assert.match(sfMiss.stderr, /salesforce-capture-plan/);
});

test("--classification sets the access ceiling: confidential locations are withheld by default", () => {
  const mapping = northwindMapping({ classification: "confidential" });
  const entries = m365Doc(salesOnly([m365Hit({ n: 1 })]));
  const args = [...capture, "--capture-m365", entries, "--m365-mapping", mapping];
  const withheld = rank(args);
  assert.equal(withheld.status, 3, withheld.stderr);
  assert.match(withheld.stderr, /CLASSIFICATION_RESTRICTED/);
  assert.match(withheld.stderr, /source\.rank: RETRIEVAL_BLOCKED: CLASSIFICATION_RESTRICTED/);
  const visible = rank([...args, "--classification", "confidential"]);
  assert.equal(visible.status, 0, visible.stderr);
  assert.deepEqual(json(visible).data.sources.map((s) => s.source_id), ["m365_sharepoint"]);
});

test("a public ceiling withholds internal records; an internal ceiling is the default", () => {
  const publicOnly = rank([...bothCaptures, "--classification", "public"]);
  assert.equal(publicOnly.status, 3, publicOnly.stderr);
  assertStopEnvelope(publicOnly, "blocked");
  const explicit = rank([...bothCaptures, "--classification", "internal"]);
  assert.equal(stable(json(explicit)), stable(json(rank(bothCaptures))));
});

// ---------------------------------------------------------------- usage

test("invalid usage exits 1 with a diagnostic and no stdout", () => {
  const cases = [
    [["--source", "capture", "--capture", SF], /--account is required with --source capture/],
    [["--source", "capture", "--account", NORTHWIND_ACCOUNT_ID], /--source capture requires --capture PATH and\/or --capture-m365 PATH/],
    [["--source", "capture", "--account", "Northwind Traders", "--capture", SF], /--account must be a resolved account id/],
    [["--source", "capture", "--account", "sf_001SYN", "--capture", SF], /--account must be a resolved account id/],
    [[...bothCaptures, "--fixture", "source-rank-recency"], /--fixture cannot be used with --source capture/],
    [[...capture, "--capture", SF, "--m365-mapping", MAPPING], /--m365-mapping requires --capture-m365/],
    [[...capture, "--capture", SF, "--classification", "secret"], /--classification must be public, internal or confidential/],
    [["--classification", "internal"], /--classification requires --source capture/],
    [["--capture", SF], /--capture requires --source capture/],
    [["--capture-m365", M365], /--capture-m365 requires --source capture/],
    [["--source", "live"], /--source must be fixture or capture/],
    [[...capture, "--capture", join(tmp, "missing.json")], /--capture must be the path of an existing capture file/],
    [[...capture, "--capture-m365", M365, "--m365-mapping", join(tmp, "missing.yaml")], /--m365-mapping must be the path of an existing mapping file/],
  ];
  for (const [args, message] of cases) {
    const result = rank(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});

test("wrong source_system captures and invalid mappings are rejected with exit 1", () => {
  const swapped = rank([...capture, "--capture", M365]);
  assert.equal(swapped.status, 1);
  assert.match(swapped.stderr, /not a Salesforce capture/);
  const swappedM365 = rank([...capture, "--capture-m365", SF, "--m365-mapping", MAPPING]);
  assert.equal(swappedM365.status, 1);
  assert.match(swappedM365.stderr, /not an M365 capture/);
  const badMapping = write("bad.yaml", YAML.stringify(mappingDoc([{ account_id: NORTHWIND_ACCOUNT_ID, locations: [{ web_url_prefix: "https://contoso.sharepoint.com/Shared Documents/Northwind" }] }])));
  const result = rank([...capture, "--capture-m365", M365, "--m365-mapping", badMapping]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not_site_library_path/);
  assert.equal(result.stdout, "");
});

test("--help documents the capture options", () => {
  const help = rank(["--help"]);
  assert.equal(help.status, 0);
  for (const flag of ["--source MODE", "--capture PATH", "--capture-m365 PATH", "--m365-mapping PATH", "--classification VALUE"]) assert.ok(help.stdout.includes(flag), flag);
});

test("fixture mode is unchanged: explicit --source fixture matches the implicit run", () => {
  const implicit = rank([]);
  const explicit = rank(["--source", "fixture"]);
  assert.equal(implicit.status, 2);
  assert.equal(explicit.status, 2);
  assert.equal(stable(json(explicit)), stable(json(implicit)));
  assert.equal(explicit.stderr, implicit.stderr);
});
