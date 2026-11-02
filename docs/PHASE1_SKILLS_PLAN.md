# Phase 1 Skills Plan

## Client Phase 1 agents and expected outputs

The client deck sets Phase 1 scope as four agents. This plan records their expected outputs at the skills-library boundary:

| Client agent | Expected output |
|---|---|
| Account Intelligence | Account context, evidence-linked signals, known stakeholder roles, and provisional offering-alignment hypotheses; gaps and provenance remain visible. |
| Engagement | A supported engagement preparation artifact using approved channels, audience, and messaging rules. |
| Qualification | Evidence-backed qualification inputs and explicit unknowns, subject to confirmed qualification criteria. |
| Opportunity Strategy | Evidence-backed opportunity strategy inputs and options, subject to confirmed business rules. |

The skills library supplies portable contracts and deterministic capabilities. It does not provide a client agent runtime or production authorization boundary.

## Mapping from Phase 1 to skills-library capabilities

| Phase 1 area | Skills-library mapping | Current state |
|---|---|---|
| Account Intelligence | `account.resolve`, `evidence.retrieve`, `evidence.normalize`, `gap.detect`, and `artifact.render`; this contract layer adds signal, stakeholder-map, offering-match, and additive first-meeting-brief-v2 contracts. | Foundation complete; contract layer in progress. No new extractor or workflow is part of this work. |
| Qualification | Future evidence-grounded qualification contracts and capability, with confirmed criteria. | Not started. |
| Opportunity Strategy | Future opportunity strategy contracts and capability, with confirmed business rules. | Not started. |
| Engagement | Future engagement preparation and communication capabilities under approved messaging and channel constraints. | Not started. |

## Status

- **Complete:** `account.resolve`, `evidence.retrieve`, `evidence.normalize`, `gap.detect`, `artifact.render`, `prepare-first-meeting`, portable CLI, and replay tests.
- **In progress:** Account Intelligence contract definitions and provisional reference vocabularies. All new reference data is marked provisional and needs business review.
- **Not started:** `signal.extract`, `stakeholder.map`, `offering.match`, `prepare-first-meeting-v2`, Qualification, Opportunity Strategy, and Engagement implementations.
- **Deferred:** Deal Intelligence is unresolved and deferred pending client scope clarification.

## Sequencing

Proceed in this order:

1. Account Intelligence
2. Qualification
3. Opportunity Strategy
4. Engagement

This sequencing reflects the client's Phase 1 framing. Earlier repository documents that label any of these areas as Phase 2 or Phase 3 are superseded by that framing.

`collateral.select` is a should-have capability and does not block Phase 1. Collateral catalog/reference data is outside this contract task.

## Business confirmation gates

The following require confirmation by the business owner and/or an approved business requirements document before implementation:

- B-FITT criteria, definitions, thresholds, and handling of unknown evidence.
- Compelling-event types and any rules for interpreting them.
- Opportunity stage definitions, eligibility, and recommendation rules.
- Approved offering definitions and the meanings of signal and persona vocabularies.

The reference files created for the Account Intelligence contract layer are provisional placeholders, not approved policy. In particular, the offering entries are explicitly marked for business review. Do not use these placeholders to make customer-specific claims or business recommendations.

## Pilot dependencies outside the skills library

Live Salesforce connectivity, production role-based access control (RBAC), approval user experience, and operational telemetry are outside this repository's skills-library scope. They remain direct dependencies for a live pilot and must be supplied and governed by the client host/application environment.
