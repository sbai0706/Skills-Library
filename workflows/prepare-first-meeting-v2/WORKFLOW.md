# prepare-first-meeting-v2

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Compose the existing first-meeting workflow with three callable, explicit-mapping skills:

```text
workflow.input
  -> prepare-first-meeting
  -> signal.extract
  -> stakeholder.map
  -> offering.match
  -> validateFirstMeetingBriefInputV2
  -> artifact.render-v2
  -> provenance.check-v2
```

The v1 workflow, schema, and renderer are unchanged. The v2 consumer requires semantic validation
before adding any Account Intelligence section and verifies the final citations before returning the
artifact.

## Input and invocation

The workflow accepts `schemas/prepare-first-meeting-v2-input.schema.json`:

```json
{
  "workflow_input": {
    "account_reference": "Northstar Logistics",
    "classification_ceiling": "internal"
  },
  "annotations": {
    "signals": [
      {
        "signal_type_id": "sigcat_technology_change",
        "claim_ids": ["clm_fd803734df7d6b56"]
      }
    ],
    "stakeholders": [
      {
        "display_name": "Priya Raman",
        "persona_id": "per_operations_leader",
        "role_evidence": "Priya Raman, Director of Operations",
        "claim_ids": ["clm_5e66a71c957aaada"]
      }
    ],
    "offerings": [
      {
        "offering_id": "off_placeholder_advisory",
        "claim_ids": ["clm_e5754f979c134d33"]
      }
    ]
  }
}
```

Each claim ID must be an actual normalized claim from the resolved account and within the workflow
classification ceiling. Signal, persona, and offering IDs must exist in the supplied versioned
registry. Stakeholder mappings also require the name and exact role excerpt to occur in a cited claim
excerpt. Offering signal IDs, when supplied, must resolve to a signal produced for this same account.
All three annotation arrays may be omitted or empty; absence remains explicitly unknown and is never
replaced with inferred content.

Portable fixture invocation:

```bash
npm run prepare-first-meeting-v2 -- --account "Northstar Logistics" --mapping-fixture northstar-example
```

`northstar-example` is illustrative fixture mapping data, not automated research, approved business
policy, a verified service catalogue, or a recommendation. `--mapping-fixture none` is the default.
The CLI uses only local fixture adapters and the deterministic fixture claim extractor; it makes no
network or CRM calls. Direct callers may invoke `prepareFirstMeetingV2(input, deps)` from
`workflows/prepare-first-meeting-v2/index.js`.

## Output and safety

Output validates against `schemas/prepare-first-meeting-v2-result.schema.json`. It includes the
evidence-linked Account Intelligence structures, reference versions/statuses, final Markdown,
visible citation IDs, step summaries, and safe diagnostics. It does not expose a list of withheld
claim IDs. Blocked or failed runs have `artifact: null`, `account_intelligence: null`, and no
evidence IDs.

- `signal.extract` classifies only explicit caller mappings. It does not search for or rank a
  compelling event, assign urgency, or derive an event date.
- `stakeholder.map` emits only caller-named people whose exact name and role text occur in cited
  evidence. A caller-mapped persona is labeled as a hypothesis; title does not imply budget
  authority or decision rights.
- `offering.match` returns a candidate hypothesis with cited claims, fixed rationale, uncertainty,
  and discovery prompts. It does not score fit, recommend a service, or imply approval.
- Conflicting claims remain linked and are labeled for human review; no winner is selected.
- Above-ceiling claims cannot support enrichment. Errors do not echo claim IDs or source text.
- Source prose is evidence data only. No model or prompt parser is used.
- The default reference registries are provisional fixtures with TBD ownership and approval. The
  example offering entries are placeholders pending business review.

`validateFirstMeetingBriefInputV2(value, { referenceRegistry })` is the semantic consumer boundary.
It validates account scope, evidence and signal references, persona/offering vocabulary IDs, gap
supporting IDs, and classification ceilings. JSON Schema validation by itself is not authorization.
The v2 workflow calls this boundary before rendering enrichment, then reuses the established
provenance checker on the final artifact. This does not claim that the v1 consumer or external
consumers call the v2 validator.

## Known dependencies and unknowns

- Caller-provided mappings are required until a separately approved research/mapping implementation
  exists. Candidate mapping fixtures are not an automated discovery capability.
- The supplied reference registries are provisional. Customer-approved signal criteria, personas,
  offerings, offering-fit rules, business ownership, and approval state remain unknown.
- Host runtime, production identity/authorization, live source or CRM connectors, audit, approvals,
  CRM writes, message sending, and Cowork UI remain outside this library workflow.
