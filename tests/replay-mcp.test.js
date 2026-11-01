import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareFirstMeeting } from "../workflows/prepare-first-meeting/index.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { validate } from "../schemas/index.js";
import { EVIDENCE_SOURCE_IDS } from "../adapters/evidence-adapter.js";

const ACCOUNT_ID = "sf_replay_northstar";
const QUESTION = { id: "FM-CTX-001", text: "What does the company do?" };
const SOURCE_RECORD = {
  recordId: "src_replay_984",
  accountId: ACCOUNT_ID,
  type: "company_site",
  title: "Company overview",
  body: "Northstar Logistics provides freight brokerage services across the central United States.",
  uri: "https://northstar.example/about",
  publishedAt: "2026-09-30T13:00:00Z",
  occurredAt: null,
  retrievedAt: "2026-10-20T14:30:00Z",
  classification: "public",
  questionIds: ["FM-CTX-001"],
  attributes: { tenant: "replay-tenant", revision: 4 },
};
const CLAIMS = {
  "src_replay_984": [{
    claim: "Northstar Logistics provides freight brokerage services.",
    excerpt: "Northstar Logistics provides freight brokerage services",
    completeness: "complete",
  }],
};

/** In-memory transport envelope: deliberately shaped like tool protocol data. */
export class MemoryMcpReplayClient {
  constructor({ tools, responses }) {
    this.tools = tools;
    this.responses = responses;
    this.calls = [];
  }
  async listTools() { return { tools: this.tools.map(({ name, description }) => ({ name, description })) }; }
  async callTool(name, args) {
    this.calls.push({ name, args });
    const handler = this.responses[name];
    if (typeof handler !== "function") throw Object.assign(new Error("Tool unavailable"), { code: "UNAVAILABLE" });
    return handler(args);
  }
}

const result = (structuredContent) => ({
  content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  structuredContent,
});
const error = (code) => Object.assign(new Error("replay tool failed"), { code });

export class ReplayMcpAccountAdapter {
  constructor(client) { this.client = client; this.name = "replay-mcp-account"; }
  async searchAccounts(query) {
    try {
      const { tools } = await this.client.listTools();
      if (!tools.some((tool) => tool.name === "search_accounts")) return this.failure("ADAPTER_MALFORMED_RESPONSE", false);
      const response = await this.client.callTool("search_accounts", { query });
      const payload = response?.structuredContent;
      if (!payload || !Array.isArray(payload.matches)) return this.failure("ADAPTER_MALFORMED_RESPONSE", false);
      return { ok: true, accounts: payload.matches.map((item) => ({
        account_id: item.id, name: item.displayName, ...(item.domain ? { domain: item.domain } : {}),
      })) };
    } catch (cause) {
      return this.failure(cause.code === "UNAUTHORIZED" ? "ADAPTER_UNAUTHORIZED" : "ADAPTER_UNAVAILABLE", cause.code !== "UNAUTHORIZED");
    }
  }
  failure(code, retryable) { return { ok: false, error: { code, message: "Replay account tool failed.", retryable } }; }
}

