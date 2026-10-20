import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../schemas/index.js";
import { createFixtureAccountAdapter, loadFixture } from "../adapters/fixture-account-adapter.js";
import { resolveAccount } from "../skills/account-resolve/index.js";

const fixtures = ["clear-account", "ambiguous-account", "missing-account"].map(loadFixture);

async function run(fixtureName, accountReference) {
  const adapter = createFixtureAccountAdapter({ fixture: fixtureName });
  return resolveAccount({ account_reference: accountReference }, { adapter });
}

function assertEnvelope(result) {
  const { valid, errors } = validate("skillResult", result);
  assert.equal(valid, true, `envelope invalid: ${JSON.stringify(errors)}`);
  assert.match(result.trace_id, /^trace_/);
  assert.ok(!Number.isNaN(Date.parse(result.started_at)));
  assert.ok(!Number.isNaN(Date.parse(result.finished_at)));
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
  assert.deepEqual(result.evidence_ids, []);
}

test("fixtures declare the three intended outcomes", () => {
  const outcomes = fixtures.map((f) => f.expected.expected.outcome).sort();
  assert.deepEqual(outcomes, ["ambiguous", "not_found", "resolved"]);
});

for (const fixture of fixtures) {
  test(`${fixture.name}: primary case matches expected.json`, async () => {
    const result = await run(fixture.name, fixture.expected.input.account_reference);
    assertEnvelope(result);
    const expected = fixture.expected.expected;
    assert.equal(result.status, expected.status);
    assert.equal(result.data.outcome, expected.outcome);

    if (expected.outcome === "resolved") {
      assert.equal(result.data.account.account_id, expected.account_id);
      assert.equal(result.data.account.name, expected.name);
      assert.equal(result.data.match.method, expected.match_method);
      for (const excluded of fixture.expected.must_not_match ?? []) {
        assert.notEqual(result.data.account.account_id, excluded);
      }
      if (expected.match_method === "exact_name" || expected.match_method === "domain") {
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.warnings, []);
      }
    }

    if (expected.outcome === "ambiguous") {
      assert.equal(result.status, "blocked");
      assert.equal(result.data.reason, "ambiguous_account");
      assert.equal(result.errors[0].code, "AMBIGUOUS_ACCOUNT");
      const ids = result.data.candidates.map((c) => c.account_id).sort();
      assert.deepEqual(ids, [...expected.candidate_account_ids].sort());
      assert.ok(result.data.candidates.length >= 2);
      for (const candidate of result.data.candidates) {
        assert.equal(typeof candidate.score, "number");
        assert.ok(candidate.score >= 0.6, "candidate is above the credibility threshold");
        assert.ok(candidate.name.length > 0);
      }
      assert.equal(result.data.never_auto_select, undefined);
    }

    if (expected.outcome === "not_found") {
      assert.equal(result.status, "blocked");
      assert.equal(result.data.reason, "account_not_found");
      assert.equal(result.errors[0].code, "ACCOUNT_NOT_FOUND");
      assert.equal(result.data.account, undefined, "no account may be invented");
    }
  });

  for (const variant of fixture.expected.variants ?? []) {
    test(`${fixture.name}: variant "${variant.account_reference}" — ${variant.why}`, async () => {
      const result = await run(fixture.name, variant.account_reference);
      assertEnvelope(result);
      assert.equal(result.status, variant.expected.status);
      assert.equal(result.data.outcome, variant.expected.outcome);
      if (variant.expected.account_id) {
        assert.equal(result.data.account.account_id, variant.expected.account_id);
      }
      if (variant.expected.match_method) {
        assert.equal(result.data.match.method, variant.expected.match_method);
      }
      if (variant.expected.candidate_account_ids) {
        assert.deepEqual(
          result.data.candidates.map((c) => c.account_id).sort(),
          [...variant.expected.candidate_account_ids].sort(),
        );
      }
    });
  }
}

test("ambiguous result never silently selects the highest-scoring candidate", async () => {
  const result = await run("ambiguous-account", "Meridian Health");
  assert.equal(result.status, "blocked");
  assert.equal(result.data.outcome, "ambiguous");
  assert.equal(result.data.account, undefined);
  assert.equal(result.errors[0].retryable, false);
  assert.match(result.data.clarification_needed, /Which account is intended/);
});

test("malformed adapter account record produces ADAPTER_MALFORMED_RESPONSE", async () => {
  const adapter = createFixtureAccountAdapter({ mode: "malformed" });
  const result = await resolveAccount({ account_reference: "Northstar Logistics" }, { adapter });
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "ADAPTER_MALFORMED_RESPONSE");
  assert.equal(result.errors[0].retryable, false);
});

test("malformed adapter envelope produces ADAPTER_MALFORMED_RESPONSE", async () => {
  const adapter = createFixtureAccountAdapter({ mode: "malformed_envelope" });
  const result = await resolveAccount({ account_reference: "Northstar Logistics" }, { adapter });
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "ADAPTER_MALFORMED_RESPONSE");
});

test("adapter authorization failure produces ADAPTER_UNAUTHORIZED without account data", async () => {
  const adapter = createFixtureAccountAdapter({ mode: "unauthorized" });
  const result = await resolveAccount({ account_reference: "Northstar Logistics" }, { adapter });
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "ADAPTER_UNAUTHORIZED");
  assert.equal(result.errors[0].retryable, false);
});

test("adapter availability failure is reported as retryable", async () => {
  const adapter = createFixtureAccountAdapter({ mode: "unavailable" });
  const result = await resolveAccount({ account_reference: "Northstar Logistics" }, { adapter });
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.errors[0].code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.errors[0].retryable, true);
});

test("an adapter that throws is normalized to ADAPTER_UNAVAILABLE", async () => {
  const adapter = createFixtureAccountAdapter({ mode: "throw" });
  const result = await resolveAccount({ account_reference: "Northstar Logistics" }, { adapter });
  assertEnvelope(result);
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].code, "ADAPTER_UNAVAILABLE");
  assert.equal(result.data, null);
});

test("blank or non-string account_reference is rejected before the adapter runs", async () => {
  let called = false;
  const adapter = {
    name: "spy",
    async searchAccounts() {
      called = true;
      return { ok: true, accounts: [] };
    },
  };
  for (const input of [{ account_reference: "   " }, { account_reference: 42 }, {}]) {
    const result = await resolveAccount(input, { adapter });
    assertEnvelope(result);
    assert.equal(result.status, "failed");
    assert.equal(result.errors[0].code, "INVALID_INPUT");
    assert.equal(result.data, null);
  }
  assert.equal(called, false);
});

test("the skill depends only on the adapter interface (alternate adapter works unchanged)", async () => {
  const adapter = {
    name: "inline-readonly-adapter",
    async searchAccounts(query) {
      assert.equal(query, "Northwind Traders");
      return {
        ok: true,
        accounts: [{ account_id: "crm_42", name: "Northwind Traders", domain: "northwind.example" }],
      };
    },
  };
  const result = await resolveAccount({ account_reference: "Northwind Traders" }, { adapter });
  assertEnvelope(result);
  assert.equal(result.status, "success");
  assert.equal(result.data.account.account_id, "crm_42");
  assert.equal(result.data.account.domain, "northwind.example");
});
