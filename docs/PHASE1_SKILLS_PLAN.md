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
| Shared evidence foundation | `account.resolve`, `evidence.retrieve`, `evidence.normalize`, `gap.detect`, `artifact.render`, and the fixture-backed `prepare-first-meeting` workflow exist. They provide a reusable, evidence-linked base; they do not supply a live integration or four finished Phase 1 agents. |
| Account Intelligence contracts and implementation | `signal.extract`, `stakeholder.map`, `offering.match`, and additive `prepare-first-meeting-v2` are callable, deterministic, fixture-backed implementations. Mappings must be supplied by the caller and resolve to normalized same-account evidence within the classification ceiling. The v2 workflow calls `validateFirstMeetingBriefInputV2(value, { referenceRegistry })` before rendering enrichment and checks final citations. It also checks gap supporting IDs and safe failure behavior. The v1 schema, output, and renderer remain unchanged. This is not automated research, a verified business catalogue, or an authorization boundary. |
| Four Phase 1 outcomes | Account Intelligence has a complete fixture-backed library slice with explicit mapping inputs and visible unknowns. Engagement, Qualification, and Opportunity Strategy still need practical skill/workflow implementations. No complete implementation of all four outcomes is claimed. |
| Reference vocabularies | `reference/signal-taxonomy.yaml`, `reference/personas.yaml`, and `reference/offerings.yaml` are versioned provisional fixtures with TBD ownership/approval. They are not approved business policy. |
| Out of default scope | Deal Intelligence, nurture/collateral selection, production integrations, and host-side execution are not mandatory library work in this plan. Add them only after explicit scope and dependency decisions. |

## Practical Phase 1 deliverables

1. **Account Intelligence:** Complete an evidence-grounded account/first-meeting preparation workflow. Include normalized account context, evidence-linked signals, only evidenced stakeholder roles, offering-fit hypotheses, explicit gaps/conflicts, source/provenance IDs, and questions for discovery. Do not invent account facts.
2. **Engagement:** Produce reviewable outreach, meeting-preparation, and follow-up drafts grounded in supplied evidence and approved messaging inputs. Do not send communications.
3. **Qualification:** Produce advisory criterion-by-criterion evidence and unknowns, plus discovery questions. Use an approved B-FITT definition when supplied; otherwise require an explicitly provisional/caller-supplied definition or return the criteria as unresolved. Do not invent weights or a pass threshold.
4. **Opportunity Strategy:** Produce an evidence-linked opportunity hypothesis, event assessment, service-fit hypothesis, remaining discovery, and next customer decision. Stage or opportunity-creation recommendations remain unavailable until their business rules are supplied; no CRM mutation is performed.

Keep the first delivery small: reusable contracts and deterministic helpers, one end-to-end fixture-backed workflow per outcome, concise skill/workflow documentation, and targeted positive/negative/replay tests. Reuse the current evidence, gap, result, and adapter conventions rather than creating parallel envelopes or abstractions.

## Sequence and acceptance gates

### Sequence

1. Complete Account Intelligence contracts and the fixture-backed first-meeting slice (this
   library milestone is implemented; mappings remain caller-provided and business vocabularies
   provisional).
2. Add Engagement drafting and meeting/follow-up preparation over the same evidence boundary.
3. Add Qualification with explicit unknowns and caller-supplied criteria until business-owned B-FITT/event rules exist.
4. Add Opportunity Strategy with evidence-linked hypotheses; keep stage/creation rules as unresolved inputs until approved.

This sequence is a library delivery recommendation, not a claim that the source proposal mandates a technical order.

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
