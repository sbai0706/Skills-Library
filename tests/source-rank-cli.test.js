import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validate } from "../schemas/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = resolve(root, "bin/source-rank.js");
const expected = JSON.parse(
  readFileSync(resolve(root, "fixtures/source-rank-recency/expected.json"), "utf8"),
).expected;

function invoke(args, { cwd = root } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
}

function jsonResult(processResult) {
  assert.equal(processResult.error, undefined, processResult.error?.message);
  assert.ok(processResult.stdout.endsWith("\n"));
  assert.equal(processResult.stdout.trim().split("\n").length, 1);
  return JSON.parse(processResult.stdout);
}

const withoutTrace = ({ trace_id, ...rest }) => rest;

test("shipped fixture is partial: exit 2, schema-valid JSON matching the expected ranking", () => {
  const result = invoke(["--fixture", "source-rank-recency", "--output", "json"]);
  assert.equal(result.status, 2, result.stderr);
  const skill = jsonResult(result);
  assert.equal(skill.status, "partial");
  assert.equal(validate("skillResult", skill).valid, true);
  assert.deepEqual(skill.data, expected.data);
  assert.deepEqual(skill.warnings.map((warning) => warning.code), expected.warning_codes);
  for (const warning of skill.warnings) {
    assert.ok(result.stderr.includes(warning.code), `stderr omitted ${warning.code}`);
  }
});

test("JSON is the default output and the fixture is the default", () => {
  const result = invoke([]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(jsonResult(result).skill, "source.rank");
});

test("Markdown output is a recency-only ranking table followed by warnings", () => {
  const result = invoke(["--output", "markdown"]);
  assert.equal(result.status, 2, result.stderr);
  const lines = result.stdout.split("\n");
  assert.match(result.stdout, /Recency ordering only/);
  assert.match(result.stdout, /not a\s+reliability, authority or quality judgement/);
  assert.ok(lines.includes("| Rank | Source | Latest data timestamp | Field | Age (days) | Notes |"));
  const rows = lines.filter((line) => /^\| (\d+|-) \|/.test(line));
  assert.equal(rows.length, expected.data.sources.length);
  assert.match(rows[0], /^\| 1 \| fixture-market-intel \| 2026-10-30T08:00:00Z \| published_at \| 6 \|/);
  assert.match(result.stdout, /tie with fixture-public-web/);
  assert.match(result.stdout, /retrieval fallback/);
  assert.match(rows.at(-1), /^\| - \| fixture-partner-feed \| unknown \|/);
  assert.match(rows.at(-1), /unknown recency/);
  assert.ok(result.stdout.indexOf("## Warnings") > result.stdout.indexOf(rows.at(-1)));
  for (const code of expected.warning_codes) assert.ok(result.stdout.includes(code));
});

test("an account with no matching items is blocked: exit 3, no ranking", () => {
  const json = invoke(["--account", "acct_unknown_001"]);
  assert.equal(json.status, 3, json.stderr);
  const skill = jsonResult(json);
  assert.equal(skill.status, "blocked");
  assert.equal(skill.data, null);
  assert.equal(skill.errors[0].code, "ACCOUNT_SCOPE_MISMATCH");

  const markdown = invoke(["--account", "acct_unknown_001", "--output", "markdown"]);
  assert.equal(markdown.status, 3);
  assert.equal(markdown.stdout, "");
  assert.match(markdown.stderr, /Skill blocked: ACCOUNT_SCOPE_MISMATCH\. No ranking was produced\./);
});

test("an account name instead of an ID fails the skill: exit 1", () => {
  const result = invoke(["--account", "Vantage Freight Systems"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(jsonResult(result).status, "failed");
});

test("--help prints usage and exits 0", () => {
  const result = invoke(["--help"]);
  assert.equal(result.status, 0);
  for (const option of ["--fixture", "--account", "--now", "--output"]) {
    assert.ok(result.stdout.includes(option));
  }
  assert.match(result.stdout, /Exit codes: 0 success, 2 partial with data, 3 blocked, 1 failed/);
});

test("invalid invocations exit 1 with a diagnostic and no stdout", () => {
  const cases = [
    [["--bogus", "x"], /Unknown option: --bogus/],
    [["--fixture"], /Missing value for --fixture/],
    [["--output", "--now"], /Missing value for --output/],
    [["--output", "xml"], /--output must be json or markdown/],
    [["--fixture", "nope"], /Unknown fixture/],
    [["--fixture", "../qualification-event"], /Unknown fixture/],
    [["--now", "yesterday"], /--now must be a valid RFC 3339/],
    [["--now", "2026-11-05T12:00:00"], /--now must be a valid RFC 3339/],
    [["--account", "  "], /--account must not be empty/],
    [["--output", "json", "--output", "json"], /may only be provided once/],
  ];
  for (const [args, pattern] of cases) {
    const result = invoke(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, pattern);
  }
});

test("--now makes output deterministic and drives age_days", () => {
  const args = ["--now", "2026-11-10T12:00:00+00:00"];
  const first = invoke(args);
  const second = invoke(args);
  assert.equal(first.status, 2);
  assert.deepEqual(withoutTrace(jsonResult(first)), withoutTrace(jsonResult(second)));
  assert.equal(jsonResult(first).data.sources[0].age_days, 11);

  const mdA = invoke([...args, "--output", "markdown"]);
  const mdB = invoke([...args, "--output", "markdown"]);
  assert.equal(mdA.stdout, mdB.stdout);
  assert.match(mdA.stdout, /\| 1 \| fixture-market-intel \| 2026-10-30T08:00:00Z \| published_at \| 11 \|/);
});
