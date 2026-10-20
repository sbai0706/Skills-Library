# Sales Copilot: Skills Library Architecture

**Status:** Implementation reference  
**Architecture:** One orchestrator, reusable skills, workflow definitions, policy gates, and connector adapters  
**Scope:** Phase 1 unless marked otherwise

## 1. Purpose

The Sales Copilot is one governed system, not a collection of independent agents. User-facing outcomes such as meeting preparation, qualification, and opportunity shaping are implemented as **workflows** that compose shared **skills**.

The architecture separates:

- business rules from execution logic;
- reusable capabilities from user-facing workflows;
- reasoning from connector operations;
- proposed actions from approved execution;
- generated claims from their supporting evidence.

The design borrows the useful discipline of spec-driven development: version the rules, define explicit contracts, compose small capabilities, and test outputs against stable acceptance criteria. It should not copy software-development terminology where it does not help implementation.

## 2. Architecture

```text
                         Governance
                             |
User request -> Orchestrator -> Workflow -> Skills
                             |          |
                             |          +-> Reference data
                             |          +-> State and provenance
                             |          +-> Connector adapters
                             |
                             +-> Authorization and approval gates
                             +-> Observability and evaluations
```

### Components

- **Governance:** Non-negotiable behavior and data-handling rules.
- **Reference data:** Business-owned definitions such as B-FITT, stages, offerings, personas, and compelling-event types.
- **Skills:** Reusable business capabilities with typed, testable contracts.
- **Workflows:** Ordered compositions of skills that produce a user-facing outcome.
- **Adapters:** Authenticated operations against Salesforce, SharePoint/OneDrive, Teams, Draup, public web sources, and any future systems.
- **Policies and gates:** Authorization, evidence, data classification, approval, and safe execution controls.
- **State and provenance:** Evidence records, workflow state, approval state, cache entries, and audit history.
- **Evaluations and observability:** Quality, safety, latency, cost, and operational telemetry.

Adapters and gates are cross-cutting runtime dependencies. They are not final steps in a linear pipeline.

## 3. Governing rules

Every workflow and skill inherits these rules:

1. **Evidence or explicit uncertainty.** Every factual claim must link to evidence. Unsupported content must be labeled as an assumption or omitted.
2. **Unverified is valid.** Never invent a compelling event, budget, stakeholder role, deadline, or customer intent.
3. **No autonomous Salesforce changes.** The system creates field-level change sets. Human approval is required before execution, especially for stage, owner, opportunity, pricing, contract, and commercial fields.
4. **No autonomous external communication.** Emails, messages, and decks remain drafts until a user approves the appropriate action.
5. **Approved collateral only.** Customer-facing material must be current and approved for the intended use.
6. **Authorization is enforced at runtime.** Prompts do not provide security. Adapters and policy checks must enforce record, field, role, and data-classification restrictions.
7. **Deterministic where practical.** Retrieval, validation, calculations, diffs, and policy checks should not depend on free-form model judgment when deterministic logic is available.
8. **Provider-neutral contracts.** Skill interfaces must not depend on a specific model vendor.
9. **Business definitions require owners.** Material inferred from a mockup or slide remains provisional until an authorized business owner approves it.
10. **Auditable execution.** Recommendations, approvals, connector actions, failures, and evidence links must be traceable.

## 4. Reference data

Reference data is versioned and business-owned. It is not implemented as skills.

```text
reference/
  bfitt.yaml
  compelling-events.yaml
  evidence-questions.yaml
  offerings.yaml
  stages.yaml
  personas.yaml
  output-templates/
```

Each reference file must declare:

- version and status;
- business owner;
- approver and approval date;
- source documents;
- effective date;
- change history.

Until confirmed, the interpretation of B-FITT as **Business fit, Financial context, Influence, and Timing** must be marked provisional. The same rule applies to any offering, stage rule, or taxonomy inferred from demonstration material rather than an approved business source.

## 5. Skills

A skill performs one reusable business capability. It does not represent an entire user journey and does not directly implement connector authentication or transport.

### Phase 1 capability set

#### Identity and evidence

- `account.resolve`: Resolve a user reference to the correct Salesforce account and expose ambiguity.
- `evidence.retrieve`: Retrieve permitted internal or external evidence for a stated question.
- `evidence.normalize`: Convert source records into the common evidence schema, deduplicate them, and preserve provenance.
- `signal.extract`: Identify candidate buying signals using the approved compelling-event taxonomy.
- `gap.detect`: Compare available evidence with required evidence and return explicit gaps.

#### Account and engagement reasoning

- `stakeholder.map`: Describe known decision participants, influence evidence, and coverage gaps without inventing roles.
- `offering.match`: Rank approved Relevantz offerings against evidenced customer needs.
- `collateral.select`: Select current, approved collateral for the audience and use case.
- `communication.draft`: Draft audience-specific outreach or follow-up without sending it.
- `artifact.render`: Render an approved template such as a brief, email, deck outline, or handoff note.

