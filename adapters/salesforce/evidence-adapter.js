import { assertMcpToolClient } from "../mcp/index.js";
import {
  API_VERSION_PATTERN, DEFAULT_API_VERSION, OBJECT_ORDER,
} from "./constants.js";
import { resolveLimits } from "./limits.js";
import { adapterError, toAdapterError } from "./errors.js";
import { OBJECTS } from "./fields.js";
import { mapRecord } from "./record-mapper.js";
import { loadSalesforceRouting } from "./routing.js";
import { buildObjectSoql, parseSfAccountId } from "./soql.js";
import { runQuery } from "./transport.js";

const RANK = Object.freeze({ public: 0, internal: 1, confidential: 2 });

/** CRM records are never `public`: only internal or confidential may be configured. */
const CRM_CLASSIFICATIONS = Object.freeze(["internal", "confidential"]);

function validateClassification(value, label) {
  if (!CRM_CLASSIFICATIONS.includes(value)) throw new TypeError(`${label} must be one of: ${CRM_CLASSIFICATIONS.join(", ")}`);
}

function normalizeInstanceUrl(instanceUrl) {
  if (instanceUrl === null || instanceUrl === undefined) return null;
  let url;
  try { url = new URL(instanceUrl); } catch { throw new TypeError("instanceUrl must be an absolute https URL"); }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") throw new TypeError("instanceUrl must be an https origin");
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
}

/**
 * Salesforce EvidenceAdapter for source `crm` over an injected McpToolClient.
 * Queries Account, Opportunity, Contact, Task, Event sequentially; the first failing query
 * fails the whole source (no silent partial record set). Never throws after construction.
 * @param {object} options see docs/design/P2_SALESFORCE_ADAPTERS.md section 1
 */
export function createSalesforceEvidenceAdapter({
  client,
  apiVersion = DEFAULT_API_VERSION,
  now = () => new Date(),
  limits = {},
  classification = "internal",
  objectClassification = {},
  instanceUrl = null,
  routing,
} = {}) {
  assertMcpToolClient(client);
  if (typeof apiVersion !== "string" || !API_VERSION_PATTERN.test(apiVersion)) {
    throw new TypeError(`apiVersion must match ${API_VERSION_PATTERN}`);
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  validateClassification(classification, "classification");
  for (const [objectName, level] of Object.entries(objectClassification)) {
    if (!OBJECTS[objectName]) throw new TypeError(`objectClassification: unknown object ${objectName}`);
    validateClassification(level, `objectClassification.${objectName}`);
    if (RANK[level] < RANK[classification]) throw new TypeError(`objectClassification.${objectName} may not be lower than classification`);
  }
  const effectiveLimits = resolveLimits(limits);
  const baseUrl = normalizeInstanceUrl(instanceUrl);
  const routingDoc = routing ?? loadSalesforceRouting();

  return {
    name: `salesforce-evidence-adapter(${apiVersion})`,
    supportedSources: ["crm"],
    async retrieve(request) {
      try {
        if (request?.source_type !== "crm") {
          return { ok: false, error: adapterError("UNSUPPORTED_SOURCE", "This adapter only serves the crm source.", false) };
        }
        const sfId = parseSfAccountId(request.account_id);
        if (!sfId) {
          return { ok: false, error: adapterError("ADAPTER_UNAVAILABLE", "Account ID is not a Salesforce account.", false, { reason: "invalid_account_id" }) };
        }
        const requestedIds = Array.isArray(request.questions) ? request.questions.map((q) => q?.id).filter((id) => typeof id === "string") : [];
        const retrievedAt = now().toISOString();
        const records = [];
        for (const objectName of OBJECT_ORDER) {
          const def = OBJECTS[objectName];
          const keep = effectiveLimits[objectName];
          const queried = await runQuery(client, buildObjectSoql(objectName, sfId, { limits: effectiveLimits }), {
            apiVersion, expectObject: objectName, idPrefix: def.prefix, maxRecords: keep + 1,
          });
          if (!queried.ok) return { ok: false, error: queried.error };
          const truncated = queried.truncated || queried.records.length > keep;
          const ctx = {
            requestedAccountId: request.account_id,
            sfAccountId: sfId,
            apiVersion,
            retrievedAt,
            classification: objectClassification[objectName] ?? classification,
            instanceUrl: baseUrl,
            routing: routingDoc,
            requestedIds,
            truncated,
          };
          for (const row of queried.records.slice(0, keep)) records.push(mapRecord(def, row, ctx));
        }
        return { ok: true, records };
      } catch (thrown) {
        return { ok: false, error: toAdapterError(thrown) };
      }
    },
  };
}
