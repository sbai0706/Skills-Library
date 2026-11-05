import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCapture } from "../adapters/mcp/index.js";
import { searchArgs } from "../adapters/m365/index.js";
import { validate } from "../schemas/index.js";
import {
  NORTHWIND_SF_ID, SALES_PREFIX, m365CaptureDoc, m365Entry, m365Error, m365Hit, m365Page, moreTrailer,
} from "./helpers/m365-capture.js";
import { NORTHWIND_MAPPING_YAML, northwindEntries } from "./helpers/m365-scenarios.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "m365-capture-cli-"));
const work = join(root, ".captures", `test-m365-${process.pid}-${Date.now()}`);
test.after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const MAPPING = join(tmp, "mapping.yaml");
writeFileSync(MAPPING, NORTHWIND_MAPPING_YAML);

function plan(args) {
  const result = spawnSync(process.execPath, [resolve(root, "bin/m365-capture-plan.js"), ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
const json = (result) => JSON.parse(result.stdout);
const write = (name, doc) => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
};
const validateArgs = (path, extra = []) => ["--validate", path, ...extra];

test("--help lists the modes and exits 0", () => {
  const result = plan(["--help"]);
  assert.equal(result.status, 0);
  for (const flag of ["--account-id", "--init-capture", "--validate", "--check-mapping", "--m365-mapping"]) assert.match(result.stdout, new RegExp(flag));
  assert.match(result.stdout, /sharepoint_search/);
});

test("invalid invocations exit 1 with a diagnostic and no stdout", () => {
  const cases = [
    [[], /Choose a mode/],
    [["--bogus"], /Unknown option/],
    [["--account-id"], /Missing value/],
    [["--account-id", "Northwind Traders"], /--account-id must be/],
    [["--account-id", NORTHWIND_SF_ID, "--account-id", NORTHWIND_SF_ID], /only be provided once/],
    [["--account-id", NORTHWIND_SF_ID, "--check-mapping"], /cannot be combined/],
    [["--init-capture", ".captures/x.json", "--validate", "y.json"], /cannot be combined/],
    [["--init-capture", ".captures/x.json", "--m365-mapping", MAPPING], /not valid with --init-capture/],
    [["--validate", "x.json", "--m365-mapping", MAPPING], /--m365-mapping with --validate requires --account-id/],
  ];
  for (const [args, message] of cases) {
    const result = plan(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});

// ---------------------------------------------------------------- plan

test("--account-id prints the exact search calls for a mapped account", () => {
  const result = plan(["--account-id", NORTHWIND_SF_ID, "--m365-mapping", MAPPING]);
  assert.equal(result.status, 0, result.stderr);
  const out = json(result);
  assert.equal(out.phase, "m365_search");
  assert.equal(out.mapped, true);
  assert.equal(out.account_id, NORTHWIND_SF_ID);
  assert.deepEqual(out.calls, [
    { step: "search_1", tool: "sharepoint_search", args: searchArgs("Northwind Traders", 0) },
    { step: "search_2", tool: "sharepoint_search", args: searchArgs("Northwind", 0) },
  ]);
  assert.equal(out.max_pages_per_search, 4);
  const rules = out.host_rules.join("\n");
  for (const required of ["sharepoint_search", "read_resource", "sharepoint_folder_search", "nextOffset", "graphRetryAfterSeconds", ".captures/", "never paste"]) {
    assert.ok(rules.includes(required), required);
  }
});

test("an unmapped account has no calls and a note, exit 0", () => {
  const result = plan(["--account-id", "sf_001SYN0000000002AA", "--m365-mapping", MAPPING]);
  assert.equal(result.status, 0);
  const out = json(result);
  assert.equal(out.mapped, false);
  assert.deepEqual(out.calls, []);
  assert.match(out.note, /No M365 call is needed/);
});

test("a missing or invalid mapping exits 1 with problem kinds only", () => {
  const missing = plan(["--account-id", NORTHWIND_SF_ID, "--m365-mapping", join(tmp, "missing.yaml")]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /cannot be read/);
  const bad = join(tmp, "bad.yaml");
  writeFileSync(bad, NORTHWIND_MAPPING_YAML.replace("https://contoso.sharepoint.com/sites/ExampleSales", "https://contoso-my.sharepoint.com/personal/x_contoso_com"));
  const result = plan(["--account-id", NORTHWIND_SF_ID, "--m365-mapping", bad]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accounts\[0\]\.locations\[0\]\.web_url_prefix: personal_onedrive_host/);
  assert.ok(!/contoso|Northwind/.test(result.stderr));
});

// ---------------------------------------------------------------- --check-mapping

test("--check-mapping prints counts and indexes only", () => {
  const ok = plan(["--check-mapping", "--m365-mapping", MAPPING]);
  assert.equal(ok.status, 0);
  assert.deepEqual(json(ok), { valid: true, accounts: 1, locations: 2, problems: [] });
  const bad = join(tmp, "bad-check.yaml");
  writeFileSync(bad, NORTHWIND_MAPPING_YAML.replace(`web_url_prefix: "${SALES_PREFIX}"`, 'web_url_prefix: "https://contoso.sharepoint.com/Shared Documents/Northwind Traders"'));
  const result = plan(["--check-mapping", "--m365-mapping", bad]);
  assert.equal(result.status, 1);
  const out = json(result);
  assert.equal(out.valid, false);
  assert.deepEqual(out.problems.slice(-1), ["accounts[0].locations[0].web_url_prefix: not_site_library_path"]);
  assert.ok(!/contoso|Northwind/.test(result.stdout));
  const missing = plan(["--check-mapping", "--m365-mapping", join(tmp, "missing.yaml")]);
  assert.equal(missing.status, 1);
  assert.equal(json(missing).valid, false);
});

test("the default mapping path is local/m365-account-mapping.yaml, which is git-ignored", () => {
  assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^\/local\/$/m);
  if (!existsSync(resolve(root, "local/m365-account-mapping.yaml"))) {
    const result = plan(["--check-mapping"]);
    assert.equal(result.status, 1);
    assert.match(json(result).problems[0], /cannot be read/);
  }
});

// ---------------------------------------------------------------- --init-capture

test("--init-capture writes a valid empty M365 skeleton under .captures/ and never overwrites", () => {
  const target = `.captures/${work.split(/[\\/]/).pop()}/skeleton.json`;
  const first = plan(["--init-capture", target]);
  assert.equal(first.status, 0, first.stderr);
  const doc = JSON.parse(readFileSync(resolve(root, target), "utf8"));
  assert.deepEqual(validate("mcpCapture", doc), { valid: true, errors: [] });
  assert.equal(doc.capture.source_system, "m365");
  assert.equal(doc.capture.connector, "Microsoft 365 connector (sharepoint_search)");
  assert.deepEqual(doc.entries, []);
  const again = plan(["--init-capture", target]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(JSON.parse(readFileSync(resolve(root, target), "utf8")).capture.created_at, doc.capture.created_at);
  assert.equal(plan(validateArgs(resolve(root, target))).status, 0, "an empty skeleton is a valid M365 capture");
});

test("--init-capture refuses targets outside .captures/ and directories", () => {
  mkdirSync(work, { recursive: true });
  for (const target of [join(tmp, "x.json"), "x.json", "../x.json", ".captures/../x.json", ".captures", ".captures/", ".captures-other/x.json"]) {
    const result = plan(["--init-capture", target]);
    assert.equal(result.status, 1, target);
    assert.match(result.stderr, /--init-capture (refuses any target outside|needs a file path)/);
  }
  assert.ok(!existsSync(join(tmp, "x.json")) && !existsSync(resolve(root, "x.json")));
});

// ---------------------------------------------------------------- --validate

test("--validate accepts the Northwind capture and prints a payload-free summary", () => {
  const path = write("ok.json", m365CaptureDoc(northwindEntries()));
  const result = plan(validateArgs(path, ["--account-id", NORTHWIND_SF_ID, "--m365-mapping", MAPPING]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = json(result);
  assert.equal(out.valid, true);
  assert.equal(out.source_system, "m365");
  assert.equal(out.entries, 2);
  assert.equal(out.searches, 2);
  assert.equal(out.pages, 2);
  assert.equal(out.hits_total, 6);
  assert.equal(out.planned_calls_checked, 2);
  assert.deepEqual(out.problems, []);
  assert.ok(!/Example|contoso|Northwind|SYN/.test(result.stdout), "no names, URLs or ids in the summary");
});

test("--validate without --account-id checks the capture alone; an unmapped account plans nothing", () => {
  const empty = write("empty.json", m365CaptureDoc([]));
  const alone = plan(validateArgs(empty));
  assert.equal(alone.status, 0);
  assert.equal(json(alone).planned_calls_checked, undefined);
  const unmapped = plan(validateArgs(empty, ["--account-id", "sf_001SYN0000000002AA", "--m365-mapping", MAPPING]));
  assert.equal(unmapped.status, 0);
  assert.equal(json(unmapped).planned_calls_checked, 0);
});

function problemsFor(doc, extra = []) {
  const result = plan(validateArgs(write(`v-${Math.random().toString(36).slice(2)}.json`, doc), extra));
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/Example|contoso|Northwind|SYN|secret/i.test(result.stdout), "problems never print args, names or ids");
  return json(result).problems;
}
const entry = (outcome = { result: m365Page([m365Hit({ n: 1 })]) }, folder = "Northwind Traders", offset = 0) => m365Entry(folder, offset, outcome);

test("--validate: wrong source_system", () => {
  const doc = m365CaptureDoc([entry()]);
  doc.capture.source_system = "salesforce";
  assert.ok(problemsFor(doc).includes("capture.source_system must be m365."));
});

test("--validate: any tool other than sharepoint_search (e.g. read_resource)", () => {
  const bad = { tool: "read_resource", args: { uri: "file:///b!SYNdrive0001/01SYNITEM0001" }, result: { content: [] }, captured_at: "2026-11-05T10:00:01Z" };
  const problems = problemsFor(m365CaptureDoc([entry(), bad]));
  assert.ok(problems.some((p) => /entry 1: tool read_resource is not allowed/.test(p)), problems.join("|"));
});

test("--validate: argument rules (extra key, query, limit, offset, folderName)", () => {
  const withArgs = (args) => ({ ...entry(), args });
  const cases = [
    [{ ...searchArgs("Northwind Traders", 0), fileType: "docx" }, /exactly query, folderName, limit and offset/],
    [{ query: "*", folderName: "Northwind Traders", limit: 50 }, /exactly query, folderName, limit and offset/],
    [{ ...searchArgs("Northwind Traders", 0), query: "northwind" }, /query must be/],
    [{ ...searchArgs("Northwind Traders", 0), limit: 25 }, /limit must be 50/],
    [{ ...searchArgs("Northwind Traders", 0), offset: 1.5 }, /offset must be a non-negative integer/],
    [{ ...searchArgs("Northwind Traders", 0), offset: -1 }, /offset must be a non-negative integer/],
    [{ ...searchArgs("Northwind Traders", 0), folderName: " " }, /folderName must be a non-empty string/],
  ];
  for (const [args, pattern] of cases) {
    assert.ok(problemsFor(m365CaptureDoc([withArgs(args)])).some((p) => pattern.test(p)), JSON.stringify(args));
  }
});

test("--validate: a result that parseSearchResult rejects", () => {
  const doc = m365CaptureDoc([entry({ result: { content: [{ type: "text", text: "not json" }] } })]);
  assert.ok(problemsFor(doc).some((p) => /entry 0: the result is not a valid sharepoint_search result/.test(p)));
  const structured = m365CaptureDoc([entry({ result: { content: [], structuredContent: {} } })]);
  assert.ok(problemsFor(structured).some((p) => /not a valid sharepoint_search result/.test(p)));
});

test("--validate: a moreResults page needs the next page; the page cap and recorded errors are handled", () => {
  const more = (offset, next) => entry({ result: m365Page([m365Hit({ n: offset + 1 })], moreTrailer(next)) }, "Northwind Traders", offset);
  assert.ok(problemsFor(m365CaptureDoc([more(0, 7)])).some((p) => /entry 0: missing pagination page/.test(p)));
  assert.ok(problemsFor(m365CaptureDoc([more(0, 7), entry({ result: m365Page([m365Hit({ n: 9 })]) }, "Northwind Traders", 50)])).some((p) => /missing pagination page/.test(p)), "wrong offset");
  assert.ok(problemsFor(m365CaptureDoc([more(0, 7), entry({ error: m365Error(500) }, "Northwind Traders", 7)])).some((p) => /missing pagination page/.test(p)), "an error is not a page");
  assert.ok(problemsFor(m365CaptureDoc([more(0, 7), entry({ result: m365Page([m365Hit({ n: 8 })]) }, "Another Folder", 7)])).some((p) => /missing pagination page/.test(p)), "other folder");
  assert.ok(problemsFor(m365CaptureDoc([entry({ result: m365Page([m365Hit({ n: 1 })], moreTrailer(0)) })])).some((p) => /invalid nextOffset/.test(p)));

  const good = m365CaptureDoc([more(0, 7), entry({ result: m365Page([m365Hit({ n: 8 })]) }, "Northwind Traders", 7)]);
  assert.equal(plan(validateArgs(write("pages.json", good))).status, 0);

  const capped = m365CaptureDoc([0, 1, 2, 3].map((p) => more(p * 50, (p + 1) * 50)));
  assert.equal(plan(validateArgs(write("capped.json", capped))).status, 0, "the fourth page may end with moreResults (truncated search)");
  const recorded = m365CaptureDoc([entry({ error: m365Error(429, { retryAfter: 3 }) })]);
  const out = plan(validateArgs(write("recorded.json", recorded)));
  assert.equal(out.status, 0);
  assert.equal(json(out).recorded_errors, 1);
});

test("--validate: a missing planned page-1 call", () => {
  const partial = m365CaptureDoc([northwindEntries()[0]]);
  const problems = problemsFor(partial, ["--account-id", NORTHWIND_SF_ID, "--m365-mapping", MAPPING]);
  assert.ok(problems.includes("missing planned call: search_2."), problems.join("|"));
});

test("--validate: an unreadable or schema-invalid capture is a payload-free failure", () => {
  const bad = join(tmp, "notjson.json");
  writeFileSync(bad, "{not json");
  const result = plan(validateArgs(bad));
  assert.equal(result.status, 1);
  assert.match(json(result).problems[0], /CAPTURE_UNREADABLE/);
  const invalid = plan(validateArgs(write("schema.json", { format_version: "nope" })));
  assert.equal(invalid.status, 1);
  assert.match(json(invalid).problems[0], /CAPTURE_INVALID/);
});

test("the capture produced by the plan, once recorded, loads with the M365 redaction", () => {
  const client = loadCapture(write("loaded.json", m365CaptureDoc([entry({ error: m365Error(500) })])), { redact: ["details.graphRequestId", "details.uriPath"] });
  assert.equal(client.entries[0].error.details.graphRequestId, "[REDACTED]");
});
