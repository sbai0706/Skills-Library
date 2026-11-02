import { validateSkillInput } from "../account-intelligence/common.js";

export function validateInput(input) {
  const result = validateSkillInput("stakeholderMapInput", input);
  return result.ok
    ? { ...result, value: { ...result.value, annotations: result.value.annotations ?? [] } }
    : result;
}