#### Qualification and opportunity reasoning

- `event.validate`: Evaluate a proposed compelling event against the required evidence questions.
- `qualification.assess`: Produce an advisory B-FITT assessment with evidence and gaps for each criterion.
- `stage.recommend`: Recommend advance, hold, or clarify based on approved stage rules.
- `opportunity.shape`: Convert validated evidence into an opportunity hypothesis, next customer decision, and discovery needs.
- `action.rank`: Rank candidate actions using an explicit scoring function and documented inputs.

#### Controlled action preparation

- `change-set.compose`: Produce a field-level proposed change with its rationale, evidence IDs, original values, and approval requirements.

Phase 2 may add deal health, commercial insight, mutual action planning, and delivery handover capabilities after scope and data access are confirmed.

## 6. Workflows

Workflows are user-facing outcomes composed from skills. The orchestrator selects an approved workflow; it must not invent unrestricted skill chains at runtime.

### Phase 1 workflows

#### `prepare-first-meeting`

Resolves the account, retrieves and normalizes evidence, extracts signals, maps stakeholders, matches offerings, detects gaps, and renders a cited research pack.

#### `draft-targeted-outreach`

Uses verified account evidence, stakeholder context, and offering fit to create a draft outreach sequence. It never sends messages.

#### `prepare-followup-meeting`

Combines prior activity, changed evidence, unresolved gaps, stakeholder context, and meeting-specific questions into a preparation brief.

#### `process-meeting-followup`

Extracts supported outcomes from meeting notes, prepares an internal recap and external draft, and optionally composes proposed Salesforce changes.

#### `assess-qualification`

Runs B-FITT assessment, compelling-event validation, gap detection, and stage recommendation. Any proposed Salesforce update becomes an approval request.

#### `shape-opportunity`

Uses validated qualification evidence to produce an opportunity hypothesis, service fit, next customer decision, discovery plan, and internal handoff.

#### `prepare-customer-deck`

Selects approved collateral and renders a customer-specific deck outline. It must preserve source asset IDs, approval status, and version.

### Routing

Routing should be hybrid:

1. deterministic handling for explicit commands and approval actions;
2. model-assisted intent extraction into a strict schema;
3. policy-based selection from registered workflows;
4. clarification only when a critical identifier or requested outcome is ambiguous;
5. authorization and input validation before execution.

The router selects workflows. Skills remain internal implementation units.

## 7. Connector adapters

Adapters implement system access, not business reasoning.

Examples:

```text
salesforce.get_account
salesforce.search_accounts
salesforce.get_activities
salesforce.get_opportunities
salesforce.apply_approved_change_set
sharepoint.search_assets
sharepoint.get_asset_metadata
teams.get_calendar
public_web.search
```

Each adapter must handle authentication, authorization, pagination, retries, rate limits, field filtering, normalized errors, and audit logging.

The operation `salesforce.apply_approved_change_set` may execute only when it receives a valid, unexpired approval for the exact proposed change and the source record has not changed since the proposal was created.

## 8. Common contracts

### Evidence record

```yaml
claim_id: clm_123
claim: Customer announced a target migration date.
source_type: crm_activity | company_site | news | third_party
source_uri: null
source_record_id: null
account_id: sf_account_id
published_at: null
retrieved_at: 2026-10-19T14:00:00Z
excerpt: Supporting source passage or normalized record content.
confidence: high | medium | low
verification_status: direct | corroborated | inferred | conflicting
access_classification: public | internal | confidential
```

Evidence must remain linked to the claim it supports. A source list appended to an output without claim-level linkage is insufficient.

### Change set

```yaml
proposal_id: change_123
record_id: sf_record_id
record_version: source_last_modified_timestamp
created_by: user_or_workflow_id
created_at: 2026-10-19T14:00:00Z
expires_at: 2026-10-20T14:00:00Z
changes:
  - field: StageName
    from: SAL
    to: QL
    rationale: Required evidence is present.
    evidence_ids: [clm_123, clm_456]
approval:
  status: awaiting_approval
  required_role: sales_owner
```

Approval state follows:

```text
drafted -> validated -> awaiting_approval
        -> approved | rejected | amended | expired
        -> execution_attempted
        -> executed | failed
```

### Skill specification

Every skill directory must include a concise contract using this structure:

