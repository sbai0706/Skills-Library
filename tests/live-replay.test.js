import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_SCRIPTS, LiveReplayError, formatTable, loadExpectations, parseAllowedCommand, replay, tokenize,
} from "../cli/live-replay.js";

/**
 * `npm run live-replay` against the SYNTHETIC northwind fixtures only (no real data, no connector
 * call). The script itself is not a test file, so `npm test` never runs it.
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXAMPLE = resolve(root, "reference/live-replay-expectations.example.json");
const tmp = mkdtempSync(join(tmpdir(), "live-replay-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const BIN = resolve(root, "bin/live-replay.js");
let counter = 0;
const run = (args) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
const writeExpectations = (doc) => {
  counter += 1;
  const path = join(tmp, `expectations-${counter}.json`);
  writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  return path;
};
const example = () => JSON.parse(readFileSync(EXAMPLE, "utf8"));
const rows = (stdout) => stdout.split("\n").filter((line) => /^\S+\s+[rv]\d+\s/.test(line));

// ---------------------------------------------------------------- the synthetic example

test("the synthetic example replays against the northwind fixtures: every row passes, exit 0, payload-free table", () => {
  const result = run(["--expectations", EXAMPLE]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "");
  const table = rows(result.stdout);
  assert.equal(table.length, 6);
  assert.ok(table.every((line) => /\sPASS$/.test(line)), result.stdout);
  assert.match(result.stdout, /6\/6 passed$/m);
  // scenario id, run index, script, expected/actual exit and status only
  assert.match(result.stdout, /^scenario\s+run\s+script\s+exit \(exp\/act\)\s+status \(exp\/act\)\s+result$/m);
  assert.match(result.stdout, /^N1\s+r3\s+source-rank\s+3\/3\s+blocked\/blocked\s+PASS$/m);
  assert.match(result.stdout, /^N1\s+v1\s+salesforce-capture-plan\s+0\/0\s+-\/-\s+PASS$/m);
  for (const forbidden of ["Northwind", "fixtures/", "sf_001SYN", "contoso", "--capture", "Example"]) {
    assert.ok(!result.stdout.includes(forbidden), `the table must not contain ${forbidden}`);
  }
});

test("a changed expected exit code or status is reported as MISMATCH with exit 1; the other rows still pass", () => {
  const doc = example();
  doc.scenarios.N1.runs[0].exit_code = 2; // really 0
  doc.scenarios.N1.runs[1].status = "partial"; // really success
  const result = run(["--expectations", writeExpectations(doc)]);
  assert.equal(result.status, 1);
  const table = rows(result.stdout);
  assert.equal(table.length, 6);
  assert.match(result.stdout, /^N1\s+r1\s+prepare-first-meeting\s+2\/0\s+success\/success\s+MISMATCH$/m);
  assert.match(result.stdout, /^N1\s+r2\s+source-rank\s+0\/0\s+partial\/success\s+MISMATCH$/m);
  assert.equal(table.filter((line) => /\sPASS$/.test(line)).length, 4);
  assert.match(result.stdout, /4\/6 passed, 2 MISMATCH$/m);
});

test("status is compared only when the expectation has one; --scenario filters", () => {
  const doc = example();
  delete doc.scenarios.N1.runs[0].status;
  doc.scenarios.N1.runs[1].status = null;
  const all = run(["--expectations", writeExpectations(doc)]);
  assert.equal(all.status, 0, all.stdout);
  assert.match(all.stdout, /^N1\s+r1\s+prepare-first-meeting\s+0\/0\s+-\/success\s+PASS$/m);
  const only = run(["--expectations", EXAMPLE, "--scenario", "N2"]);
  assert.equal(only.status, 0);
  assert.equal(rows(only.stdout).length, 1);
  const unknown = run(["--expectations", EXAMPLE, "--scenario", "N9"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--scenario names an id that is not in the expectations/);
});

test("the real acceptance record's structure is accepted: extra keys are ignored and build steps are never replayed", () => {
  const sentinel = join(tmp, "must-not-exist.json");
  const doc = {
    generated: "synthetic", repo_state: "synthetic", mapping: "synthetic", record_counts: { N1: { Account: 1 } },
    scenarios: {
      N1: {
        captures: ["fixtures/salesforce-northwind/capture.json"],
        build: [`npm run salesforce-capture-plan -- --init-capture ${sentinel} --source-system salesforce`, "rm -rf /"],
        validate_exit: { sf: 0 },
        note: "synthetic",
        runs: [{
          label: "no match", command: "npm run source-rank -- --source capture --account sf_001SYN0000000001AA --capture fixtures/salesforce-northwind/capture.json --output json",
          exit_code: 0, status: "success", warning_codes: [], error_codes: [], stdout_file: "x", stderr_file: "y", stdout_empty: false,
        }],
        checks: [{ case: "duplicate", exit_code: 1 }],
      },
    },
  };
  const result = run(["--expectations", writeExpectations(doc)]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(rows(result.stdout).length, 1);
  assert.equal(existsSync(sentinel), false);
});

test("a command with an unresolved <placeholder> is skipped, not passed; mismatches elsewhere still fail", () => {
  const doc = example();
  doc.scenarios.N2.runs.push({
    command: "npm run -s salesforce-capture-plan -- --validate fixtures/salesforce-northwind/capture.json --account-id sf_<Id>", exit_code: 1,
  });
  const skipped = run(["--expectations", writeExpectations(doc)]);
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /^N2\s+r2\s+salesforce-capture-plan\s+1\/-\s+-\/-\s+SKIP$/m);
  assert.match(skipped.stdout, /6\/7 passed, 1 skipped/);
  doc.scenarios.N1.runs[0].exit_code = 3;
  assert.equal(run(["--expectations", writeExpectations(doc)]).status, 1);
});

// ---------------------------------------------------------------- allow-list

const REFUSED = [
  "npm test", "npm run test", "npm run live-replay -- --help", "npm run start", "npm install", "npm exec -- something", "npx something",
  "node bin/source-rank.js --output json", "rm -rf .", "git status", "echo hello", "",
  "npm run -s source-rank -- --output json; echo x", "npm run -s source-rank -- --output json && echo x", "npm run -s source-rank -- --output json | cat",
  "npm run -s source-rank -- $(echo x)", "npm run -s source-rank -- `echo x`", "npm run -s source-rank > out.txt",
  "npm run -s source-rank --output json", "npm run -s -s source-rank -- --output json", "npm run -s source-rank extra -- --output json",
  "npm run -s \"source-rank\" -- --output json; true", "npm run -s source-rank -- --account \"unterminated",
  "npm run -s salesforce-capture-plan -- --append .captures/x.json --account-id sf_001SYN0000000001AA --step Account --result-file .captures/r.json",
  "npm run -s salesforce-capture-plan -- --init-capture .captures/zz-live-replay.json --source-system salesforce",
  "npm run -s salesforce-capture-plan -- --account-id sf_001SYN0000000001AA",
  "npm run -s salesforce-capture-plan -- --validate x.json --init-capture .captures/zz-live-replay.json",
  "npm run -s m365-capture-plan -- --account-id sf_001SYN0000000001AA",
  "npm run -s m365-capture-plan -- --init-capture .captures/zz-live-replay.json",
  "npm run -s m365-capture-plan -- --validate x.json --append x.json",
  "npm run -s m365-capture-plan --",
];

test("commands outside the allow-list are refused, nothing is run, and no command text is echoed", () => {
  const valid = { command: example().scenarios.N2.runs[0].command, exit_code: 1, status: "failed" };
  for (const command of REFUSED) {
    const result = run(["--expectations", writeExpectations({ scenarios: { N1: { runs: [valid, { command: `${command}`, exit_code: 0 }] } } })]);
    assert.equal(result.status, 1, `expected a refusal for: ${JSON.stringify(command)}\n${result.stdout}`);
    assert.equal(result.stdout, "", `nothing is run or tabulated for: ${JSON.stringify(command)}`);
    assert.match(result.stderr, /^N1 r2: command refused: /m);
    assert.match(result.stderr, /live-replay: 1 entry refused; nothing was run\./);
    if (command.trim() !== "") assert.ok(!result.stderr.includes(command), "the refused command text must not be echoed");
  }
  assert.equal(existsSync(resolve(root, ".captures", "zz-live-replay.json")), false, "no capture file was created");
});

test("parseAllowedCommand accepts the repository's own scripts only, in either npm spelling", () => {
  for (const [script, file] of Object.entries(ALLOWED_SCRIPTS)) {
    const mode = script.endsWith("capture-plan") ? " --validate x.json" : "";
    for (const prefix of ["npm run", "npm run -s", "npm run --silent"]) {
      const parsed = parseAllowedCommand(`${prefix} ${script} -- --output json${mode}`);
      assert.equal(parsed.script, script);
      assert.equal(parsed.file, file);
      assert.deepEqual(parsed.args, ["--output", "json", ...(mode ? ["--validate", "x.json"] : [])]);
      assert.equal(parsed.placeholder, false);
    }
  }
  assert.deepEqual(parseAllowedCommand("npm run -s prepare-first-meeting").args, []);
  assert.deepEqual(parseAllowedCommand('npm run -s prepare-first-meeting -- --account "Two Words" --x \'single q\'').args, ["--account", "Two Words", "--x", "single q"]);
  assert.deepEqual(parseAllowedCommand('npm run -s prepare-first-meeting -- --account "a; b | c $(x)"').args, ["--account", "a; b | c $(x)"], "metacharacters inside quotes are inert (no shell)");
  assert.equal(parseAllowedCommand("npm run -s prepare-first-meeting -- --account sf_<Id>").placeholder, true);
  assert.deepEqual(tokenize("a  b\tc"), ["a", "b", "c"]);
  assert.equal(tokenize("a\nb"), null);
  assert.equal(tokenize("a; b"), null);
  assert.throws(() => parseAllowedCommand("npm run nope"), (error) => error instanceof LiveReplayError && !error.message.includes("nope"));
});

test("every allow-listed script is mapped by package.json, and live-replay is a package script outside npm test", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const [script, file] of Object.entries(ALLOWED_SCRIPTS)) assert.equal(pkg.scripts[script], `node ${file}`);
  assert.equal(pkg.scripts["live-replay"], "node bin/live-replay.js");
  assert.equal(pkg.scripts.test, "node --test", "npm test selects files by node's default patterns (*.test.js, test/ directories)");
  assert.ok(!Object.hasOwn(ALLOWED_SCRIPTS, "live-replay") && !Object.hasOwn(ALLOWED_SCRIPTS, "test"));
  // node --test's default patterns: *.test.js, *-test.js, *_test.js, test-*.js, test.js and files under test/ directories
  for (const name of ["live-replay.js"]) assert.ok(!/(\.test|[-_]test)\.[cm]?js$|^test-.*\.[cm]?js$|^test\.[cm]?js$/.test(name));
  for (const path of ["bin/live-replay.js", "cli/live-replay.js"]) assert.ok(existsSync(resolve(root, path)));
  assert.ok(!existsSync(resolve(root, "bin", "test")) && !existsSync(resolve(root, "cli", "test")));
});

// ---------------------------------------------------------------- loading, comparison and usage

test("replay compares exit code and status with an injected runner (no process is spawned)", () => {
  const items = [
    { scenario: "A", run: "r1", command: "npm run -s source-rank -- --output json", exitCode: 0, status: "success" },
    { scenario: "A", run: "r2", command: "npm run -s source-rank -- --output json", exitCode: 3, status: "blocked" },
    { scenario: "A", run: "r3", command: "npm run -s source-rank -- --output json", exitCode: 1, status: null },
    { scenario: "A", run: "r4", command: "npm run -s source-rank -- --output json", exitCode: 0, status: null },
  ];
  const outcomes = [{ exitCode: 0, status: "success" }, { exitCode: 3, status: "partial" }, { exitCode: 1, status: "failed" }, { exitCode: null, status: null }];
  let index = 0;
  const result = replay(items, { runner: () => outcomes[index++] });
  assert.deepEqual(result.map((row) => row.pass), [true, false, true, false]);
  const table = formatTable(result);
  assert.match(table, /^A\s+r2\s+source-rank\s+3\/3\s+blocked\/partial\s+MISMATCH$/m);
  assert.match(table, /^A\s+r4\s+source-rank\s+0\/-\s+-\/-\s+MISMATCH$/m);
  assert.match(table, /2\/4 passed, 2 MISMATCH$/);
});

test("invalid expectations and usage exit 1 with fixed text", () => {
  const cases = [
    [["--expectations", join(tmp, "missing.json")], /The expectations file does not exist or cannot be read/],
    [["--expectations", writeExpectations("{ not json")], /The expectations file is not valid JSON/],
    [["--expectations", writeExpectations({})], /needs a non-empty `scenarios` object/],
    [["--expectations", writeExpectations({ scenarios: {} })], /needs a non-empty `scenarios` object/],
    [["--expectations", writeExpectations({ scenarios: { "bad id!": { runs: [] } } })], /Every scenario needs an id/],
    [["--expectations", writeExpectations({ scenarios: { A: { runs: "x" } } })], /`runs` must be an array/],
    [["--expectations", writeExpectations({ scenarios: { A: { runs: [] } } })], /contain no runs to replay/],
    [["--bogus"], /Unknown option: --bogus/],
    [["--expectations"], /Missing value for --expectations/],
    [["--expectations", EXAMPLE, "--expectations", EXAMPLE], /Option may only be provided once/],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
  for (const bad of [
    { command: 5, exit_code: 0 }, { command: "npm run -s source-rank", exit_code: "0" }, { command: "npm run -s source-rank", exit_code: 256 },
    { command: "npm run -s source-rank", exit_code: 0, status: 3 }, "text", null,
  ]) {
    const result = run(["--expectations", writeExpectations({ scenarios: { A: { runs: [bad] } } })]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /A r1: entry needs a string `command`, an integer `exit_code`/);
  }
  assert.throws(() => loadExpectations(join(tmp, "missing.json")), LiveReplayError);
});

test("--help documents the options and the allow-list; the example file is synthetic", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  for (const text of ["--expectations", "--scenario", "local/p5-live-acceptance.json", "allow-listed", "--validate", "nothing runs"]) {
    assert.ok(help.stdout.includes(text), `help is missing ${text}`);
  }
  const text = readFileSync(EXAMPLE, "utf8");
  assert.ok(!/BENEVIS|relevantz|salesforce\.com|\.captures/i.test(text), "the example must not name real data");
  for (const entry of [...Object.values(example().scenarios).flatMap((scenario) => [...scenario.runs, ...Object.values(scenario.validate ?? {})])]) {
    assert.doesNotThrow(() => parseAllowedCommand(entry.command));
  }
});
