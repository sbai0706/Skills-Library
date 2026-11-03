# stakeholder.map

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Create an evidence-linked list of named people only from explicit caller mappings. This skill does not
search for contacts, infer an individual from a title, or assign budget or decision authority.

## Input and invocation

Call `mapStakeholders({ account_id, claims, annotations, classification_ceiling }, deps)` from
`skills/stakeholder-map/index.js`. Each annotation requires a `display_name`, a `persona_id`, the exact
`role_evidence` text and one or more `claim_ids`. The supplied name and role text must occur in at
least one cited normalized claim excerpt, but lexical overlap does not establish that the person holds
that role. Results mark `role_mapping_status` as `caller_hypothesis`; cited excerpts, including
negation or conflicts, remain intact. Empty or omitted `annotations` produces an empty map.

The persona vocabulary is provisional by default. A caller-mapped persona is a hypothesis; titles do
not imply budget authority, influence, buying role, or decision rights. Conflicting evidence stays
linked and is not resolved.

## Boundaries

- Unknown vocabulary or claim IDs and foreign-account references fail without echoing input IDs or text.
- Only claims within the classification ceiling can support an emitted stakeholder.
- The skill does not verify or infer a person-role relationship; the caller supplies a hypothesis and the source text that motivated it.
- Source prose is data only, never executable instructions.
