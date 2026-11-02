import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validate } from "../schemas/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const subdirectory = resolve(root, "workflows/prepare-first-meeting");
const cliPath = resolve(root, "bin/prepare-first-meeting.js");

function invoke(args, { cwd = root, useNpm = false } = {}) {
  const isWindowsNpm = useNpm && process.platform === "win32";
  const command = useNpm
    ? (isWindowsNpm ? process.execPath : "npm")
    : process.execPath;
  const commandArgs = useNpm
    ? [
        ...(isWindowsNpm ? [process.env.npm_execpath] : []),
        "run", "prepare-first-meeting", "--", ...args,
      ]
    : [cliPath, ...args];
  return spawnSync(
    command,
    commandArgs,
    { cwd, encoding: "utf8" },
  );
}

function jsonResult(processResult) {
  assert.equal(processResult.error, undefined, processResult.error?.message);
  assert.ok(processResult.stdout.endsWith("\n"));
  assert.equal(processResult.stdout.trim().split("\n").length, 1);
  return JSON.parse(processResult.stdout);
}

test("successful JSON output is one workflow result and validates against its schema", () => {
  const result = invoke(["--account", "Northstar Logistics"], { useNpm: true });
  assert.equal(result.status, 0, result.stderr);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "success");
  assert.equal(workflow.artifact.classification, "internal");
  assert.equal(validate("workflowResult", workflow).valid, true);
});

test("successful Markdown output contains only the rendered brief on stdout", () => {
  const result = invoke([
    "--account", "Northstar Logistics",
    "--output", "markdown",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# First-meeting brief — Northstar Logistics/);
  assert.ok(!result.stdout.includes("\"workflow\""));
});

test("ambiguous account preserves blocked status and exit code 3", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-ambiguous",
    "--account", "Meridian Health",
  ]);
  assert.equal(result.status, 3);
  assert.equal(jsonResult(result).status, "blocked");
});

test("blocked Markdown invocation emits no artifact and gives a safe stderr explanation", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-ambiguous",
    "--account", "Meridian Health",
    "--output", "markdown",
  ]);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Workflow blocked: AMBIGUOUS_ACCOUNT/);
});

test("fuzzy account requires confirmation and preserves blocked status", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-fuzzy-confirmation",
    "--account", "Northstar",
  ]);
  assert.equal(result.status, 3);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "blocked");
  assert.ok(workflow.errors.some((entry) => entry.code === "CONFIRMATION_REQUIRED"));
});

test("missing account argument is an invalid invocation", () => {
  const result = invoke([]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--account is required/);
});

test("unknown fixture and authorization override options are rejected", () => {
  const unknownFixture = invoke([
    "--fixture", "workflow-first-meeting-not-real",
    "--account", "Northstar Logistics",
  ]);
  assert.equal(unknownFixture.status, 1);
  assert.equal(unknownFixture.stdout, "");
  assert.match(unknownFixture.stderr, /Unknown fixture/);

  const elevation = invoke([
    "--account", "Northstar Logistics",
    "--roles", "sales_owner",
  ]);
  assert.equal(elevation.status, 1);
  assert.equal(elevation.stdout, "");
  assert.match(elevation.stderr, /Unknown option: --roles/);

  const unknownClassification = invoke([
    "--account", "Northstar Logistics",
    "--classification", "secret",
  ]);
  assert.equal(unknownClassification.status, 1);
  assert.equal(jsonResult(unknownClassification).status, "failed");

  const emptyClassification = invoke([
    "--account", "Northstar Logistics",
    "--classification", "",
  ]);
  assert.equal(emptyClassification.status, 1);
  assert.equal(jsonResult(emptyClassification).status, "failed");
});

test("unknown source fails workflow validation without diagnostic stdout noise", () => {
  const result = invoke([
    "--account", "Northstar Logistics",
    "--sources", "crm,web_crawl",
  ]);
  assert.equal(result.status, 1);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "failed");
  assert.ok(workflow.errors.some((entry) => entry.code === "UNSUPPORTED_SOURCE"));
  assert.ok(result.stderr.includes("UNSUPPORTED_SOURCE"));
});

