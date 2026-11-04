# Sales Copilot Skills Library — Project Handoff

**Snapshot: 2026-11-04**

## Executive summary

The repository is a portable, agent-agnostic Sales Copilot Skills Library. Its Phase 1 library
scope is implemented as four deterministic, fixture-backed outcomes: Account Intelligence,
Engagement, Qualification, and Opportunity Strategy. The project also has a shared evidence
foundation and a stable v1 first-meeting workflow.

This is **repository-scope delivery**, not an approved business requirements baseline, customer
pilot, or production Sales Copilot. The checked-in examples are illustrative fixtures. The library
does not host an agent, query live systems, make business decisions, write to CRM, advance an
opportunity, or send communications.

## Goal, source materials, and scope boundary

The Phase 1 presentation names four outcomes: Account Intelligence, Engagement, Qualification, and
Opportunity Strategy. The current [Phase 1 plan](PHASE1_SKILLS_PLAN.md) treats the supplied
`Relevantz_Sales_Agent_01_agent_readable.md` as a conceptual proposal rather than an approved BRD,
and `Relevantz_Claude_Cowork_Sales_Command_Agent_Mockup.html` as an interactive concept with
simulated, illustrative data—not customer evidence or policy. Preserve the user-owned original
copies; they are source inputs, not files to replace or stage as part of this handoff.

The library owns portable skill contracts, JavaScript functions, workflows, schemas, fixtures, and
local CLIs. The Cowork/runtime/UI, authenticated identity, production record and field
authorization, live CRM/public-source adapters, approval UX, audit/telemetry, approved messaging
channels, and any external writes or sends are host/integration responsibilities. They are outside
the current implementation.

## Architecture and important paths

The normal flow is: a CLI or host supplies inputs and adapter implementations; a composed workflow
calls skills; retrieval and normalization produce account-scoped evidence claims with provenance;
gap analysis preserves unknowns and conflicts; a renderer returns a cited artifact under a
classification ceiling. In this repository, CLIs bootstrap fixture adapters and a deterministic
fixture claim extractor. No model or network call is made.

| Path | Purpose |
|---|---|
| [`skills/`](../skills/) | Callable skill functions and their `SKILL.md` / manifest contracts. |
| [`workflows/`](../workflows/) | Composed workflows, including v1/v2 first-meeting, Engagement, Qualification, and Opportunity Strategy. |
| [`adapters/`](../adapters/) | Adapter interfaces and the current fixture account, evidence, and claim-extractor implementations. |
| [`schemas/`](../schemas/) | Shared JSON input, result, evidence, and artifact contracts. |
| [`reference/`](../reference/) | Versioned signal, persona, offering, and question references; relevant business vocabularies remain provisional. |
| [`fixtures/`](../fixtures/) | Fictional account/evidence inputs and expected workflow outputs. |
| [`bin/`](../bin/) and [`package.json`](../package.json) | Portable CLI entry points and npm scripts. |
| [`.claude/skills/`](../.claude/skills/prepare-first-meeting/SKILL.md) | Four repo-local Claude Code project wrappers for selected workflows. |
| [`tests/`](../tests/) | Contract, skill, workflow, CLI, fixture, and wrapper tests. |
| [`AGENT_SKILLS.md`](AGENT_SKILLS.md) | Claude Code setup, commands, result handling, and wrapper limitations. |
| [`MVP_HANDOFF.md`](MVP_HANDOFF.md) | Historical MVP handoff; not the current task queue. |

`account.resolve`, `evidence.retrieve`, `evidence.normalize`, `gap.detect`, and `artifact.render`
form the shared evidence base. The v1 `prepare-first-meeting` workflow remains available and its
schema, output, and renderer were preserved by the additive v2 path. The
[architecture reference](../Sales_Skills_Library_Architecture_v2.md) describes the eventual
direction; it is not a claim that the full target architecture is implemented.

## Four Phase 1 outcomes

