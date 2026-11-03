import { validateSkillInput } from "../account-intelligence/common.js";

export function validateInput(input) {
  if (!input || typeof input !== "object" || input.qualification_result === undefined) {
    return {
      ok: false,
      code: "QUALIFICATION_REQUIRED",
      message: "A usable qualification assessment is required before strategy analysis.",
    };
  }

  const result = validateSkillInput("opportunityStrategyInput", input);
  return result.ok
    ? { ...result, value: { ...result.value, offering_annotations: result.value.offering_annotations ?? [] } }
    : result;
}
