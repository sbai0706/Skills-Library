# Phase 1 Skills Plan

## Scope and evidence sources

The supplied presentation, `Relevantz_Sales_Agent_01_agent_readable.md`, identifies four Phase 1
specialist outcomes: **Account Intelligence, Engagement, Qualification, and Opportunity Strategy**.
The source is marked as a conceptual proposal, not an approved business requirements document.
Its sections 1–10 describe the proposed business vision and agent responsibilities. Sections 11–14
are explicitly suggested technical contracts, acceptance criteria, unresolved questions, and
implementation priorities; treat these as implementation recommendations, not approved policy.

`Relevantz_Claude_Cowork_Sales_Command_Agent_Mockup.html` is an interactive concept, not a source
of customer facts or business rules. It labels connectors as simulated, calls its records and
rankings illustrative/fabricated, and says no live systems are queried. Its screens are useful
examples of task prioritization, first-meeting preparation, outreach drafts, qualification
evidence, opportunity hypotheses, meeting-week views, and human review actions. The demo also
contains Deal Intelligence and broader command-center behaviors; those are not default Phase 1
library deliverables.

### Examples versus unresolved rules

| Topic | What the supplied materials show | What remains unapproved or unknown |
|---|---|---|
| B-FITT | The presentation requires an advisory, evidence-based B-FITT assessment but does not expand or define its criteria. The demo labels four items “Business fit,” “Financial context,” “Influence,” and “Timing.” | The full acronym/dimensions, required evidence, thresholds, unknown handling, scoring, and stage gates. Do not infer a missing dimension or invent a scoring model. |
| Compelling events | The presentation asks for event, deadline, consequence, accountable owner, service need, and next customer decision. The demo illustrates questions and examples such as acquisition, cost reduction, renewal risk, and launch. | Approved event taxonomy, minimum evidence, freshness, and what qualifies as verified. Demo examples are not policy. |
| Lifecycle | The presentation names Contact, SAL, Qualified Lead (QL), Opportunity, and Win, but its objective also names QL-to-SAL conversion. The demo uses Lead and varies stage labels/order across screens. | Canonical CRM stages, mappings, QL/SAL order, eligibility, and advancement rules. Resolve the source's sequence mismatch against the BRD/Salesforce configuration before recommending or changing a stage. |
| Offerings and personas | The demo shows sample service-fit hypotheses and stakeholder roles; repository vocabularies are provisional. | Approved service catalogue, role/persona definitions, account ownership, and approval responsibilities. Do not state a hypothesis as a verified capability or customer need. |
| Actions and integrations | The proposal describes Salesforce, approval gates, Cowork, and other data sources; the demo offers simulated CRM/share/deck actions. | Host/runtime, identity, authorization, connectors, data access, approval UX, and actual execution are external dependencies, not library behavior. |

## Skills-library boundary

Deliver portable contracts, deterministic functions, fixtures, and tests. Do not implement the host
agent runtime, Cowork UI, production identity or authorization, live CRM/source connectors, actual
CRM mutations, or message sending in this repository. Outputs that could later drive an external
action remain proposals/drafts. Reference data without business sign-off stays explicitly
provisional; missing rules are represented as unknowns or caller-supplied definitions, not
fabricated defaults.

## Current foundation and status