| Outcome | Callable workflow / CLI | Current fixture behavior | What it does not establish |
|---|---|---|---|
| **Account Intelligence** | `prepare-first-meeting-v2` composes `signal.extract`, `stakeholder.map`, and `offering.match`; CLI: `prepare-first-meeting-v2`. | Caller-mapped signals, stakeholder role hypotheses, and offering candidates linked to evidence; Northstar example returns `success` with four citations and `GAPS_PRESENT` warnings. | No automated source discovery, verified stakeholder authority, approved service fit, or customer research. Mappings and vocabularies are provisional/caller supplied. |
| **Engagement** | `prepare-engagement` composes `engagement.draft`; initial and follow-up modes. | Reviewable initial outreach/meeting-preparation or source-neutral follow-up drafts; both documented smokes return `success`. Follow-up requires explicitly selected, same-account evidence. | No email/calendar send, CRM write, or arbitrary free-text/claim input through the current fixture CLI. |
| **Qualification** | `qualification` composes `qualification.assess`; CLI: `qualification`. | Inventories caller-mapped criteria and evidence for six event fields: event, deadline, consequence, accountable owner, service need, and next customer decision. Preserves conflicts and emits discovery questions. | Decision remains `not_determined`; stage readiness is unavailable. No approved B-FITT expansion, score, threshold, or stage gate is encoded. |
| **Opportunity Strategy** | `opportunity-strategy` composes `opportunity.strategy` with the actual Qualification assessor; CLI: `opportunity-strategy`. | Produces cited problem/value hypotheses, candidate offerings, uncertainty, discovery questions, and proposed next actions. | No approved business case, opportunity creation, stage readiness, or CRM advancement. |

These are evidence inventories, hypotheses, and drafts—not approvals or external actions. Results are
workflow-specific: `partial` is expected for fixture cases with unresolved policy/evidence gaps,
while other workflows can return `success` with warnings or gaps.

## Setup and fixture use

Use Node.js 20+ and npm from the repository root:

```text
npm install
npm test
```

The following commands exercise the documented local fixtures; they make no live research or
external calls:

```text
npm run prepare-first-meeting-v2 -- --account "Northstar Logistics" --mapping-fixture northstar-example --output json
npm run prepare-engagement -- --fixture engagement-initial --mode initial --output json
npm run prepare-engagement -- --fixture engagement-follow-up --mode follow_up --output json
npm run qualification -- --account "Northstar Logistics" --assessment-fixture northstar-provisional --output json
npm run opportunity-strategy -- --fixture northstar-example --output json
```

For Claude Code, each colleague needs a full checkout with dependencies, must open the repository
root, and can invoke the four installed project wrappers: `/prepare-first-meeting`,
`/prepare-engagement`, `/qualification`, and `/opportunity-strategy`. The v2 Account Intelligence
CLI exists, but there is intentionally no `/prepare-first-meeting-v2` wrapper in the installed
subset. Follow [the wrapper guide](AGENT_SKILLS.md) for all five documented smoke commands and
expected artifact/citation checks.

Read each CLI's JSON status, artifact, citations, warnings, errors, and exit code; do not convert a
partial, blocked, or failed result into success. Current CLI convention: `success` = 0, `partial`
with artifact = 2, `blocked` without artifact = 3, and `failed`/invalid command = 1. In particular,
the Northstar Qualification and Opportunity Strategy cases intentionally return partial artifacts.
All fixture facts and mappings are demonstrative, not live research, customer-confirmed facts, or
business-approved policy.

## Test and acceptance evidence

