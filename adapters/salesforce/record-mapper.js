import { readField } from "./fields.js";
import { SfAdapterError, malformed } from "./errors.js";
import { cleanText, fieldLine, formatValue, headerLine, optionalDateTime } from "./format.js";
import { questionIdsFor } from "./routing.js";

const WHAT_OBJECT = Object.freeze({ "001": "Account", "006": "Opportunity", "003": "Contact" });

function idOrNull(value, reason) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9]{15,18}$/.test(value)) throw new SfAdapterError(malformed(reason));
  return value;
}

/** Record name (Name or Subject) as cleaned text with a fallback. */
export function recordNameOf(def, row) {
  const raw = row[def.nameField];
  if (raw !== null && raw !== undefined && typeof raw !== "string") throw new SfAdapterError(malformed("value_type_mismatch"));
  const text = cleanText(raw ?? "");
  const fallback = def.nameField === "Subject" ? "(no subject)" : "(no name)";
  return [...(text === "" ? fallback : text)].slice(0, 300).join("");
}

/**
 * Salesforce row -> source record (design section 3.3). Throws SfAdapterError on malformed values.
 * @param {object} def OBJECTS entry
 * @param {object} row
 * @param {{requestedAccountId: string, sfAccountId: string, apiVersion: string, retrievedAt: string,
 *   classification: string, instanceUrl: string|null, routing: object, requestedIds: string[], truncated: boolean}} ctx
 */
export function mapRecord(def, row, ctx) {
  const recordName = recordNameOf(def, row);
  const populated = [];
  const absent = [];
  const fieldFacts = [];
  for (const field of def.fields) {
    const value = formatValue(field.type, readField(row, field.api));
    if (value === null) absent.push(field.api);
    else {
      populated.push(field.api);
      fieldFacts.push({ api: field.api, label: field.label, value });
    }
  }

  const lines = [headerLine(def.name, recordName), ...fieldFacts.map((fact) => fieldLine(def.name, recordName, fact))];

  const ownAccount = def.name === "Account" ? row.Id === ctx.sfAccountId : row.AccountId === ctx.sfAccountId;
  const accountId = ownAccount
    ? ctx.requestedAccountId
    : `sf_${typeof (def.name === "Account" ? row.Id : row.AccountId) === "string" ? (def.name === "Account" ? row.Id : row.AccountId) : "missing"}`;

  let occurredAt = null;
  const whatId = def.extra.includes("WhatId") ? idOrNull(row.WhatId, "invalid_what_id") : null;
  const whoId = def.extra.includes("WhoId") ? idOrNull(row.WhoId, "invalid_who_id") : null;
  if (def.name === "Task") occurredAt = optionalDateTime(row.CompletedDateTime);
  if (def.name === "Event") occurredAt = optionalDateTime(row.StartDateTime);

  const metadata = {
    provider: "salesforce",
    object_name: def.name,
    record_type: def.name.toLowerCase(),
    sf_id: row.Id,
    sf_api_version: ctx.apiVersion,
    sf_record_name: recordName,
    sf_fields_json: JSON.stringify(fieldFacts),
    ...(absent.length > 0 ? { sf_null_fields: absent.join(",") } : {}),
    ...(optionalDateTime(row.CreatedDate) ? { sf_created_date: optionalDateTime(row.CreatedDate) } : {}),
    ...(optionalDateTime(row.LastModifiedDate) ? { sf_last_modified_date: optionalDateTime(row.LastModifiedDate) } : {}),
    ...(whatId ? { sf_what_id: whatId, sf_what_object: WHAT_OBJECT[whatId.slice(0, 3)] ?? "other" } : {}),
    ...(whoId ? { sf_who_id: whoId } : {}),
    ...(ctx.truncated ? { sf_truncated: true } : {}),
  };

  return {
    record_id: `src_sf_${row.Id}`,
    account_id: accountId,
    source_type: def.sourceType,
    title: `${def.name}: ${recordName}`.slice(0, 500),
    content: lines.join("\n"),
    source_uri: ctx.instanceUrl ? `${ctx.instanceUrl}/lightning/r/${def.name}/${row.Id}/view` : null,
    published_at: null,
    occurred_at: occurredAt,
    retrieved_at: ctx.retrievedAt,
    access_classification: ctx.classification,
    question_ids: questionIdsFor(ctx.routing, def.name, populated, ctx.requestedIds),
    metadata,
  };
}
