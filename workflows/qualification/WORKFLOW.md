# qualification

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Composes the existing fixture-capable account resolution and evidence normalization workflow with `qualification.assess`, then renders a cited advisory evidence brief. The shared first-meeting gap result and artifact are not used as qualification evidence. Classification is applied before visible conflict groups and qualification states are derived.

## Input and invocation

Input validates against `schemas/qualification-workflow-input.schema.json`. It contains the existing `workflow_input` object plus optional versioned `criteria_set` and `event_evidence` mappings. Portable invocation uses local deterministic fixtures only:

```bash
npm run qualification -- --account "Northstar Logistics" --assessment-fixture northstar-provisional --output markdown
```

`northstar-provisional` is illustrative fixture input, not approved policy or customer truth. Omit it (the default) to see the no-criteria path. Direct callers can invoke `runQualification(input, deps)` from `workflows/qualification/index.js`.

## Output and safety

Output validates against `schemas/qualification-workflow-result.schema.json`. Successful/partial runs include the criterion-by-criterion evidence states, all six event fields, discovery questions, safe diagnostics, citations, and a Markdown artifact. Blocked or failed runs have no assessment, evidence IDs, or artifact.

The event fields are **Event, Deadline, Consequence, Accountable owner, Relevantz service need, and Next customer decision**. Empty mappings remain missing; conflicts among visible normalized claims remain conflicting. Evidence above the output ceiling cannot affect states, questions, citations, or rendering. A hidden-only or mixed-visibility conflict group is excluded before assessment.

The workflow does not claim that linked evidence is sufficient, current, customer-confirmed, a verified event, causal urgency, a qualification outcome, or stage readiness. Lifecycle ordering and advancement rules remain unavailable; no Salesforce write or opportunity creation is attempted. No network or model is used by the CLI.
