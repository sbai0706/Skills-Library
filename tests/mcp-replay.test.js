import test from "node:test";
import assert from "node:assert/strict";
import {
  ReplayMcpClient, McpClientError, canonicalize, mcpClientProblems, assertMcpToolClient,
  listToolsProblems, mapMcpError, unwrapToolResult,
} from "../adapters/mcp/index.js";
import { ADAPTER_ERROR_CODES } from "../adapters/evidence-adapter.js";

const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });

function replay() {
  return new ReplayMcpClient({ entries: [
    { tool: "dispatch_readonly", args: { path: "/q", params: { a: 1, b: [1, 2] } }, result: ok({ n: 1 }) },
    { tool: "dispatch_readonly", args: { path: "/q", params: { a: 1, b: [1, 2] } }, result: ok({ n: 2 }) },
    { tool: "dispatch_readonly", args: { path: "/bad" }, error: { error_code: "API_ERROR", status_code: 404, body: "[]" } },
  ] });
}

test("interface validation accepts clients and rejects incomplete ones", async () => {
  assert.deepEqual(mcpClientProblems(replay()), []);
  assert.equal(assertMcpToolClient(replay()) instanceof ReplayMcpClient, true);
  assert.deepEqual(mcpClientProblems({ listTools() {} }), ["callTool is not a function"]);
  assert.deepEqual(mcpClientProblems(null), ["client is not an object"]);
  assert.throws(() => assertMcpToolClient({}), /listTools.*callTool/);
  assert.deepEqual(listToolsProblems(await replay().listTools()), []);
  assert.equal(listToolsProblems({ tools: [{}] }).length, 1);
  assert.equal(listToolsProblems(undefined).length, 1);
});

test("canonicalize sorts keys recursively but keeps array order", () => {
  assert.equal(canonicalize({ b: 1, a: { d: 1, c: undefined, e: 2 } }), canonicalize({ a: { e: 2, d: 1 }, b: 1 }));
  assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
});

test("replay matches by tool and args regardless of key order, and consumes repeats in order", async () => {
  const c = replay();
  assert.deepEqual((await c.callTool("dispatch_readonly", { params: { b: [1, 2], a: 1 }, path: "/q" })).structuredContent, { n: 1 });
  assert.deepEqual((await c.callTool("dispatch_readonly", { path: "/q", params: { a: 1, b: [1, 2] } })).structuredContent, { n: 2 });
  assert.equal(c.calls.length, 2);
  assert.deepEqual(c.unconsumed(), [{ index: 2, tool: "dispatch_readonly" }]);
});

test("replay is strict by default: exhausted entries throw replay_exhausted; reuseLast keeps serving the last", async () => {
  const entries = [{ tool: "t", args: { a: 1 }, result: ok({ n: 1 }) }];
  const strict = new ReplayMcpClient({ entries });
  await strict.callTool("t", { a: 1 });
  const cause = await strict.callTool("t", { a: 1 }).catch((e) => e);
  assert.deepEqual([cause.code, cause.reason], ["REPLAY_UNMATCHED", "replay_exhausted"]);
  const mapped = mapMcpError(cause);
  assert.deepEqual([mapped.code, mapped.retryable, mapped.details.reason], ["ADAPTER_UNAVAILABLE", false, "replay_exhausted"]);
  const reuse = new ReplayMcpClient({ entries, reuseLast: true });
  await reuse.callTool("t", { a: 1 });
  assert.deepEqual((await reuse.callTool("t", { a: 1 })).structuredContent, { n: 1 });
  assert.deepEqual(new ReplayMcpClient({ entries }).unconsumed(), [{ index: 0, tool: "t" }]);
});

test("results are copies: mutating one does not affect later replay", async () => {
  const c = new ReplayMcpClient({ entries: [{ tool: "t", args: {}, result: ok({ n: 1 }) }], reuseLast: true });
  (await c.callTool("t", {})).structuredContent.n = 99;
  assert.equal((await c.callTool("t", {})).structuredContent.n, 1);
});