export class ReplayMcpEvidenceAdapter {
  constructor(client) { this.client = client; this.name = "replay-mcp-evidence"; this.supportedSources = [...EVIDENCE_SOURCE_IDS]; }
  async retrieve(request) {
    try {
      const { tools } = await this.client.listTools();
      if (!tools.some((tool) => tool.name === "retrieve_evidence")) return this.failure("ADAPTER_MALFORMED_RESPONSE", false);
      const response = await this.client.callTool("retrieve_evidence", {
        accountId: request.account_id, source: request.source_type,
        questionIds: request.questions.map(({ id }) => id), cursor: null,
      });
      const payload = response?.structuredContent;
      if (!payload || !Array.isArray(payload.items)) return this.failure("ADAPTER_MALFORMED_RESPONSE", false);
      return { ok: true, records: payload.items.map((item) => ({
        record_id: item.recordId,
        account_id: item.accountId,
        source_type: item.type,
        title: item.title,
        content: item.body,
        source_uri: item.uri ?? null,
        ...(item.publishedAt !== undefined ? { published_at: item.publishedAt } : {}),
        ...(item.occurredAt !== undefined ? { occurred_at: item.occurredAt } : {}),
        retrieved_at: item.retrievedAt,
        access_classification: item.classification,
        question_ids: item.questionIds,
        metadata: { ...item.attributes, provider: "mcp-replay" },
      })) };
    } catch (cause) {
      const code = cause.code === "UNAUTHORIZED" ? "ADAPTER_UNAUTHORIZED" : "ADAPTER_UNAVAILABLE";
      return this.failure(code, code === "ADAPTER_UNAVAILABLE");
    }
  }
  failure(code, retryable) { return { ok: false, error: { code, message: "Replay evidence tool failed.", retryable } }; }
}

export class ReplayMcpClaimExtractor {
  constructor(client) { this.client = client; this.name = "replay-mcp-claim-extractor"; }
  async extract(record) {
    try {
      const response = await this.client.callTool("extract_claim_candidates", { sourceRecordId: record.record_id, content: record.content });
      const candidates = response?.structuredContent?.candidates;
      return Array.isArray(candidates) ? { ok: true, candidates } : { ok: true, candidates: "malformed" };
    } catch {
      return { ok: false, error: { code: "EXTRACTOR_UNAVAILABLE", message: "Replay extractor unavailable.", retryable: true } };
    }
  }
}

function client({ matches = [{ id: ACCOUNT_ID, displayName: "Northstar Logistics", domain: "northstar.example" }],
  items = [SOURCE_RECORD], accountPayload, evidencePayload, accountError, evidenceError, extractorCandidates = CLAIMS,
  extractorError } = {}) {
  const tools = ["search_accounts", "retrieve_evidence", "extract_claim_candidates"].map((name) => ({ name }));
  return new MemoryMcpReplayClient({ tools, responses: {
    search_accounts: async () => { if (accountError) throw error(accountError); return result(accountPayload ?? { matches }); },
    retrieve_evidence: async () => { if (evidenceError) throw error(evidenceError); return result(evidencePayload ?? { items }); },
    extract_claim_candidates: async ({ sourceRecordId }) => { if (extractorError) throw error(extractorError); return result({ candidates: extractorCandidates[sourceRecordId] ?? [] }); },
  } });
}
function input(overrides = {}) {
  return { account_reference: "Northstar Logistics", requested_sources: ["public_source"], context: { permitted_classifications: ["public", "internal"] }, ...overrides };
}
function deps(c, overrides = {}) {
  return { accountAdapter: new ReplayMcpAccountAdapter(c), evidenceAdapter: new ReplayMcpEvidenceAdapter(c), claimExtractor: new ReplayMcpClaimExtractor(c), traceId: "trace_replay_fixed", ...overrides };
}

test("replay client discovers and invokes tools with structured content", async () => {
  const c = client();
  assert.deepEqual((await c.listTools()).tools.map((tool) => tool.name), ["search_accounts", "retrieve_evidence", "extract_claim_candidates"]);
  assert.equal((await new ReplayMcpAccountAdapter(c).searchAccounts("Northstar")).accounts[0].account_id, ACCOUNT_ID);
  assert.equal(c.calls[0].name, "search_accounts");
});