| Area | Current state |
|---|---|
| Shared evidence foundation | `account.resolve`, `evidence.retrieve`, `evidence.normalize`, `gap.detect`, `artifact.render`, and fixture-backed `prepare-first-meeting` remain the common evidence/provenance base. The v1 first-meeting schema, output, and renderer are unchanged by the additive v2 path. No live integration is provided. |
| Account Intelligence | Callable `signal.extract`, `stakeholder.map`, and `offering.match` skills compose in [`prepare-first-meeting-v2`](../workflows/prepare-first-meeting-v2/WORKFLOW.md). The workflow semantically validates enrichment IDs, account scope, registry IDs, gap support, and classification ceiling before rendering and verifies citations afterward. All enrichment mappings are caller supplied; absence remains unknown. Stakeholder output explicitly marks the role mapping `caller_hypothesis` and preserves visible cited excerpts without treating overlap as relationship verification. |
| Engagement | Callable `engagement.draft` composes in [`prepare-engagement`](../workflows/prepare-engagement/WORKFLOW.md) for initial outreach/meeting drafts and follow-up drafts. Follow-up requires explicitly selected, same-account evidence. Outputs are proposals only and are never sent. |
| Qualification | Callable `qualification.assess` composes in the [`qualification` workflow](../workflows/qualification/WORKFLOW.md). It inventories caller-mapped criteria and six event fields, preserves visible conflicts, and emits discovery questions. It always leaves the qualification decision undetermined and stage readiness unavailable; no B-FITT expansion or threshold is embedded. |
| Opportunity Strategy | Callable `opportunity.strategy` composes in [`opportunity-strategy`](../workflows/opportunity-strategy/WORKFLOW.md) with the actual Qualification assessor. It produces cited problem/value hypotheses, mapped offering candidates, uncertainty, discovery, and proposed next actions. Stage readiness/opportunity creation remain unavailable. |
| Four Phase 1 outcomes | **All four Skills Library slices are implemented and fixture-backed.** This is repository-scope completion, not a business-validated customer Phase 1 pilot. The outputs are evidence inventories, drafts, and hypotheses, not approvals or external actions. |
| Reference vocabularies and examples | `reference/signal-taxonomy.yaml`, `reference/personas.yaml`, and `reference/offerings.yaml` are versioned provisional fixtures. Example Northstar/qualification mappings demonstrate interfaces only; they are not automated source research, customer facts, approved criteria, or catalogue sign-off. |
| External scope | Live source discovery, production host/runtime, identity/authorization, CRM connectors or writes, message sending, approval UX, and other integrations remain outside this Skills Library implementation. |

## Implemented deliverables and portable invocations

These commands use checked-in fixtures and the deterministic fixture claim extractor. They make no
network/model calls and do not send messages or mutate CRM state.

| Outcome | Skill/workflow entry points | Portable command |
|---|---|---|
| Account Intelligence | `signal.extract`, `stakeholder.map`, `offering.match`; `prepareFirstMeetingV2` | `npm run prepare-first-meeting-v2 -- --account "Northstar Logistics" --mapping-fixture northstar-example --output json` |
| Engagement initial | `engagement.draft`; `prepareEngagement` | `npm run prepare-engagement -- --fixture engagement-initial --mode initial --output json` |
| Engagement follow-up | `engagement.draft`; `prepareEngagement` | `npm run prepare-engagement -- --fixture engagement-follow-up --mode follow_up --output json` |
| Qualification | `assessQualification`; `runQualification` | `npm run qualification -- --account "Northstar Logistics" --assessment-fixture northstar-provisional --output json` |
| Opportunity Strategy | `assessOpportunityStrategy`; `runOpportunityStrategy` | `npm run opportunity-strategy -- --fixture northstar-example --output json` |

`northstar-example` and `northstar-provisional` are illustrative fixture mappings over repository
claims. They do not prove account facts, discover source material, approve a business definition,
or assert a service fit. Status and exit code are workflow-specific: gaps or warnings do not
automatically make a result `partial`. In the fixture cases below, Qualification and Opportunity
Strategy return `partial` with exit code `2` because their advisory policy/event/catalogue gaps affect
those outputs; Account Intelligence and Engagement return `success` with exit code `0` despite
warnings or remaining evidence gaps. A partial result still includes a clearly qualified artifact.

### Windows fixture smoke results (2026-11-03)

The commands above were run from the repository root with JSON output. Each returned an artifact;
the listed unique claim citations were present in that artifact and covered all result `evidence_ids`.
Expected partial exit code `2` is a usable outcome, not a CLI failure.

| Smoke case | Status / exit | Artifact and citations | Warnings / errors |
|---|---|---|---|
| Account Intelligence v2 | `success` / `0` | Present; 4 unique cited claims for 4 evidence IDs | `GAPS_PRESENT` ×2 / none |
| Engagement initial | `success` / `0` | Present; 2 unique cited claims for 2 evidence IDs | none / none |
| Engagement follow-up | `success` / `0` | Present; 2 unique cited claims for 2 evidence IDs | none / none |
| Qualification | `partial` / `2` | Present; 1 unique cited claim for 1 evidence ID | `POLICY_UNAVAILABLE` / none |
| Opportunity Strategy | `partial` / `2` | Present; 1 unique cited claim for 1 evidence ID | `POLICY_UNAVAILABLE`, `EVENT_FIELDS_INCOMPLETE`, `CATALOGUE_NOT_APPROVED` / none |