test("unmatched args and unknown tools raise clear errors mapped to ADAPTER_UNAVAILABLE", async () => {
  const c = replay();
  await assert.rejects(c.callTool("dispatch_readonly", { path: "/other" }), (e) => e instanceof McpClientError && e.code === "REPLAY_UNMATCHED" && /No captured response/.test(e.message));
  await assert.rejects(c.callTool("dispatch", {}), (e) => e.code === "TOOL_NOT_FOUND");
  const unmatched = mapMcpError(await c.callTool("dispatch_readonly", { path: "/other" }).catch((e) => e));
  assert.deepEqual([unmatched.code, unmatched.retryable, unmatched.details.reason], ["ADAPTER_UNAVAILABLE", false, "replay_unmatched"]);
  assert.equal(mapMcpError(await c.callTool("nope", {}).catch((e) => e)).details.reason, "tool_not_found");
});

test("captured connector errors reject and map by status", async () => {
  const c = replay();
  const cause = await c.callTool("dispatch_readonly", { path: "/bad" }).catch((e) => e);
  assert.equal(cause.code, "TOOL_ERROR");
  assert.deepEqual(cause.payload.status_code, 404);
  const mapped = mapMcpError(cause);
  assert.deepEqual([mapped.code, mapped.retryable], ["ADAPTER_UNAVAILABLE", false]);
});

test("error mapping table: statuses, auth codes, legacy codes, unknown failures; only existing codes", () => {
  const shape = (status_code, errorCode) => ({ payload: { error_code: "API_ERROR", status_code, body: JSON.stringify([{ errorCode }]) } });
  const rows = [
    [shape(400, "INVALID_TYPE"), "ADAPTER_UNAVAILABLE", false],
    [shape(401, "INVALID_SESSION_ID"), "ADAPTER_UNAUTHORIZED", false],
    [shape(403, "FORBIDDEN"), "ADAPTER_UNAUTHORIZED", false],
    [shape(404, "NOT_FOUND"), "ADAPTER_UNAVAILABLE", false],
    [shape(429, "REQUEST_LIMIT_EXCEEDED"), "ADAPTER_UNAVAILABLE", true],
    [shape(503, "SERVER_UNAVAILABLE"), "ADAPTER_UNAVAILABLE", true],
    [{ payload: { error_code: "API_ERROR", status_code: 400, body: [{ errorCode: "INSUFFICIENT_ACCESS" }] } }, "ADAPTER_UNAUTHORIZED", false],
    [shape(401, "INVALID_AUTH_HEADER"), "ADAPTER_UNAUTHORIZED", true],
    [{ payload: { error_code: "API_ERROR", status_code: 401, body: [{ errorCode: "X", message: "token has INVALID_SCOPES" }] } }, "ADAPTER_UNAUTHORIZED", true],
    [shape(403, "INVALID_AUTH_HEADER"), "ADAPTER_UNAUTHORIZED", false],
    [{ code: "UNAUTHORIZED" }, "ADAPTER_UNAUTHORIZED", false],
    [{ code: "UNAVAILABLE" }, "ADAPTER_UNAVAILABLE", true],
    [{ error_code: "API_ERROR", status_code: 500 }, "ADAPTER_UNAVAILABLE", true],
    [new Error("socket hang up"), "ADAPTER_UNAVAILABLE", true],
    [undefined, "ADAPTER_UNAVAILABLE", true],
  ];
  for (const [cause, code, retryable] of rows) {
    const mapped = mapMcpError(cause);
    assert.deepEqual([mapped.code, mapped.retryable], [code, retryable], JSON.stringify(cause));
    assert.ok(ADAPTER_ERROR_CODES.includes(mapped.code));
  }
  assert.equal(mapMcpError(shape(400, "INVALID_TYPE")).details.reason, "INVALID_TYPE");
});

