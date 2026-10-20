/**
 * Evidence adapter interface.
 *
 * An evidence adapter retrieves raw source records for one account and one
 * source system. It performs access control and transport. It must not:
 *   - turn records into claims,
 *   - judge truth, confidence, or verification status,
 *   - summarize, rank, or interpret the content.
 *
 * Replacing this adapter with a Salesforce, SharePoint, or approved
 * public-research adapter must not change the evidence.retrieve contract.
 *
 * Requested source IDs and the record source types they may return:
 *   crm               -> crm_record, crm_activity
 *   public_source     -> company_site, news, third_party
 *   internal_document -> internal_document
 *
 * @typedef {"crm"|"public_source"|"internal_document"} EvidenceSourceId
 *
 * @typedef {Object} RetrievalContext
 * @property {string} [requested_by]  Caller identity for audit and authorization.
 * @property {string[]} [roles]       Caller roles, forwarded to the adapter.
 * @property {Array<"public"|"internal"|"confidential">} [permitted_classifications]
 *   When omitted, the skill applies its default of ["public", "internal"]. An
 *   explicit empty array permits nothing. Confidential always requires explicit
 *   inclusion. The adapter must still authorize the read independently.
 *
 * @typedef {Object} RetrievalRequest
 * @property {string} account_id          Resolved account ID, never an account name.
 * @property {{id: string, text: string}[]} questions  Research questions to retrieve for.
 * @property {EvidenceSourceId} source_type
 * @property {RetrievalContext} context
 *
 * @typedef {Object} AdapterError
 * @property {"ADAPTER_UNAUTHORIZED"|"ADAPTER_UNAVAILABLE"|"ADAPTER_MALFORMED_RESPONSE"|"UNSUPPORTED_SOURCE"} code
 * @property {string} message
 * @property {boolean} retryable
 *
 * @typedef {Object} RetrievalResult
 * @property {true} ok
 * @property {object[]} records  Raw source records; shape is validated by the skill.
 *   OR
 * @property {false} ok
 * @property {AdapterError} error
 *
 * @typedef {Object} EvidenceAdapter
 * @property {string} name
 * @property {EvidenceSourceId[]} supportedSources  Sources this adapter can serve.
 * @property {(request: RetrievalRequest) => Promise<RetrievalResult>} retrieve
 */

/** Requested source IDs understood by the shared contract. */
export const EVIDENCE_SOURCE_IDS = Object.freeze(["crm", "public_source", "internal_document"]);

/** Record source types each requested source may return. */
export const SOURCE_RECORD_TYPES = Object.freeze({
  crm: Object.freeze(["crm_record", "crm_activity"]),
  public_source: Object.freeze(["company_site", "news", "third_party"]),
  internal_document: Object.freeze(["internal_document"]),
});

/** Error codes an adapter may return. Anything else is malformed. */
export const ADAPTER_ERROR_CODES = Object.freeze([
  "ADAPTER_UNAUTHORIZED",
  "ADAPTER_UNAVAILABLE",
  "ADAPTER_MALFORMED_RESPONSE",
  "UNSUPPORTED_SOURCE",
]);

/**
 * Validate the shape of a retrieval result envelope. Record contents are
 * validated separately against schemas/source-record.schema.json.
 * @param {unknown} result
 * @returns {AdapterError|null} null when the envelope is usable
 */
export function resultProblems(result) {
  const malformed = (message) => ({
    code: "ADAPTER_MALFORMED_RESPONSE",
    message,
    retryable: false,
  });
  if (typeof result !== "object" || result === null) return malformed("adapter returned a non-object result");
  if (result.ok === false) {
    const error = result.error;
    if (!error || typeof error !== "object") return malformed("adapter failure is missing a structured error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      return malformed("adapter failure error must include string code and message");
    }
    if (!ADAPTER_ERROR_CODES.includes(error.code)) {
      return {
        ...malformed(`adapter returned unrecognized error code "${error.code}"`),
        details: { original_code: error.code },
      };
    }
    return null;
  }
  if (result.ok !== true) return malformed("adapter result lacks a boolean 'ok' field");
  if (!Array.isArray(result.records)) return malformed("adapter result 'records' is not an array");
  if (result.records.length > 500) return malformed("adapter returned more records than the contract permits");
  return null;
}