## Sequence and acceptance gates

### Completed library delivery sequence

1. **Account Intelligence — implemented:** explicit mapping skills plus additive v2 first-meeting workflow.
2. **Engagement — implemented:** evidence-grounded initial and follow-up draft workflow.
3. **Qualification — implemented:** caller-mapped criterion/event evidence inventory with no qualification decision.
4. **Opportunity Strategy — implemented:** qualification-composed hypotheses and discovery with stage readiness unavailable.

The sequence records Skills Library delivery only. The four slices do not constitute a complete
customer pilot or business approval; see the unresolved dependencies below.

### Measurable gates

- Every emitted customer/account fact has a same-account normalized claim reference; tests cover missing, malformed, conflicting, and foreign-account evidence.
- Unsupported or unavailable facts remain explicit gaps/unknowns. Conflicts are retained rather than resolved by the library.
- Every v2 signal/persona/offering ID is checked against the supplied versioned registry; provisional registry status is accepted without implying approval.
- Signal, stakeholder, and offering mappings are caller-provided. Empty mappings preserve unknown coverage; the sample Northstar mapping fixture is illustrative and does not claim automated research or customer-approved policy.
- Enrichment references resolve to actual normalized claims; `claim_ids` and `evidence_ids` identify the same set. Safe diagnostics contain no withheld claim ID or text.
- Enrichment linked to evidence above the output classification ceiling is rejected by the v2 semantic entry point. The legacy v1 renderer's ordinary-claim filtering behavior is unchanged.
- Each implemented workflow has deterministic success, empty/sparse, missing-input, conflicting-evidence, and failure coverage. Fixture/replay tests make no network calls.
- Library outputs are drafts/advice only: tests demonstrate zero actual message sends and zero live CRM mutations.
- No stage, B-FITT score, event threshold, business approval, offering capability, or customer-specific claim is asserted without an approved definition or evidence.
- After the Account Intelligence role-hypothesis and optional-v2-enrichment corrections, `npm test` passed **369 tests, 0 failed**. The focused command `node --test tests/account-intelligence-skills.test.js tests/prepare-first-meeting-v2.test.js tests/engagement.test.js tests/account-intelligence-contracts.test.js` passed **67 tests, 0 failed**. The Windows fixture smoke outcomes are recorded above; documentation-only edits do not change these code-test results.

## Dependencies and decisions still needed

### Business-owned definitions and data

- Full B-FITT criteria/dimensions (including the unexplained “B-FITT” versus four demo labels), evidence expectations, unknown handling, and any approved thresholds.
- Compelling-event categories/types, verification/freshness rules, and criteria for connecting an event to a business outcome.
- Canonical lifecycle/stage names and mappings; QL/SAL progression, three-month potential, opportunity eligibility, and approval gates.
- Approved Relevantz offerings and service-to-need mapping, plus persona/ownership definitions and messaging guidance.
- Approved evaluation examples and measurable business success thresholds; demo records and sample metrics are not customer data.

### Host/application dependencies (outside this repository)

- Cowork/orchestrator runtime, authenticated identity, role/record/field authorization, and audit/telemetry.
- Salesforce read/write connectors, object/field mappings, production data access, approval UI, and control of mutations.
- Reconcile the proposal's allowance for approved routine-field synchronization with the library architecture's human-approval requirement for Salesforce changes; this plan assumes neither host policy.
- Any Teams/calendar/meeting-note, OneDrive/collateral, Draup, Sales Navigator, or public-source connectors, including licenses, access policy, freshness, and source approval.
- Human approval and delivery channels for external communications and customer-facing artifacts.

These are dependencies for a production pilot, not blockers to building deterministic library contracts and fixture-backed flows with explicit unknowns.