test("account adapter maps candidates, preserves IDs, and maps empty, denied, malformed, and unavailable results", async () => {
  const multi = await new ReplayMcpAccountAdapter(client({ matches: [{ id: "a1", displayName: "Northstar" }, { id: "a2", displayName: "Northstar Freight" }] })).searchAccounts("Northstar");
  assert.deepEqual(multi.accounts.map((account) => account.account_id), ["a1", "a2"]);
  assert.deepEqual((await new ReplayMcpAccountAdapter(client({ matches: [] })).searchAccounts("missing")).accounts, []);
  assert.equal((await new ReplayMcpAccountAdapter(client({ accountError: "UNAUTHORIZED" })).searchAccounts("x")).error.code, "ADAPTER_UNAUTHORIZED");
  assert.equal((await new ReplayMcpAccountAdapter(client({ accountPayload: { matches: {} } })).searchAccounts("x")).error.code, "ADAPTER_MALFORMED_RESPONSE");
  assert.equal((await new ReplayMcpAccountAdapter(client({ accountError: "UNAVAILABLE" })).searchAccounts("x")).error.code, "ADAPTER_UNAVAILABLE");
});

test("evidence adapter maps provenance, classification, source metadata, dates, and question IDs", async () => {
  const c = client();
  const response = await new ReplayMcpEvidenceAdapter(c).retrieve({ account_id: ACCOUNT_ID, source_type: "public_source", questions: [QUESTION], context: {} });
  const record = response.records[0];
  assert.equal(record.record_id, SOURCE_RECORD.recordId);
  assert.equal(record.account_id, ACCOUNT_ID);
  assert.equal(record.source_uri, SOURCE_RECORD.uri);
  assert.equal(record.published_at, SOURCE_RECORD.publishedAt);
  assert.equal(record.occurred_at, null);
  assert.equal(record.retrieved_at, SOURCE_RECORD.retrievedAt);
  assert.equal(record.access_classification, "public");
  assert.deepEqual(record.question_ids, ["FM-CTX-001"]);
  assert.equal(record.metadata.tenant, "replay-tenant");
  assert.deepEqual(c.calls[0].args, { accountId: ACCOUNT_ID, source: "public_source", questionIds: [QUESTION.id], cursor: null });
});

test("evidence adapter maps empty, malformed, unauthorized, and unavailable tool responses", async () => {
  const retrieve = (c) => new ReplayMcpEvidenceAdapter(c).retrieve({ account_id: ACCOUNT_ID, source_type: "public_source", questions: [QUESTION], context: {} });
  assert.deepEqual((await retrieve(client({ items: [] }))).records, []);
  assert.equal((await retrieve(client({ evidencePayload: { data: [] } }))).error.code, "ADAPTER_MALFORMED_RESPONSE");
  assert.equal((await retrieve(client({ evidenceError: "UNAUTHORIZED" }))).error.code, "ADAPTER_UNAUTHORIZED");
  assert.equal((await retrieve(client({ evidenceError: "UNAVAILABLE" }))).error.code, "ADAPTER_UNAVAILABLE");
});

test("replacement extractor is independent of fixture metadata; normalize retains policy and stable claims", async () => {
  const record = { record_id: SOURCE_RECORD.recordId, account_id: ACCOUNT_ID, source_type: SOURCE_RECORD.type, title: SOURCE_RECORD.title, content: SOURCE_RECORD.body, source_uri: SOURCE_RECORD.uri, published_at: SOURCE_RECORD.publishedAt, occurred_at: null, retrieved_at: SOURCE_RECORD.retrievedAt, access_classification: SOURCE_RECORD.classification, question_ids: SOURCE_RECORD.questionIds, metadata: { provider: "replay" } };
  const c = client();
  const first = await normalizeEvidence({ account_id: ACCOUNT_ID, records: [record] }, { extractor: new ReplayMcpClaimExtractor(c), now: () => new Date("2026-10-30T12:00:00Z") });
  const second = await normalizeEvidence({ account_id: ACCOUNT_ID, records: [record] }, { extractor: new ReplayMcpClaimExtractor(c), now: () => new Date("2026-10-30T12:00:00Z") });
  assert.equal(first.data.claims[0].claim_id, second.data.claims[0].claim_id);
  assert.equal(first.data.claims[0].access_classification, "public");
  assert.equal(first.data.claims[0].source_record_id, SOURCE_RECORD.recordId);
  assert.deepEqual((await normalizeEvidence({ account_id: ACCOUNT_ID, records: [record] }, { extractor: new ReplayMcpClaimExtractor(client({ extractorCandidates: { [SOURCE_RECORD.recordId]: [{ claim: "Northstar offers guaranteed profits.", excerpt: "Northstar Logistics provides freight brokerage services" }] } })) })).data.rejected_records.map((x) => x.reason), ["unsupported_claim"]);
  assert.equal((await normalizeEvidence({ account_id: ACCOUNT_ID, records: [record] }, { extractor: new ReplayMcpClaimExtractor(client({ extractorCandidates: { [SOURCE_RECORD.recordId]: [{ ...CLAIMS[SOURCE_RECORD.recordId][0], access_classification: "public" }] } })) })).data.claims.length, 1);
  const downgradeRecord = { ...record, access_classification: "internal" };
  const downgrade = await normalizeEvidence({ account_id: ACCOUNT_ID, records: [downgradeRecord] }, { extractor: new ReplayMcpClaimExtractor(client({ extractorCandidates: { [SOURCE_RECORD.recordId]: [{ ...CLAIMS[SOURCE_RECORD.recordId][0], access_classification: "public" }] } })) });
  assert.deepEqual(downgrade.data.rejected_records.map((entry) => entry.reason), ["classification_violation"]);
});

