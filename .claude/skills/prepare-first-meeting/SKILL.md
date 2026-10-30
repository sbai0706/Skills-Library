---
name: prepare-first-meeting
description: Produces a cited first-meeting account brief using the repository's deterministic Sales Copilot workflow. Use when the user asks to research an account or prepare for an initial sales meeting.
---

# Prepare First Meeting

Use the repository's portable prepare-first-meeting CLI.

## Procedure

1. Obtain the account reference.
2. Ask for clarification if the requested classification or fixture scenario
   is not clear.
3. From the repository root, run the documented
   `npm run prepare-first-meeting` command.
4. Interpret the workflow status:
   - `success`: present the rendered brief.
   - `partial`: present the brief and summarize safe warnings.
   - `blocked`: stop and request the required account selection or
     confirmation.
   - `failed`: report the safe structured error.
5. Never override an ambiguous or confirmation-required account result.
6. Never remove evidence citations.
7. Never present omitted or above-ceiling evidence.
8. Clearly state that the current implementation uses fixture data and did
   not query live Salesforce or public sources.

Do not recreate account matching, evidence processing, gap detection, or
rendering in the prompt. Always invoke the repository workflow.