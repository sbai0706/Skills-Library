import { validate } from "../../schemas/index.js";

export function validateInput(input) {
  const result = validate("prepareFirstMeetingV2Input", input);
  if (!result.valid) {
    return {
      ok: false,
      errors: [{ code: "INVALID_INPUT", message: "Input does not validate against the v2 workflow contract." }],
    };
  }

  return {
    ok: true,
    value: {
      workflow_input: input.workflow_input,
      annotations: {
        signals: input.annotations?.signals ?? [],
        stakeholders: input.annotations?.stakeholders ?? [],
        offerings: input.annotations?.offerings ?? [],
      },
    },
  };
}
