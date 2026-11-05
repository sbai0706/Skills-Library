import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { citationsInMarkdown } from "../workflows/prepare-first-meeting/provenance.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SPECS = [
  {
    name: "prepare-first-meeting",
    script: "prepare-first-meeting",
    executable: "prepare-first-meeting.js",
    options: ["--account", "--sources", "--classification", "--template", "--audience", "--fixture", "--output", "--source", "--capture"],
    fixtures: ["workflow-first-meeting-success"],
  },
  {
    name: "prepare-engagement",
    script: "prepare-engagement",
    executable: "prepare-engagement.js",
    options: ["--fixture", "--account", "--mode", "--classification", "--tone", "--output", "--source", "--capture"],
    fixtures: ["engagement-initial", "engagement-follow-up"],
  },
  {
    name: "qualification",
    script: "qualification",
    executable: "qualification.js",
    options: ["--account", "--sources", "--classification", "--fixture", "--assessment-fixture", "--output", "--source", "--capture"],
    fixtures: ["workflow-first-meeting-success"],
  },
  {
    name: "opportunity-strategy",
    script: "opportunity-strategy",
    executable: "opportunity-strategy.js",
    options: ["--fixture", "--output", "northstar-example", "--account", "--source", "--capture"],
    fixtures: [],
  },
  {
    name: "source-rank",
    script: "source-rank",
    executable: "source-rank.js",
    options: ["--fixture", "--account", "--now", "--output"],
    fixtures: ["source-rank-recency"],
  },
];

function readSkill(spec) {
  const file = resolve(ROOT, ".claude", "skills", spec.name, "SKILL.md");
  const text = readFileSync(file, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, `${spec.name} must begin with YAML frontmatter`);
  return { file, text, metadata: YAML.parse(frontmatter[1]) };
}

function resolveRelativeMarkdownLinks(text, baseFile) {
  const targets = [];
  for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|#)/i.test(target)) continue;
    targets.push(resolve(dirname(baseFile), target.split("#", 1)[0]));
  }
  return targets;
}

function invokeCli(script, args) {
  const spec = SPECS.find((item) => item.script === script);
  assert.ok(spec, `unknown CLI script ${script}`);
  return spawnSync(
    process.execPath,
    [resolve(ROOT, "bin", spec.executable), ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
}

function qualificationCitationsInMarkdown(markdown) {
  return [...new Set(
    [...markdown.matchAll(/\[(clm_[A-Za-z0-9_-]+)\]/g)].map((match) => match[1]),
  )].sort((left, right) => left.localeCompare(right));
}

function workflowResult(
  result,
  expectedExitCode,
  expectedStatus,
  readCitations = citationsInMarkdown,
) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expectedExitCode, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, result.stdout);
  const workflow = JSON.parse(result.stdout);
  assert.equal(workflow.status, expectedStatus);
  assert.ok(Array.isArray(workflow.evidence_ids));
  assert.ok(Array.isArray(workflow.warnings));
  assert.ok(Array.isArray(workflow.errors));
  assert.ok(workflow.artifact?.markdown, "expected a usable Markdown artifact");
  assert.deepEqual(
    readCitations(workflow.artifact.markdown),
    [...workflow.evidence_ids].sort((left, right) => left.localeCompare(right)),
  );
  for (const diagnostic of [...workflow.warnings, ...workflow.errors]) {
    assert.ok(result.stderr.includes(diagnostic.code), `stderr omitted ${diagnostic.code}`);
  }
  return workflow;
}

