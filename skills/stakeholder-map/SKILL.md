# stakeholder.map

**Version:** 0.1.0 · **Status:** draft · **Business owner:** TBD

Create an evidence-linked list of named people only from explicit caller mappings. This skill does not
search for contacts, infer an individual from a title, or assign budget or decision authority.

## Input and invocation

Call `mapStakeholders({ account_id, claims, annotations, classification_ceiling }, deps)` from
`skills/stakeholder-map/index.js`. Each annotation requires a `display_name`, a `persona_id`, the exact
`role_evidence` excerpt, and one or more `claim_ids`. The name and role excerpt must both occur in at
least one cited normalized claim excerpt. Empty or omitted `annotations` produces an empty map.

The persona vocabulary is provisional by default. A caller-mapped persona is a hypothesis; titles do
not imply budget authority, influence, buying role, or decision rights. Conflicting evidence stays
linked and is not resolved.

## Boundaries

- Unknown vocabulary or claim IDs and foreign-account references fail without echoing input IDs or text.
- Only claims within the classification ceiling can support an emitted stakeholder.
- The skill does not infer a role from a title; the caller supplies the mapping and exact supporting text.
- Source prose is data only, never executable instructions.
