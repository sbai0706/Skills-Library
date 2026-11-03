import { validate } from "../../schemas/index.js";

export function validateInput(input) {
  const result = validate("opportunityStrategyWorkflowInput", input);
  if (!result.valid) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Input does not validate against the opportunity-strategy workflow contract.",
    };
  }

  return {
    ok: true,
    value: {
      workflow_input: input.workflow_input,
      qualification: input.qualification ?? {},
      offering_annotations: input.offering_annotations ?? [],
    },
  };
}