test("the selected project skills have valid unique Claude Code frontmatter and resolve their assets", () => {
  const names = SPECS.map((spec) => spec.name);
  assert.equal(new Set(names).size, names.length);
  for (const spec of SPECS) {
    assert.match(spec.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const { file, text, metadata } = readSkill(spec);
    assert.equal(metadata.name, spec.name);
    assert.equal(typeof metadata.description, "string");
    assert.ok(metadata.description.trim());
    assert.ok(text.includes(`npm run ${spec.script}`), `${spec.name} must invoke its package script`);
    assert.ok(text.includes(`../../../bin/${spec.executable}`), `${spec.name} must link its CLI`);
    for (const target of resolveRelativeMarkdownLinks(text, file)) {
      assert.ok(existsSync(target), `${spec.name} has an unresolved repository link: ${target}`);
    }
  }

  assert.equal(existsSync(resolve(ROOT, ".claude", "skills", "prepare-first-meeting-v2")), false);
  assert.equal(existsSync(resolve(ROOT, ".claude", "skills", "stakeholder-map")), false);
});

test("documented package scripts, CLI flags, and fixture assets exist", () => {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const guidePath = resolve(ROOT, "docs", "AGENT_SKILLS.md");
  const guide = readFileSync(guidePath, "utf8");
  assert.match(guide, /Node\.js 20/);
  assert.match(guide, /npm install/);
  assert.match(guide, /npm test/);
  for (const target of resolveRelativeMarkdownLinks(guide, guidePath)) {
    assert.ok(existsSync(target), `guide has an unresolved repository link: ${target}`);
  }

  for (const spec of SPECS) {
    const expectedScript = `node bin/${spec.executable}`;
    assert.equal(packageJson.scripts[spec.script], expectedScript);
    assert.ok(guide.includes(`npm run ${spec.script}`), `${spec.name} is missing from the guide`);
    const { text } = readSkill(spec);
    const help = spawnSync(
      process.execPath,
      [resolve(ROOT, "bin", spec.executable), "--help"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(help.status, 0, help.stderr);
    for (const option of spec.options) {
      assert.ok(text.includes(option), `${spec.name} documents ${option}`);
      assert.ok(help.stdout.includes(option), `${spec.name} uses unsupported CLI option ${option}`);
    }
    for (const fixture of spec.fixtures) {
      assert.ok(text.includes(fixture), `${spec.name} does not name its fixture ${fixture}`);
      assert.ok(existsSync(resolve(ROOT, "fixtures", fixture, "input.json")));
    }
  }
  assert.ok(existsSync(resolve(ROOT, "fixtures", "qualification-event", "northstar-provisional.json")));
  assert.ok(existsSync(resolve(ROOT, "fixtures", "opportunity-strategy", "northstar-example.json")));
});

test("first-meeting fixture CLI returns a cited success artifact", () => {
  const result = invokeCli("prepare-first-meeting", [
    "--account", "Northstar Logistics", "--output", "json",
  ]);
  const workflow = workflowResult(result, 0, "success");
  assert.equal(workflow.workflow, "prepare-first-meeting");
  assert.ok(workflow.evidence_ids.length > 0);
});

test("engagement initial fixture CLI returns a cited draft", () => {
  const result = invokeCli("prepare-engagement", [
    "--fixture", "engagement-initial", "--mode", "initial", "--output", "json",
  ]);
  const workflow = workflowResult(result, 0, "success");
  assert.equal(workflow.workflow, "prepare-engagement");
  assert.equal(workflow.mode, "initial");
  assert.ok(workflow.evidence_ids.length > 0);
});

test("engagement follow-up fixture CLI returns a cited source-neutral draft", () => {
  const result = invokeCli("prepare-engagement", [
    "--fixture", "engagement-follow-up", "--mode", "follow_up", "--output", "json",
  ]);
  const workflow = workflowResult(result, 0, "success");
  assert.equal(workflow.workflow, "prepare-engagement");
  assert.equal(workflow.mode, "follow_up");
  assert.ok(workflow.evidence_ids.length > 0);
});

test("qualification fixture CLI returns its advisory partial artifact and evidence", () => {
  const result = invokeCli("qualification", [
    "--account", "Northstar Logistics",
    "--assessment-fixture", "northstar-provisional",
    "--output", "json",
  ]);
  const workflow = workflowResult(result, 2, "partial", qualificationCitationsInMarkdown);
  assert.equal(workflow.workflow, "qualification");
  assert.ok(workflow.evidence_ids.length > 0);
  assert.equal(workflow.assessment.qualification_decision, "not_determined");
});

test("opportunity-strategy fixture CLI returns a cited partial artifact", () => {
  const result = invokeCli("opportunity-strategy", [
    "--fixture", "northstar-example", "--output", "json",
  ]);
  const workflow = workflowResult(result, 2, "partial");
  assert.equal(workflow.workflow, "opportunity-strategy");
  assert.ok(workflow.evidence_ids.length > 0);
});

test("source-rank fixture CLI returns its recency-only partial ranking", () => {
  const result = invokeCli("source-rank", [
    "--fixture", "source-rank-recency", "--output", "json",
  ]);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, result.stdout);
  const skill = JSON.parse(result.stdout);
  assert.equal(skill.skill, "source.rank");
  assert.equal(skill.status, "partial");
  assert.equal(skill.data.ranking_basis, "data_recency_only");
  assert.ok(skill.data.sources.length > 0);
  for (const diagnostic of [...skill.warnings, ...skill.errors]) {
    assert.ok(result.stderr.includes(diagnostic.code), `stderr omitted ${diagnostic.code}`);
  }
});

test("every wrapper has a separate Live Salesforce (capture) mode section that keeps the fixture instructions", () => {
  for (const spec of SPECS.filter((s) => s.name !== "source-rank")) {
    const { text } = readSkill(spec);
    const heading = text.indexOf("## Live Salesforce (capture) mode");
    assert.ok(heading > 0, `${spec.name} needs a Live Salesforce (capture) mode section`);
    assert.ok(text.indexOf(`npm run ${spec.script}`) < heading, `${spec.name} keeps fixture instructions before the capture section`);
    const section = text.slice(heading);
    assert.ok(readSkill(spec).metadata.description.includes("recorded by the host from the read-only connector"), `${spec.name} description wording`);
    assert.ok(!/live Salesforce capture/i.test(readSkill(spec).metadata.description));
    for (const required of [
      "npm run salesforce-capture-plan -- --init-capture .captures/",
      "npm run salesforce-capture-plan -- --account",
      "npm run salesforce-capture-plan -- --account-id",
      "npm run salesforce-capture-plan -- --validate",
      "npm run salesforce-capture-plan -- --append .captures/",
      "--step <step>",
      "--result-file",
      "--error-file",
      "--page-url",
      "--replace-last",
      "never hand-write capture entries",
      "npm run m365-capture-plan -- --append .captures/",
      "--offset <nextOffset>",
      "dispatch_readonly",
      "Never call `dispatch`",
      "INVALID_AUTH_HEADER",
      "retry the identical call once",
      "nextRecordsUrl",
      "git-ignored",
      "never commit",
      `npm run ${spec.script} -- `,
      "--source capture --capture .captures/",
      "REPLAY_INCOMPLETE",
      "failed: incomplete capture",
      "CONFIRMATION_REQUIRED",
      "account_candidates",
      "EVIDENCE_RETRIEVAL_BLOCKED",
      "never loop into candidate selection",
      "case-insensitively",
      "ambiguity/confirmation check",
      "is expected at this",
      "[clm_...]",
      "evidence_ids",
      "Never paste raw capture content",
      "missing pagination page",
      "under the repository's git-ignored `.captures/`",
    ]) {
      assert.ok(section.includes(required), `${spec.name} capture section is missing: ${required}`);
    }
  }
  const guide = readFileSync(resolve(ROOT, "docs", "AGENT_SKILLS.md"), "utf8");
  assert.ok(guide.includes("## Live Salesforce (capture) mode"));
  for (const required of ["salesforce-capture-plan", "--append", "--page-url", "--replace-last", "--source capture", "dispatch_readonly", "REPLAY_INCOMPLETE", ".captures/", "failed: incomplete capture", "CONFIRMATION_REQUIRED", "EVIDENCE_RETRIEVAL_BLOCKED", "[clm_...]", "evidence_ids", "不是账号研究"]) {
    assert.ok(guide.includes(required), `guide is missing ${required}`);
  }
});

test("the capture plan CLI is a documented package script with help", () => {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["salesforce-capture-plan"], "node bin/salesforce-capture-plan.js");
  const help = spawnSync(process.execPath, [resolve(ROOT, "bin", "salesforce-capture-plan.js"), "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const option of ["--account", "--account-id", "--init-capture", "--validate", "--source-system", "--append", "--step", "--page-url", "--result-file", "--error-file", "--replace-last", "--captured-at"]) {
    assert.ok(help.stdout.includes(option), `help is missing ${option}`);
  }
});

test("the source-rank wrapper and the capture docs require the append command instead of hand-written entries", () => {
  const rank = readSkill(SPECS.find((spec) => spec.name === "source-rank")).text;
  const section = rank.slice(rank.indexOf("## Capture mode (Salesforce + M365 SharePoint)"), rank.indexOf("## Boundaries"));
  for (const required of [
    "npm run salesforce-capture-plan -- --append .captures/",
    "npm run m365-capture-plan -- --append .captures/",
    "--result-file", "--error-file", "--page-url", "--offset <nextOffset>", "never hand-write capture entries",
  ]) {
    assert.ok(section.includes(required), `source-rank capture section is missing: ${required}`);
  }
  const doc = readFileSync(resolve(ROOT, "docs", "MCP_CAPTURE.md"), "utf8");
  const appending = doc.slice(doc.indexOf("## Appending entries (`--append`)"), doc.indexOf("## End-to-end host procedure"));
  assert.ok(appending.length > 0, "MCP_CAPTURE.md needs an Appending entries section");
  for (const required of ["--append", "--step", "--page-url", "--offset", "--result-file", "--error-file", "--replace-last", "--captured-at", "append only the final attempt", "MSYS_NO_PATHCONV", "no normalisation and no redaction"]) {
    assert.ok(appending.includes(required), `MCP_CAPTURE.md append section is missing: ${required}`);
  }
  for (const spec of SPECS.filter((s) => s.name !== "source-rank")) {
    const text = readSkill(spec).text;
    assert.ok(!text.includes('"captured_at":"<ISO time>"'), `${spec.name} must not tell the host to hand-write capture entries`);
  }
  const m365Help = spawnSync(process.execPath, [resolve(ROOT, "bin", "m365-capture-plan.js"), "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(m365Help.status, 0, m365Help.stderr);
  for (const option of ["--append", "--step", "--offset", "--result-file", "--error-file", "--replace-last", "--captured-at"]) {
    assert.ok(m365Help.stdout.includes(option), `m365 help is missing ${option}`);
  }
});
