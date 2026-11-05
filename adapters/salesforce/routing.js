import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const routingFile = new URL("../../reference/salesforce-question-routing.yaml", import.meta.url);

/** Load the provisional Salesforce question routing reference. */
export function loadSalesforceRouting() {
  return YAML.parse(readFileSync(fileURLToPath(routingFile), "utf8"));
}

/**
 * Question IDs a record is relevant to. A route applies when its object matches and either
 * `when: record_exists`, or `when: any_populated` with at least one listed field populated.
 * Only IDs present in `requestedIds` are returned; the result is sorted and deduplicated.
 * A route is a relevance hint, never an answer.
 * @param {{routes?: object[]}} routing
 * @param {string} objectName
 * @param {Iterable<string>} populatedApis API names with a value on the record
 * @param {Iterable<string>} requestedIds
 */
export function questionIdsFor(routing, objectName, populatedApis, requestedIds) {
  const populated = new Set(populatedApis);
  const requested = new Set(requestedIds);
  const ids = new Set();
  for (const route of routing?.routes ?? []) {
    if (route.object !== objectName || !requested.has(route.question_id)) continue;
    if (route.when === "record_exists") ids.add(route.question_id);
    else if (route.when === "any_populated" && (route.fields ?? []).some((api) => populated.has(api))) ids.add(route.question_id);
  }
  return [...ids].sort();
}