| Evidence | Result and interpretation |
|---|---|
| Integrated code suite, 2026-11-04: `npm test -- --test-reporter=dot` | **369 tests passed** after restoring the existing lockfile dependencies with `npm ci`; no test failures. This run preceded the docs-only handoff addition. |
| [Phase 1 acceptance record](PHASE1_SKILLS_PLAN.md) | Records an integrated full suite at **369/369** and focused Account Intelligence/v2/Engagement/contracts coverage at **67/67**. |
| Documentation/wrapper checks after adding this file | `node --test tests/agent-skills.test.js` passed **7/7**; all **18** local Markdown link targets in this handoff exist. The test checks wrapper frontmatter/assets, documented commands/flags/fixtures, links, citations, and five fixture CLI cases. |
| Earlier wrapper-task snapshot | Its **365-test** full-suite result was from an isolated wrapper snapshot, not a competing count for the current integrated tree; the wrapper-specific **7/7** result is also verified above. |
| Windows fixture smokes, 2026-11-03 | Five documented cases produced artifacts with citations covering their evidence IDs: Account Intelligence `success`/0 (4/4 citations; two `GAPS_PRESENT` warnings); Engagement initial and follow-up each `success`/0 (2/2 citations); Qualification `partial`/2 (`POLICY_UNAVAILABLE`); Opportunity Strategy `partial`/2 (`POLICY_UNAVAILABLE`, `EVENT_FIELDS_INCOMPLETE`, `CATALOGUE_NOT_APPROVED`). |
| Real Claude Code runtime | **Not verified.** Tests cover wrapper files and invoke their underlying CLIs, but actual slash-command discovery, Claude runtime execution, and model behavior still need a colleague's local check. |

The earlier 365 and current 369 totals came from different repository snapshots; they are not
additive. The current integrated-tree run and the latest acceptance summary agree at 369.

## Confirmed unknowns and pilot dependencies

Do not fill these gaps by inference from the demo or fixture catalogs:

- Business-approved BRD and full B-FITT dimensions, evidence expectations, unknown handling,
  scoring/thresholds, and any stage gates.
- Approved compelling-event taxonomy, evidence/freshness/verification rules, and what connects an
  event to an outcome.
- Canonical CRM lifecycle/stage mapping and QL/SAL order; the proposal and mockup differ.
- Approved offering catalogue, persona/authority definitions, messaging guidance, and named owners.
- Evaluation examples and measurable business success thresholds based on approved data.
- Host/runtime and identity design; source/record/field authorization; live connector ownership;
  approval UX; audit/telemetry; and policies for any CRM writes or outbound communications.

The versioned signal taxonomy, personas, offerings, Northstar examples, and qualification mappings
are provisional fixtures. There are no Salesforce, public-web, SharePoint, or other live source
connectors in the library. Production pilot readiness depends on the external decisions and
integrations above; the current result should not be described as a pilot or production completion.

## Recommended next steps

1. Have a colleague validate local Claude Code skill discovery and run the fixture workflow prompts
   from a full checkout; record runtime-specific findings separately from the CLI test evidence.
2. Obtain a business-approved BRD and owners' definitions for B-FITT, events, stages, offerings,
   personas, messaging, and evaluation before encoding policy.
3. Identify host/integration owners for runtime, identity and authorization, approved read sources,
   audit, and human approval controls.
4. Once scope and authorization are explicit, prioritize approved read-only adapters and evaluation
   against approved examples before considering any write/send behavior. This handoff does not start
   that implementation.

## Day-one resume guide and repository state

1. Read this document, [the Phase 1 plan](PHASE1_SKILLS_PLAN.md), and
   [the Claude wrapper guide](AGENT_SKILLS.md). Treat [the MVP handoff](MVP_HANDOFF.md) as
   historical context, not an active task list.
2. Run `git status --short`, inspect the current branch/log, and then run tests before editing.
   The verified starting snapshot for this handoff was `main` at `92da676`; this document has since
   been integrated on `main`. Recheck the present branch and worktree state before resuming.
3. Preserve the two user-owned original input files named above and do not replace original
   customer/demo presentation materials. Other task worktrees were intentionally preserved; do
   not assume every local branch is merged or clean.
4. This work is local only: no push, PR, or other remote action was performed or is implied. Obtain
   explicit permission before any remote operation.