test("unwrapToolResult returns payloads and maps isError, embedded errors, and malformed results", () => {
  assert.deepEqual(unwrapToolResult(ok({ a: 1 })), { ok: true, payload: { a: 1 } });
  assert.deepEqual(unwrapToolResult({ content: [{ type: "text", text: "{\"a\":2}" }] }), { ok: true, payload: { a: 2 } });
  assert.deepEqual(unwrapToolResult({ records: [] }), { ok: true, payload: { records: [] } });

  const isError = unwrapToolResult({ isError: true, content: [{ type: "text", text: "boom" }] });
  assert.deepEqual([isError.ok, isError.error.code, isError.error.retryable, isError.error.details.reason], [false, "ADAPTER_UNAVAILABLE", false, "tool_is_error"]);
  const isAuth = unwrapToolResult({ isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: "API_ERROR", status_code: 401, body: "[]" }) }] });
  assert.equal(isAuth.error.code, "ADAPTER_UNAUTHORIZED");

  const direct = unwrapToolResult({ error_code: "API_ERROR", status_code: 400, body: "[{\"errorCode\":\"INVALID_TYPE\"}]" });
  assert.deepEqual([direct.ok, direct.error.code, direct.error.details.reason], [false, "ADAPTER_UNAVAILABLE", "INVALID_TYPE"]);
  const embedded = unwrapToolResult({ content: [{ type: "text", text: JSON.stringify({ error_code: "API_ERROR", status_code: 403, body: "[]" }) }] });
  assert.equal(embedded.error.code, "ADAPTER_UNAUTHORIZED");

  for (const bad of [null, "text", [], { content: "x" }, { content: [{ type: "text", text: "not json" }] }, { content: [{ type: "image" }] }, { structuredContent: "s" }]) {
    const r = unwrapToolResult(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error.code, "ADAPTER_MALFORMED_RESPONSE");
    assert.equal(r.error.retryable, false);
  }
});

test("2xx connector envelope is a success, not an error", () => {
  const body = { totalSize: 1, done: true, records: [{ Id: "001FICTIONAL" }] };
  const env = { status_code: 200, body, url: "https://fictional.example/q" };
  const meta = { status_code: 200, url: "https://fictional.example/q" };
  assert.deepEqual(unwrapToolResult(env), { ok: true, payload: body, meta });
  assert.deepEqual(unwrapToolResult({ content: [{ type: "text", text: JSON.stringify(env) }] }), { ok: true, payload: body, meta });
  assert.deepEqual(unwrapToolResult({ structuredContent: env }), { ok: true, payload: body, meta });
  assert.deepEqual(unwrapToolResult({ structuredContent: { ...env, body: JSON.stringify(body) } }).payload, body);
  assert.deepEqual(unwrapToolResult({ status_code: 200, body, error_code: null, url: "u" }), { ok: true, payload: body, meta: { status_code: 200, url: "u" } });
  assert.deepEqual(unwrapToolResult({ status_code: 204, url: "u" }), { ok: true, payload: null, meta: { status_code: 204, url: "u" } });
  assert.deepEqual(unwrapToolResult({ error_code: "", status_code: 200, body }).payload, body);
});

test("connector errors are detected inside structuredContent without isError; plain-text isError falls back to status", () => {
  const err = { error_code: "API_ERROR", status_code: 403, body: "[]" };
  assert.equal(unwrapToolResult({ structuredContent: err }).error.code, "ADAPTER_UNAUTHORIZED");
  assert.equal(unwrapToolResult({ structuredContent: { error_code: "X", status_code: 400 } }).ok, false);
  const plain = unwrapToolResult({ isError: true, content: [{ type: "text", text: "API call failed with status 401" }] });
  assert.deepEqual([plain.error.code, plain.error.details.status_code], ["ADAPTER_UNAUTHORIZED", 401]);
  const scopes = unwrapToolResult({ isError: true, content: [{ type: "text", text: "401 INVALID_SCOPES" }] });
  assert.deepEqual([scopes.error.code, scopes.error.retryable], ["ADAPTER_UNAUTHORIZED", true]);
  assert.equal(unwrapToolResult({ isError: true, content: [{ type: "text", text: "API call failed with status 503" }] }).error.retryable, true);
});