test("prepare-first-meeting runs end to end on replay adapters and creates cited Markdown", async () => {
  const c = client();
  const run = async () => prepareFirstMeeting(input(), deps(c));
  const workflow = await run();
  assert.equal(validate("workflowResult", workflow).valid, true);
  assert.equal(workflow.status, "success", JSON.stringify(workflow.errors));
  assert.deepEqual(workflow.steps.map((step) => step.step), ["account.resolve", "evidence.retrieve", "evidence.normalize", "gap.detect", "artifact.render"]);
  assert.match(workflow.artifact.markdown, /\[clm_[A-Za-z0-9_-]+\]/);
  assert.match(workflow.artifact.markdown, /Northstar Logistics provides freight brokerage services\./);
  const repeat = await prepareFirstMeeting(input(), deps(client(), { traceId: "trace_replay_fixed" }));
  assert.equal(workflow.artifact.markdown, repeat.artifact.markdown);
  assert.deepEqual(workflow.evidence_ids, repeat.evidence_ids);
});

test("workflow handles ambiguous account, zero evidence, partial source failure, and authorization denial", async () => {
  const ambiguous = await prepareFirstMeeting(input({ account_reference: "Northstar" }), deps(client({ matches: [{ id: "a1", displayName: "Northstar Logistics" }, { id: "a2", displayName: "Northstar Freight" }] })));
  assert.equal(ambiguous.status, "blocked");
  const empty = await prepareFirstMeeting(input(), deps(client({ items: [] })));
  assert.ok(["success", "partial"].includes(empty.status));
  assert.equal(empty.evidence_ids.length, 0);
  const partial = await prepareFirstMeeting(input({ requested_sources: ["crm", "public_source"] }), deps(client({ evidenceError: "UNAVAILABLE" })));
  assert.equal(partial.status, "failed"); // all requested sources fail/empty is represented by current retrieval contract
  const denied = await prepareFirstMeeting(input(), deps(client({ evidenceError: "UNAUTHORIZED" })));
  assert.equal(denied.status, "blocked");
  assert.ok(denied.errors.some((entry) => entry.code === "ADAPTER_UNAUTHORIZED"));
});

