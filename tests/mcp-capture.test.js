import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCapture, CaptureError, CAPTURE_LIMITS, REDACTION_MARKER, mapMcpError } from "../adapters/mcp/index.js";
import { validate } from "../schemas/index.js";

const FIXTURE = new URL("../fixtures/mcp-capture/synthetic-salesforce-capture.json", import.meta.url);
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8"));
const QUERY = { path: "/services/data/v66.0/query", q: "SELECT Id, Name FROM Account WHERE Name LIKE 'Fictional%'" };

function doc(entries, extra = {}) {
  return {
    format_version: "mcp-capture/1",
    capture: { created_at: "2026-11-01T09:00:00Z", source_system: "m365", connector: "synthetic", ...extra },
    entries,
  };
}
const entry = (n, result = { ok: true }) => ({ tool: "read_resource", args: { n }, result, captured_at: "2026-11-01T09:00:00Z" });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test("synthetic fixture validates and replays results and errors", async () => {
  assert.equal(validate("mcpCapture", fixture()).valid, true);
  const c = loadCapture(fixture());
  assert.equal(c.capture.source_system, "salesforce");
  assert.deepEqual((await c.listTools()).tools, [{ name: "dispatch_readonly" }]);
  const r = await c.callTool("dispatch_readonly", { q: QUERY.q, path: QUERY.path });
  assert.equal(r.structuredContent.records[0].Name, "Fictional Freight Co");
  const cause = await c.callTool("dispatch_readonly", { path: QUERY.path, q: "SELECT Id FROM NoSuchObject__c" }).catch((e) => e);
  const mapped = mapMcpError(cause);
  assert.deepEqual([mapped.code, mapped.details.reason, mapped.retryable], ["ADAPTER_UNAVAILABLE", "INVALID_TYPE", false]);
});

test("loadCapture reads from a file path and reports unreadable or non-JSON files", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-capture-"));
  try {
    const ok = join(dir, "c.json");
    writeFileSync(ok, JSON.stringify(doc([entry(1)])));
    assert.equal(loadCapture(ok).entries.length, 1);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    assert.equal(code(() => loadCapture(bad)), "CAPTURE_UNREADABLE");
    assert.equal(code(() => loadCapture(join(dir, "missing.json"))), "CAPTURE_UNREADABLE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("schema rejects malformed captures", () => {
  const good = doc([entry(1)]);
  const mutations = {
    version: (d) => { d.format_version = "mcp-capture/2"; },
    missingCapture: (d) => { delete d.capture; },
    badSource: (d) => { d.capture.source_system = "Sales Force!"; },
    badDate: (d) => { d.capture.created_at = "yesterday"; },
    extraField: (d) => { d.extra = 1; },
    noResultOrError: (d) => { delete d.entries[0].result; },
    both: (d) => { d.entries[0].error = { message: "x" }; },
    noTool: (d) => { delete d.entries[0].tool; },
    badArgs: (d) => { d.entries[0].args = []; },
    noCapturedAt: (d) => { delete d.entries[0].captured_at; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const d = JSON.parse(JSON.stringify(good));
    mutate(d);
    assert.equal(validate("mcpCapture", d).valid, false, name);
    assert.equal(code(() => loadCapture(d)), "CAPTURE_INVALID", name);
  }
  assert.equal(code(() => loadCapture(null)), "CAPTURE_INVALID");
  assert.equal(validate("mcpCapture", doc([], { note: "optional note" })).valid, true);
});

test("limits are enforced by the loader: entries, entry bytes, file bytes; defaults documented", () => {
  assert.deepEqual({ ...CAPTURE_LIMITS }, { maxEntries: 1000, maxEntryBytes: 2 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024 });
  const tooMany = doc(Array.from({ length: CAPTURE_LIMITS.maxEntries + 1 }, (_, i) => entry(i)));
  assert.equal(code(() => loadCapture(tooMany)), "CAPTURE_TOO_LARGE");
  assert.equal(loadCapture(doc(Array.from({ length: CAPTURE_LIMITS.maxEntries }, (_, i) => entry(i)))).entries.length, 1000);

  const big = doc([entry(1, { blob: "x".repeat(CAPTURE_LIMITS.maxEntryBytes) })]);
  assert.equal(code(() => loadCapture(big)), "CAPTURE_TOO_LARGE");

  const small = { limits: { maxEntryBytes: 100, maxFileBytes: 400, maxEntries: 2 } };
  assert.equal(code(() => loadCapture(doc([entry(1, { blob: "x".repeat(200) })]), small)), "CAPTURE_TOO_LARGE");
  assert.equal(code(() => loadCapture(doc([entry(1), entry(2), entry(3)]), small)), "CAPTURE_TOO_LARGE");
  assert.equal(code(() => loadCapture(doc([entry(1), entry(2)], { note: "y".repeat(500) }), small)), "CAPTURE_TOO_LARGE");
  // limits may only tighten
  assert.equal(code(() => loadCapture(big, { limits: { maxEntryBytes: 1e12 } })), "CAPTURE_TOO_LARGE");
});

test("file size limit is checked before parsing a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-capture-"));
  try {
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify(doc([entry(1)])));
    assert.equal(code(() => loadCapture(p, { limits: { maxFileBytes: 50 } })), "CAPTURE_TOO_LARGE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("redaction replaces keys at any depth, wildcard paths, and JSON inside text blocks; args untouched", async () => {
  const payload = { records: [{ Id: "1", Email: "a@fictional.example", Owner: { Email: "b@fictional.example" } }], Phone: "000" };
  const d = doc([{
    tool: "t", args: { Email: "lookup@fictional.example" },
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload },
    captured_at: "2026-11-01T09:00:00Z",
  }, {
    tool: "t", args: { n: 2 }, error: { body: { Email: "e@fictional.example", keep: 1 } }, captured_at: "2026-11-01T09:00:00Z",
  }]);
  const c = loadCapture(d, { redact: ["Email", "structuredContent.Phone"] });
  const r = await c.callTool("t", { Email: "lookup@fictional.example" });
  assert.equal(r.structuredContent.records[0].Email, REDACTION_MARKER);
  assert.equal(r.structuredContent.records[0].Owner.Email, REDACTION_MARKER);
  assert.equal(r.structuredContent.Phone, REDACTION_MARKER);
  assert.equal(r.structuredContent.records[0].Id, "1");
  const text = JSON.parse(r.content[0].text);
  assert.equal(text.records[0].Email, REDACTION_MARKER);
  assert.equal(text.Phone, "000"); // dotted pattern is rooted; "Phone" at text root not named
  const err = await c.callTool("t", { n: 2 }).catch((e) => e);
  assert.equal(err.payload.body.Email, REDACTION_MARKER);
  assert.equal(err.payload.body.keep, 1);

  const wild = loadCapture(d, { redact: ["structuredContent.records.*.Id"] });
  assert.equal((await wild.callTool("t", { Email: "lookup@fictional.example" })).structuredContent.records[0].Id, REDACTION_MARKER);
  // source document is not mutated
  assert.equal(d.entries[0].result.structuredContent.records[0].Email, "a@fictional.example");
  // no redaction list: unchanged
  assert.equal((await loadCapture(d).callTool("t", { Email: "lookup@fictional.example" })).structuredContent.Phone, "000");
});