```yaml
skill: qualification.assess
version: 0.1.0
status: draft | reviewed | live
business_owner: TBD
intent: Produce an advisory B-FITT assessment with evidence and gaps.

when_to_use:
  - A qualification decision is being considered.
when_not_to_use:
  - Account identity is unresolved.

inputs:
  required: [account_id]
  optional: [lead_id, meeting_note_ids, target_stage]

outputs:
  schema: qualification-assessment.schema.json

dependencies:
  skills: [event.validate, gap.detect]
  reference: [bfitt.yaml, stages.yaml]
  adapters: [salesforce.get_activities]

authorization:
  permitted_roles: [sales_partner, sales_owner]
  record_scope: account_team_accounts
  permitted_fields: []
  prohibited_fields: []

procedure:
  - Load permitted evidence.
  - Evaluate each approved B-FITT criterion.
  - Return evidence or an explicit gap for every criterion.
  - Validate the compelling event.
  - Produce an advisory recommendation.

rules:
  - Do not infer budget availability without evidence.
  - Do not invent a compelling event.
  - Do not express B-FITT as a numeric score unless the business definition changes.

gates:
  - schema_valid
  - authorized
  - evidence_complete_or_gap_declared

evals:
  suites: [golden, negative, adversarial, authorization]
```

A prompt may implement part of a skill, but the prompt is not the contract.

## 9. MVP delivery

Build the MVP as executable vertical slices rather than a nominal count of skills.

### Slice 1: First-meeting preparation

Required capabilities include account resolution, Salesforce read access, evidence retrieval and normalization, signal extraction, stakeholder mapping, offering matching, gap detection, and brief rendering.

### Slice 2: Qualification assessment

Required capabilities include meeting-note ingestion, provisional or approved B-FITT definitions, event validation, gap detection, stage recommendation, change-set composition, and approval state.

### Slice 3: Opportunity shaping

Required capabilities include validated qualification context, opportunity hypothesis, next-decision recommendation, discovery planning, and internal handoff rendering.

A slice is complete only when its workflow runs end to end with real authorization, provenance, failure handling, and evaluations. A mock connector or unapproved business definition must be explicitly labeled.

## 10. Evaluation and operations

Initial evaluation should include:

- 10–15 development cases;
- 20–30 held-out regression cases when enough approved examples exist;
- negative cases with no valid compelling event;
- conflicting and stale evidence;
- duplicate or ambiguous accounts;
- unauthorized record and field access;
- stale or unapproved collateral;
- prompt injection in retrieved content;
- concurrent Salesforce edits during approval.

Track at least:

- schema validity;
- citation completeness and correctness;
- unsupported-claim rate;
- compelling-event false positives;
- required-gap recall;
- workflow routing accuracy;
- authorization and policy violations;
- human usefulness rating;
- latency, connector failures, token usage, and cost.

Evidence should be cached by account, source, question, and freshness window. Cache entries must retain access classification and must not bypass current authorization checks.

## 11. Suggested repository structure

```text
sales-copilot/
  governance/
    constitution.md
    data-handling.md
    approval-policy.md
    source-policy.md
  reference/
    bfitt.yaml
    compelling-events.yaml
    evidence-questions.yaml
    offerings.yaml
    stages.yaml
    personas.yaml
    output-templates/
  skills/
    account-resolve/
    evidence-retrieve/
    evidence-normalize/
    signal-extract/
    gap-detect/
    stakeholder-map/
    offering-match/
    collateral-select/
    event-validate/
    qualification-assess/
    stage-recommend/
    opportunity-shape/
    change-set-compose/
    artifact-render/
  workflows/
    prepare-first-meeting.yaml
    draft-targeted-outreach.yaml
    prepare-followup-meeting.yaml
    process-meeting-followup.yaml
    assess-qualification.yaml
    shape-opportunity.yaml
    prepare-customer-deck.yaml
  adapters/
    salesforce/
    sharepoint-onedrive/
    teams/
    draup/
    public-web/
  policies/
    authorization/
    approval/
    data-classification/
  schemas/
    evidence.schema.json
    change-set.schema.json
    workflow-result.schema.json
  evals/
    development/
    regression/
    negative/
    adversarial/
```

## 12. Decisions required before implementation

1. Confirm the B-FITT definition and assign its business owner.
2. Confirm the approved offering catalogue and whether Salesforce is represented as an offering.
3. Decide whether Deal Intelligence belongs in Phase 1 or Phase 2.
4. Define role, record, and field access for each persona.
5. Confirm available Salesforce, SharePoint/OneDrive, Teams, Draup, and Sales Navigator interfaces and licensing.
6. Define who may approve each change type and how long approvals remain valid.
7. Identify approved data that may be sent to the selected model provider.
8. Select reviewed historical cases for development and regression evaluation.
9. Define freshness windows for CRM data, public evidence, and collateral.
10. Confirm the system of record for workflow state, evidence, and audit history.

## 13. First implementation task

Implement one workflow end to end before expanding the library. `assess-qualification` is the preferred starting point if Salesforce activity data and approved B-FITT rules are available; otherwise begin with `prepare-first-meeting` in read-only mode.

The first implementation must establish the reusable evidence schema, authorization checks, skill contract template, workflow state, evaluation harness, and audit model. Later skills should reuse these foundations rather than define parallel conventions.
