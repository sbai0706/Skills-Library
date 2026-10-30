# artifact.render

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Render validated structured claims and gap results into a deterministic Markdown
first-meeting brief. This skill is a renderer, not a researcher or reasoning agent. It selects
and orders supplied fields; it never retrieves information, creates a claim, infers customer
needs, invents stakeholders, resolves a conflict, or changes account identity.

## When to use

- You already hold a resolved canonical account, normalized evidence claims, and a gap result
  that validates against the shared schemas.
- You need a readable first-meeting brief whose factual statements remain linked to claim IDs.
- You need the output classification ceiling enforced again at render time.

## When not to use

- Evidence still needs retrieval, normalization, extraction, or gap detection. Call those skills
  first; this skill accepts none of their raw inputs.
- The account is unresolved, the gap result is missing, or the claims are not normalized evidence.
- A conflict must be resolved or a missing answer must be filled in. This skill does neither.
- The request is for DOCX, PPTX, PDF, an HTML application, or a presentation file. The MVP emits
  Markdown only.
- Workflow composition, live connector access, or a new template is required.

## Required structured input

Use `schemas/first-meeting-brief-input.schema.json` as the canonical input. It supplies:

- `account` — canonical `account_id`, `canonical_name`, and optional identifiers;
- `claims` — normalized records that validate against `schemas/evidence.schema.json`;
- `gap_result` — a result that validates against `schemas/gap-result.schema.json`;
- optional `warnings` — safe fixed messages from the permitted warning set;
- `output_template_id` — currently `first-meeting-brief-v1`;
- `audience` — `internal_sales`, `executive`, or `customer`;
- `classification_ceiling` — `public`, `internal`, or `confidential`.

Raw source records are not evidence claims and are rejected. Do not pass adapter output,
extractor candidates, or free-form notes in place of normalized claims. This skill calls no
adapter and no extractor.

The input schema validates structure only. It accepts structurally valid claims at any
classification and does not compare claim classifications with the ceiling. Schema acceptance
does not authorize rendering: this skill applies the output classification ceiling fail-closed.

## Renderer boundary

The only template is `first-meeting-brief-v1`, selected through a small registry:

```js
render(templateId, structuredInput)
```

An unknown template returns a structured `failed` result with `INVALID_INPUT`. It never silently
falls back to a default template, and no generalized document-rendering framework is provided.

## Output

The shared skill-result envelope is returned. `data` contains at least:

- `account_id`, `template_id`, `audience`, `classification`;
- `artifact_format` (`markdown`) and `rendered_artifact`;
- `cited_evidence_ids` and `omitted_evidence_ids`;
- `warnings`.

`evidence_ids` equals the rendered citation IDs. `success` means every supplied question is
answered from permitted evidence and nothing was withheld. `partial` means the brief is usable
but contains gaps, conflicts, warnings, or withheld claims. `failed` means no artifact could be
rendered, for example invalid input or an unknown template.

The brief contains sections for Account; Known company context; Recent developments or
initiatives; Existing relationship or prior activity; Known stakeholders; Possible service
alignment; Open questions and evidence gaps; Conflicts and cautions; and Evidence references. An
Additional permitted evidence section appears only when permitted claims are not mapped to a
question in the supplied gap result.

## Citation requirements

- Every factual bullet includes one or more evidence IDs, for example:
  `- Northstar announced a modernization program. `[clm_abcd1234]``.
- Section placement comes only from `gap_result.questions[].supporting_evidence_ids` and the
  stable reference question ID. Free-form semantic classification is never used.
- The Evidence references section maps each rendered ID to safe provenance: source type, source
  URI when present, source record ID when present, publication and/or occurrence timestamp, and
  access classification. Full excerpts are not reproduced merely to provide a citation.
- A claim that is not permitted at the output ceiling is not rendered and does not appear in the
  reference table. Its ID appears only in `omitted_evidence_ids`.

## Gap language

Render missing or incomplete evidence openly, using language such as:

- “No permitted evidence was retrieved for this question.” (unanswered)
- “Available evidence addresses part of this question.” (partial)
- “Evidence is unavailable at the current classification level.” (all support withheld)
- “Conflicting evidence requires human review.” (conflicted)

Never convert a gap into a negative fact. Do not write “The customer has no initiative,” “There
are no stakeholders,” or “No budget exists.” Absence of evidence is not evidence of absence.

If classification filtering removes every permitted support for an answered or partially
answered question, recalculate the displayed status as unavailable at the current classification
level. If only some support for an answered question remains, display it as partial. Do not claim
that the underlying information does not exist.

## Conflict language

For each conflicted question:

- show the conflict warning and the supplied conflict reference;
- list the supported conflicting statements only when permitted by the ceiling, citing every one;
- do not choose a winner, rank the sources, or merge the statements into one conclusion;
- if every statement is withheld, say that supporting statements are not available at the current
  classification level without naming or quoting them.

## Classification filtering

Filtering is fail-closed:

| Ceiling | Claims that may render |
| --- | --- |
| `public` | public only |
| `internal` | public and internal only |
| `confidential` | public, internal, and confidential, only when requested and permitted by the calling context |

A claim above the ceiling is omitted at render time. Its ID is added to
`omitted_evidence_ids`; its claim text, excerpt, title, URI, record ID, and metadata are never
copied into rendered content, warnings, diagnostics, gaps, conflicts, or evidence references.
Withholding is reported only as an aggregate warning.

The ceiling must come from an authorized calling context. The renderer trusts that ceiling; it
does not verify authorization or independently grant access to confidential data. The input
schema's acceptance of a structurally valid confidential claim is not authorization to render it.

## Determinism

For identical input, the Markdown is identical. Section order, question order, claim order,
citation order, reference order, and warning order are deterministic. No wall-clock time is
inserted; timestamps appear only when supplied in the input claims.

## Limitations of the Markdown MVP

- Markdown only. No DOCX, PPTX, PDF, HTML application, or slide deck generation.
- One template, `first-meeting-brief-v1`; there is no template design system.
- No retrieval, extraction, inference, conflict adjudication, or workflow execution.
- Normalized evidence has no title field, so the reference table uses source type as the safe
  record type.
- Audience is recorded and exposed in the output, but no audience-specific rewriting or
  summarization is performed.
- Reference questions remain draft and business-owned elsewhere; the renderer only uses their
  stable IDs for placement.

## Constraints

- Never retrieve, normalize, extract, infer, or answer a research question.
- Never invent a stakeholder, initiative, need, budget, date, or customer intention.
- Never write a factual claim without a cited evidence ID.
- Never resolve a conflict, select a winning source, or blend conflicting statements.
- Never render content above the output classification ceiling.
- Never leak omitted claim content through warnings, errors, gaps, or references.
- Never alter the canonical account identity.
- Never use a default template for an unknown template ID.
- Never include the current wall-clock time in the artifact.
- Never add workflow composition, live connectors, or generated Office files.
