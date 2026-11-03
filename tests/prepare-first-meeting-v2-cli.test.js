import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validate } from "../schemas/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = resolve(root, "bin/prepare-first-meeting-v2.js");

function invoke(args, { cwd = root, useNpm = false } = {}) {
  const isWindowsNpm = useNpm && process.platform === "win32";
  const command = useNpm ? (isWindowsNpm ? process.execPath : "npm") : process.execPath;
  const commandArgs = useNpm
    ? [
        ...(isWindowsNpm ? [process.env.npm_execpath] : []),
        "run", "prepare-first-meeting-v2", "--", ...args,
      ]
    : [cliPath, ...args];
  return spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
}

function jsonResult(processResult) {
  assert.equal(processResult.error, undefined, processResult.error?.message);
  assert.ok(processResult.stdout.endsWith("\n"));
  assert.equal(processResult.stdout.trim().split("\n").length, 1);
  return JSON.parse(processResult.stdout);
}

test("npm portable invocation emits one schema-valid v2 result with explicit mappings", {
  skip: process.platform === "win32" && !process.env.npm_execpath,
}, () => {
  const result = invoke([
    "--account", "Northstar Logistics",
    "--mapping-fixture", "northstar-example",
  ], { useNpm: true });
  assert.equal(result.status, 0, result.stderr);
  const workflow = jsonResult(result);
  assert.equal(workflow.workflow, "prepare-first-meeting-v2");
  assert.equal(workflow.status, "success");
  assert.equal(validate("prepareFirstMeetingV2Result", workflow).valid, true);
  assert.equal(workflow.account_intelligence.signals.signals.length, 2);
});

test("Markdown invocation emits only the evidence-linked v2 brief", () => {
  const result = invoke([
    "--account", "Northstar Logistics",
    "--mapping-fixture", "northstar-example",
    "--output", "markdown",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# First-meeting brief — Northstar Logistics/);
  assert.match(result.stdout, /## Account Intelligence/);
  assert.match(result.stdout, /\[`clm_5e66a71c957aaada`\]/);
  assert.ok(!result.stdout.includes('"workflow"'));
});

test("default mapping mode leaves enrichment explicitly unknown", () => {
  const result = invoke(["--account", "Northstar Logistics"]);
  assert.equal(result.status, 0, result.stderr);
  const workflow = jsonResult(result);
  assert.deepEqual(workflow.account_intelligence.signals.signals, []);
  assert.match(workflow.artifact.markdown, /No caller-provided signal mappings/);
});

test("blocked and invalid invocations do not emit an artifact", () => {
  const blocked = invoke([
    "--fixture", "workflow-first-meeting-ambiguous",
    "--account", "Meridian Health",
  ]);
  assert.equal(blocked.status, 3);
  assert.equal(jsonResult(blocked).artifact, null);

  const invalid = invoke([
    "--account", "Northstar Logistics",
    "--mapping-fixture", "not-a-fixture",
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unknown mapping fixture/);
});
