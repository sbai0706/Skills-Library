import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareFirstMeeting } from "../workflows/prepare-first-meeting/index.js";
import { loadCapture } from "../adapters/mcp/index.js";
import {
  createSalesforceAccountAdapter, createSalesforceEvidenceAdapter, createSalesforceStructuredClaimExtractor,
} from "../adapters/salesforce/index.js";
import { buildAccountSearchSoql, buildAccountByIdSoql } from "../adapters/salesforce/soql.js";
import { validate } from "../schemas/index.js";
import { scenarios, NORTHWIND_ID } from "./helpers/salesforce-scenarios.js";
import { queryEntry, replay, sfError, sfOk } from "./helpers/salesforce-capture.js";

const NOW = () => new Date("2026-11-04T10:00:00Z");
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const capturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}/capture.json`, import.meta.url));

function depsFor(client) {
  return {
    accountAdapter: createSalesforceAccountAdapter({ client }),
    evidenceAdapter: createSalesforceEvidenceAdapter({ client, now: NOW }),
    claimExtractor: createSalesforceStructuredClaimExtractor(),
    now: NOW,
    traceId: "trace_salesforce_test",
  };
}
const input = (reference, extra = {}) => ({ account_reference: reference, requested_sources: ["crm"], ...extra });
const citations = (markdown) => [...markdown.matchAll(/`\[(clm_[A-Za-z0-9_-]+)\]`/g)].map((m) => m[1]);

test("committed capture fixtures match the synthetic scenario builders", () => {
  for (const [name, doc] of Object.entries(scenarios())) {
    assert.deepEqual(readJson(`../fixtures/${name}/capture.json`), doc, `${name}: run node tests/helpers/salesforce-scenarios.js`);
  }
});

test("prepareFirstMeeting end to end on replay: cited claims, deterministic, fully consumed", async () => {
  const run = async () => {
    const client = loadCapture(capturePath("salesforce-northwind"));
    const result = await prepareFirstMeeting(input("Northwind Traders"), depsFor(client));
    return { client, result };
  };
  const { client, result } = await run();
  const expected = readJson("../fixtures/salesforce-northwind/expected.json").expected;
  assert.ok(["success", "partial"].includes(result.status));
  assert.equal(result.status, expected.status);
  assert.deepEqual(validate("workflowResult", result), { valid: true, errors: [] });
  assert.equal(result.account.account_id, expected.account_id);
  assert.deepEqual(result.steps.map((s) => [s.step, s.status]), expected.steps);
  assert.equal(result.evidence_ids.length, expected.claim_count);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(client.unconsumed(), [], "every captured entry was used");

  const markdown = result.artifact.markdown;
  const cited = citations(markdown);
  assert.ok(cited.length > 0);
  assert.ok(cited.every((id) => result.evidence_ids.includes(id)), "every citation is a normalized claim");
  for (const fragment of expected.markdown_includes) assert.ok(markdown.includes(fragment), fragment);
  for (const name of expected.markdown_excludes) assert.ok(!markdown.includes(name), `brief must not contain ${name}`);
  assert.equal(result.artifact.classification, "internal");

  const second = await run();
  assert.deepEqual(second.result, result, "deterministic across two runs");
});

test("redacted capture (default error-message redaction, PII keys) still replays", async () => {
  const client = loadCapture(capturePath("salesforce-northwind"), { redact: ["Email", "Phone"] });
  const result = await prepareFirstMeeting(input("Northwind Traders"), depsFor(client));
  assert.equal(result.status, "success");
});

test("ambiguous accounts block before evidence retrieval", async () => {
  const client = loadCapture(capturePath("salesforce-ambiguous"));
  const result = await prepareFirstMeeting(input("Northwind"), depsFor(client));
  assert.equal(result.status, "blocked");
  assert.equal(result.account, null);
  assert.equal(result.account_candidates.length, 2);
  assert.deepEqual(result.steps.map((s) => s.step), ["account.resolve"]);
  assert.equal(result.steps[0].outcome, "ambiguous");
});

test("a single fuzzy candidate requires confirmation; the exact ID then resolves", async () => {
  const row = { Id: NORTHWIND_ID, Name: "Northwind Traders", Website: null, BillingCity: null, BillingState: null, BillingCountry: null, Owner: null };
  const client = replay([
    queryEntry(buildAccountSearchSoql("Northwind"), { result: sfOk("Account", [row]) }),
    queryEntry(buildAccountByIdSoql(NORTHWIND_ID), { result: sfOk("Account", [row]) }),
  ]);
  const deps = depsFor(client);
  const first = await prepareFirstMeeting(input("Northwind"), deps);
  assert.equal(first.status, "blocked");
  assert.equal(first.steps[0].outcome, "confirmation_required");
  assert.equal(first.account_candidates[0].account_id, `sf_${NORTHWIND_ID}`);
  const second = await prepareFirstMeeting(input(`sf_${NORTHWIND_ID}`), deps);
  assert.equal(second.steps[0].outcome, "resolved");
  assert.equal(second.account.account_id, `sf_${NORTHWIND_ID}`);
});

test("a capture missing the Phase 2 evidence calls fails with no fixture fallback", async () => {
  const doc = scenarios()["salesforce-northwind"];
  const client = replay(doc.entries.slice(0, 1));
  const result = await prepareFirstMeeting(input("Northwind Traders"), depsFor(client));
  assert.equal(result.status, "failed");
  assert.equal(result.artifact, null);
  assert.equal(result.evidence_ids.length, 0);
  assert.ok(result.errors.length > 0);
  assert.ok(!JSON.stringify(result).includes("fixture"));
});

test("a missing account search capture fails the workflow", async () => {
  const doc = scenarios()["salesforce-northwind"];
  const client = replay(doc.entries.slice(1));
  const result = await prepareFirstMeeting(input("Northwind Traders"), depsFor(client));
  assert.equal(result.status, "failed");
});

test("a recorded Salesforce permission error fails the crm source safely", async () => {
  const doc = scenarios()["salesforce-northwind"];
  const entries = structuredClone(doc.entries);
  const contact = entries.findIndex((e) => /FROM Contact/.test(e.args.queryParams?.q ?? ""));
  const { result: _drop, ...base } = entries[contact];
  entries[contact] = { ...base, error: sfError(400, "INVALID_FIELD", "No such column 'Title' on entity 'Contact'. SELECT secret") };
  const capture = loadCapture({ ...doc, entries });
  const result = await prepareFirstMeeting(input("Northwind Traders"), depsFor(capture));
  assert.equal(result.status, "blocked");
  assert.equal(result.artifact, null);
  assert.ok(result.errors.some((e) => e.code === "ADAPTER_UNAUTHORIZED"));
  assert.ok(!JSON.stringify(result).includes("SELECT"));
});