test("malformed responses and unsupported claims never trigger fixture fallback", async () => {
  const malformed = await prepareFirstMeeting(input(), deps(client({ evidencePayload: { wrong: true } })));
  assert.equal(malformed.status, "failed");
  assert.ok(malformed.errors.some((entry) => entry.code === "ADAPTER_MALFORMED_RESPONSE"));
  const c = client({ extractorCandidates: { [SOURCE_RECORD.recordId]: [{ claim: "Northstar Logistics has 40 offices.", excerpt: "Northstar Logistics provides freight brokerage services" }] } });
  const rejected = await prepareFirstMeeting(input(), deps(c));
  assert.equal(rejected.status, "partial");
  assert.ok(rejected.warnings.some((entry) => entry.code === "RECORDS_OR_CANDIDATES_REJECTED"));
  assert.equal(rejected.evidence_ids.length, 0);
  assert.equal(c.calls.some((call) => call.name === "search_accounts"), true);
  assert.equal(c.calls.some((call) => call.name === "retrieve_evidence"), true);
  assert.equal(c.calls.some((call) => call.name === "extract_claim_candidates"), true);
});

test("partial source failure retains successful source records and citations", async () => {
  const c = new MemoryMcpReplayClient({ tools: [{ name: "search_accounts" }, { name: "retrieve_evidence" }, { name: "extract_claim_candidates" }], responses: {
    search_accounts: async () => result({ matches: [{ id: ACCOUNT_ID, displayName: "Northstar Logistics" }] }),
    retrieve_evidence: async ({ source }) => source === "crm" ? (() => { throw error("UNAVAILABLE"); })() : result({ items: [SOURCE_RECORD] }),
    extract_claim_candidates: async ({ sourceRecordId }) => result({ candidates: CLAIMS[sourceRecordId] ?? [] }),
  } });
  const workflow = await prepareFirstMeeting(input({ requested_sources: ["crm", "public_source"] }), deps(c));
  assert.equal(workflow.status, "partial");
  assert.ok(workflow.evidence_ids.length > 0);
  assert.match(workflow.artifact.markdown, /\[clm_[A-Za-z0-9_-]+\]/);
});

test("replay claims retain conflicts and classification filtering", async () => {
  const second = { ...SOURCE_RECORD, recordId: "src_replay_985", body: "Northstar Logistics provides dedicated fleet services across the central United States." };
  const c = new MemoryMcpReplayClient({ tools: [{ name: "search_accounts" }, { name: "retrieve_evidence" }, { name: "extract_claim_candidates" }], responses: {
    search_accounts: async () => result({ matches: [{ id: ACCOUNT_ID, displayName: "Northstar Logistics" }] }),
    retrieve_evidence: async () => result({ items: [SOURCE_RECORD, second] }),
    extract_claim_candidates: async ({ sourceRecordId }) => result({ candidates: sourceRecordId === SOURCE_RECORD.recordId
      ? [{ claim: "Northstar Logistics provides freight brokerage services.", excerpt: "Northstar Logistics provides freight brokerage services", completeness: "complete", conflict_key: "business-model" }]
      : [{ claim: "Northstar Logistics provides dedicated fleet services.", excerpt: "Northstar Logistics provides dedicated fleet services", completeness: "complete", conflict_key: "business-model" }] }),
  } });
  const conflict = await prepareFirstMeeting(input(), deps(c));
  assert.ok(conflict.warnings.some((entry) => entry.code === "CONFLICTS_PRESENT"));
  assert.equal(conflict.evidence_ids.length, 2);
  assert.match(conflict.artifact.markdown, /conflict|Conflicting/i);

  const restrictedRecord = { ...SOURCE_RECORD, classification: "internal" };
  const filtered = await prepareFirstMeeting(input({ context: { permitted_classifications: ["public"] } }), deps(client({ items: [restrictedRecord] })));
  assert.equal(filtered.evidence_ids.length, 0);
  assert.ok(filtered.warnings.some((entry) => entry.code === "RECORDS_WITHHELD"));
});

test("replay source failure never falls back to fixture data; skill/workflow source has no fixture IO", async () => {
  const source = readFileSync(new URL("../workflows/prepare-first-meeting/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fixtures\//i);
  assert.doesNotMatch(source, /readFileSync|readFile\(/);
  const workflow = await prepareFirstMeeting(input(), deps(client({ evidenceError: "UNAVAILABLE" })));
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.evidence_ids.length, 0);
  assert.equal(workflow.artifact, null);
});
