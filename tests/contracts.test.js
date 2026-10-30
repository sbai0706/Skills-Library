import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const skills = [
  { dir: "../skills/account-resolve", name: "account.resolve" },
  { dir: "../skills/evidence-retrieve", name: "evidence.retrieve" },
  { dir: "../skills/evidence-normalize", name: "evidence.normalize" },
  { dir: "../skills/gap-detect", name: "gap.detect" },
  { dir: "../skills/artifact-render", name: "artifact.render" },
];

for (const skill of skills) {
  test(`${skill.name}: skill.yaml parses and matches its directory contract`, () => {
    const contract = YAML.parse(read(`${skill.dir}/skill.yaml`));
    assert.equal(contract.skill, skill.name);
    assert.match(contract.version, /^\d+\.\d+\.\d+$/);
    assert.equal(contract.status, "draft");
    assert.equal(typeof contract.intent, "string");
    assert.ok(Array.isArray(contract.procedure) && contract.procedure.length > 0);
    assert.ok(Array.isArray(contract.constraints) && contract.constraints.length > 0);
    assert.ok(Array.isArray(contract.gates) && contract.gates.length > 0);
    assert.ok(Array.isArray(contract.evals.suites) && contract.evals.suites.length > 0);
    assert.ok(contract.authorization, "authorization expectations are declared");
    assert.ok(contract.dependencies, "dependencies are declared");
  });

  test(`${skill.name}: SKILL.md exists and is agent-agnostic`, () => {
    const md = read(`${skill.dir}/SKILL.md`);
    assert.match(md, /^# /, "has a title");
    for (const heading of ["When to use", "When not to use"]) {
      assert.ok(md.includes(heading), `has a "${heading}" section`);
    }
    assert.match(md, /^#{2,3} .*constraints/im, "has a constraints section");
    for (const host of ["Claude", "OpenAI", "GPT", "Copilot", "Gemini"]) {
      assert.ok(!new RegExp(host, "i").test(md), `must not mention ${host}`);
    }
  });
}

test("evidence.retrieve documents the fixture-only adapter boundary", () => {
  const md = read("../skills/evidence-retrieve/SKILL.md");
  assert.match(md, /only fixture adapters exist/i);
});

test("UNSUPPORTED_SOURCE is a valid structured error code", async () => {
  const { validate } = await import("../schemas/index.js");
  const { valid, errors } = validate("error", {
    code: "UNSUPPORTED_SOURCE",
    message: "Unknown source.",
    retryable: false,
  });
  assert.equal(valid, true, JSON.stringify(errors));
});
