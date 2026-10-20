# Sales Copilot — Skills Foundation

Minimal, working foundation for Sales Copilot skills, plus the first implemented skill:
`account.resolve`. It intentionally implements only what this task needs.

Architecture reference: [Sales_Skills_Library_Architecture_v2.md](Sales_Skills_Library_Architecture_v2.md).
That document describes the eventual direction; this repository implements only the
shared contracts and one skill.

## Requirements

- Node.js 20 or newer (developed on Node 24)
- npm

## Run the tests

```bash
npm install
npm test
```

`npm test` runs `node --test`, which discovers every file under `tests/`. No external
services, credentials, or network calls are required.

## Layout

```text
schemas/
  skill-result.schema.json   Shared result envelope for every skill
  evidence.schema.json       Common evidence record for later skills
  error.schema.json          Structured error entry
  evidence.example.json      One valid evidence record used by the tests
  index.js                   Ajv compilation and validate(name, value)

adapters/
  account-adapter.js         Adapter interface, JSDoc types, record validation
  fixture-account-adapter.js In-memory adapter used by tests and local demos

skills/account-resolve/
  SKILL.md                   Agent-facing instructions
  skill.yaml                 Machine-readable contract
  index.js                   Skill entry point (resolveAccount)
  match.js                   Deterministic scoring and credibility rules
  normalize.js               Name/domain normalization
  search.js                  Adapter call wrapper and response normalization

fixtures/
  clear-account/             accounts.json + expected.json
  ambiguous-account/
  missing-account/

reference/
  first-meeting-questions.yaml   Draft reference questions for the future first-meeting workflow

tests/
  schemas.test.js            Envelope, evidence, and error schema tests
  account-resolve.test.js    Skill behavior, fixture cases, adapter failures
  reference.test.js          Structure and integrity of the reference questions
```

## Using the skill in code

```js
import { resolveAccount } from "./skills/account-resolve/index.js";
import { createFixtureAccountAdapter } from "./adapters/fixture-account-adapter.js";

const adapter = createFixtureAccountAdapter({ fixture: "ambiguous-account" });
const result = await resolveAccount({ account_reference: "Meridian Health" }, { adapter });

// result.status === "blocked"
// result.data.outcome === "ambiguous"
// result.data.candidates has both credible accounts
```

The skill depends only on `{ name, searchAccounts(query, options) }`, so a Salesforce or
HTTP adapter can replace the fixture adapter without changing the skill or its contract.

## Design decisions

- **Node.js + `node:test`** because no stack existed yet and the built-in runner needs no
  framework. Only three small dependencies are used: `ajv` and `ajv-formats` (schema
  validation) and `yaml` (reference data).
- **`additionalProperties: false`** on all contracts so extra fields fail loudly instead of
  drifting.
- **Skill directories use kebab-case** (`account-resolve`) while the contract name stays
  namespaced (`account.resolve`), matching the architecture document's skill identifiers.
- **No workflow engine, registry, router, or orchestrator.** `resolveAccount` is a function.
- **Adapters never throw for runtime failures**; they return `{ok:false, error}` so the skill
  can map failures to stable error codes.
- **Matching is deterministic and conservative**: normalization, token coverage/precision
  scoring, a fixed 0.6 credibility floor, and "more than one credible candidate" always
  producing a blocked result.
- **Schema pattern**: `status` and `outcome` are separate. `status` is the shared envelope
  lifecycle; `data.outcome` is the skill-specific business outcome.

## Assumptions

1. Account matching is name/domain based. No aliases, subsidiaries, or parent-company
   relationships are modeled.
2. The adapter is responsible for authorization, record-level scope, pagination, and
   rate limiting. The skill only forwards and maps errors.
3. `account_reference` is free text entered by a user. A bare domain is treated as a domain;
   anything else is treated as an account name.
4. Reference questions are drafts owned by `TBD`; they are not approved business rules.
5. Timestamps are UTC ISO-8601. `trace_id` is generated per skill execution.
6. Fixtures and example domains use the reserved `.example` TLD; nothing calls a live service.

## Open business questions

1. Who owns and approves the first-meeting question set (`business_owner: TBD`)?
2. Which roles may resolve accounts, and what record scope applies (`permitted_roles` is provisional)?
3. Should inactive or archived accounts be excluded from matching? The adapter currently
   passes them through and the skill does not filter them.
4. What is the authoritative identifier set for an account (domain, DUNS, ERP ID, Salesforce ID)?
5. Should a fuzzy match require explicit user confirmation before downstream evidence retrieval?
   The skill emits a `FUZZY_MATCH` warning but still returns `success`.
6. What freshness window applies to the account directory cache, if one is added?

## Deferred work

Evidence retrieval, evidence normalization, gap detection, artifact rendering, Salesforce
connectivity, meeting briefs, B-FITT, qualification, CRM writeback, approvals, model-driven
routing, UI, and orchestration are intentionally not implemented. Only the interfaces needed
to keep `account.resolve` independent of the fixture adapter exist.
