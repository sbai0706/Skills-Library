import { DEFAULT_OBJECT_LIMITS } from "./constants.js";
import { OBJECTS } from "./fields.js";

/**
 * Validate per-object keep limits (may only LOWER the defaults) and merge with the defaults.
 * Shared by the evidence adapter and `evidencePlan` so plan and adapter cannot diverge.
 * @throws {TypeError}
 */
export function resolveLimits(limits = {}) {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) throw new TypeError("limits must be an object");
  const effective = { ...DEFAULT_OBJECT_LIMITS };
  for (const [objectName, value] of Object.entries(limits)) {
    if (!OBJECTS[objectName]) throw new TypeError(`limits: unknown object ${objectName}`);
    if (!Number.isInteger(value) || value < 1 || value > DEFAULT_OBJECT_LIMITS[objectName]) {
      throw new TypeError(`limits.${objectName} must be an integer between 1 and ${DEFAULT_OBJECT_LIMITS[objectName]}`);
    }
    effective[objectName] = value;
  }
  return effective;
}