test("unknown template fails at rendering", () => {
  const result = invoke([
    "--account", "Northstar Logistics",
    "--template", "first-meeting-brief-v999",
  ]);
  assert.equal(result.status, 1);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "failed");
  assert.ok(workflow.errors.some((entry) => entry.step === "artifact.render"));
});

test("failed Markdown invocation emits no artifact and gives a safe stderr explanation", () => {
  const result = invoke([
    "--account", "Northstar Logistics",
    "--template", "first-meeting-brief-v999",
    "--output", "markdown",
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Workflow failed: INVALID_INPUT/);
});

test("partial source result has a usable artifact and exit code 2", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-partial-source-failure",
    "--account", "Cobalt Freight Systems",
  ], { useNpm: true });
  assert.equal(result.status, 2);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "partial");
  assert.ok(workflow.artifact);
});

test("partial Markdown output still emits the artifact and uses exit code 2", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-partial-source-failure",
    "--account", "Cobalt Freight Systems",
    "--output", "markdown",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^# First-meeting brief — Cobalt Freight Systems/);
});

test("total retrieval failure preserves failed status and exit code 1", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-retrieval-failure",
    "--account", "Rivermark Utilities",
  ]);
  assert.equal(result.status, 1);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.artifact, null);
});

test("classification-filtered JSON and Markdown outputs do not leak withheld content", () => {
  const options = [
    "--fixture", "workflow-first-meeting-classification-filtered",
    "--account", "Juniper Ridge Energy",
    "--sources", "crm",
    "--classification", "public",
  ];
  const json = invoke(options);
  assert.equal(json.status, 2);
  const workflow = jsonResult(json);
  assert.equal(workflow.status, "partial");
  assert.ok(workflow.omitted_evidence_ids.length > 0);

  const markdown = invoke([...options, "--output", "markdown"]);
  assert.equal(markdown.status, 2);
  const forbidden = [
    "Juniper Ridge Energy requested a root-cause review of grid outages.",
    "Juniper Ridge Energy is evaluating a confidential acquisition of Harborline Marine.",
    "src_wf_class_internal",
    "src_wf_class_confidential",
  ];
  for (const secret of forbidden) {
    assert.ok(!json.stdout.includes(secret));
    assert.ok(!json.stderr.includes(secret));
    assert.ok(!markdown.stdout.includes(secret));
    assert.ok(!markdown.stderr.includes(secret));
  }
});

test("JSON mode keeps diagnostics on stderr only", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-sparse",
    "--account", "Lumen Harbor Terminals",
  ]);
  assert.equal(result.status, 0);
  const workflow = jsonResult(result);
  assert.ok(workflow.warnings.length > 0);
  assert.ok(result.stderr.includes("GAPS_PRESENT"));
  assert.ok(result.stdout.startsWith("{"), "stdout must begin with the single JSON result");
  assert.ok(!result.stdout.includes("\n> sales-copilot-skills@"), "npm banner must not precede the JSON result");
});

test("CLI resolves fixture paths when invoked from a repository subdirectory", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-conflicted",
    "--account", "Halcyon Foods",
    "--sources", "crm",
  ], { cwd: subdirectory, useNpm: true });
  assert.equal(result.status, 0, result.stderr);
  const workflow = jsonResult(result);
  assert.equal(workflow.status, "success");
  assert.ok(workflow.warnings.some((entry) => entry.code === "CONFLICTS_PRESENT"));
});

test("sparse fixture can be rendered as Markdown", () => {
  const result = invoke([
    "--fixture", "workflow-first-meeting-sparse",
    "--account", "Lumen Harbor Terminals",
    "--output", "markdown",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# First-meeting brief/);
  assert.ok(result.stdout.includes("No permitted evidence was retrieved"));
});
