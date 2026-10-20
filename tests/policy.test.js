import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../schemas/index.js";
import { resolveAccount } from "../skills/account-resolve/index.js";
import { retrieveEvidence } from "../skills/evidence-retrieve/index.js";
import { createFixtureEvidenceAdapter } from "../adapters/fixture-evidence-adapter.js";
import { DEFAULT_PERMITTED_CLASSIFICATIONS } from "../skills/evidence-retrieve/records.js";

const questions = [{ id: "FM-CTX-001", text: "What does the company do?" }];

test("default permitted classifications are public and internal only", () => {
  assert.deepEqual([...DEFAULT_PERMITTED_CLASSIFICATIONS], ["public", "internal"]);
  assert.ok(!DEFAULT_PERMITTED_CLASSIFICATIONS.includes("confidential"));
});

for (const code of ["CONFIRMATION_REQUIRED", "CLASSIFICATION_RESTRICTED", "UNSUPPORTED_SOURCE"]) {
  test(`error code ${code} validates against the shared error schema`, () => {
    const { valid, errors } = validate("error", { code, message: "x", retryable: false });
    assert.equal(valid, true, JSON.stringify(errors));
  });
}

test("account.resolve never retries a malformed adapter payload", async () => {
  let calls = 0;
  const adapter = {
    name: "counting-account-adapter",
    async searchAccounts() {
      calls += 1;
      return { ok: true, accounts: [{ account_id: "x", name: "" }] };
    },
  };
  const result = await resolveAccount({ account_reference: "Northstar" }, { adapter });
  assert.equal(calls, 1, "the skill must not retry");
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].retryable, false);
});

test("account.resolve never retries an unavailable adapter", async () => {
  let calls = 0;
  const adapter = {
    name: "unavailable-account-adapter",
    async searchAccounts() {
      calls += 1;
      return { ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "timeout", retryable: true } };
    },
  };
  const result = await resolveAccount({ account_reference: "Northstar" }, { adapter });
  assert.equal(calls, 1, "retryable is a caller signal, not a skill behavior");
  assert.equal(result.errors[0].retryable, true);
});

test("evidence.retrieve never retries across mixed source failure modes", async () => {
  const calls = { crm: 0, public_source: 0 };
  const adapter = {
    name: "counting-evidence-adapter",
    supportedSources: ["crm", "public_source"],
    async retrieve(request) {
      calls[request.source_type] += 1;
      if (request.source_type === "crm") {
        return { ok: false, error: { code: "ADAPTER_MALFORMED_RESPONSE", message: "bad", retryable: false } };
      }
      return { ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "timeout", retryable: true } };
    },
  };
  await retrieveEvidence(
    { account_id: "sf_clear_001", questions, requested_sources: ["crm", "public_source"] },
    { adapter },
  );
  assert.deepEqual(calls, { crm: 1, public_source: 1 });
});

test("every non-transport error surfaced by evidence.retrieve is non-retryable", async () => {
  const cases = [
    [{ mode: "malformed_envelope" }, "ADAPTER_MALFORMED_RESPONSE"],
    [{ mode: "unauthorized" }, "ADAPTER_UNAUTHORIZED"],
  ];
  for (const [source, expectedCode] of cases) {
    const adapter = createFixtureEvidenceAdapter({ sources: { sources: { crm: source } } });
    const result = await retrieveEvidence(
      { account_id: "sf_clear_001", questions, requested_sources: ["crm"] },
      { adapter },
    );
    assert.equal(result.errors[0].code, expectedCode);
    assert.equal(result.errors[0].retryable, false, expectedCode);
  }
});

test("a fuzzy account match never yields a resolved account payload", async () => {
  const adapter = {
    name: "single-fuzzy",
    async searchAccounts() {
      return { ok: true, accounts: [{ account_id: "crm_1", name: "Northstar Logistics Group" }] };
    },
  };
  const result = await resolveAccount({ account_reference: "Northstar" }, { adapter });
  assert.equal(result.status, "blocked");
  assert.equal(result.data.outcome, "confirmation_required");
  assert.equal(result.data.account, undefined);
  assert.equal(result.data.match, undefined);
});
