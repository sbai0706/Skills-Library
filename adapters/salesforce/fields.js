import { ID_PREFIX } from "./constants.js";

/**
 * Fixed field allow-lists: the only fields ever requested or mapped. No free-text / long-text
 * field is listed (design section 10, decision 4). `Qualification_Score__c` and the six
 * qualification-like picklists are raw CRM facts only: never routed, mapped or interpreted.
 *
 * Every listed field is a structured claim field (content line + claim). `extra` fields are
 * metadata only.
 */
const f = (api, label, type) => Object.freeze({ api, label, type });
const raw = (api, type = "picklist") => f(api, api, type);

export const OBJECTS = Object.freeze({
  Account: Object.freeze({
    name: "Account",
    prefix: ID_PREFIX.Account,
    nameField: "Name",
    sourceType: "crm_record",
    fields: Object.freeze([
      f("Industry", "Industry", "picklist"),
      f("Type", "Account Type", "picklist"),
      f("Website", "Website", "url"),
      f("NumberOfEmployees", "Employees", "int"),
      f("AnnualRevenue", "Annual Revenue", "currency"),
      f("BillingCity", "Billing City", "string"),
      f("BillingState", "Billing State/Province", "string"),
      f("BillingCountry", "Billing Country", "string"),
      f("Owner.Name", "Account Owner", "string"),
    ]),
    extra: Object.freeze([]),
  }),
  Opportunity: Object.freeze({
    name: "Opportunity",
    prefix: ID_PREFIX.Opportunity,
    nameField: "Name",
    sourceType: "crm_record",
    fields: Object.freeze([
      f("StageName", "Stage", "picklist"),
      f("Amount", "Amount", "currency"),
      f("CloseDate", "Close Date", "date"),
      f("Probability", "Probability", "percent"),
      f("ForecastCategoryName", "Forecast Category", "picklist"),
      f("Type", "Opportunity Type", "picklist"),
      f("LeadSource", "Lead Source", "picklist"),
      f("Owner.Name", "Opportunity Owner", "string"),
      raw("Cluster__c"),
      raw("Qualification_Score__c", "double"),
      raw("Budget_Status__c"),
      raw("Primary_Buyer_Authority__c"),
      raw("Awareness_of_Pain__c"),
      raw("What_s_the_Trigger_and_why_now__c"),
      raw("Cost_of_Inaction__c"),
      raw("Buying_Path__c"),
    ]),
    extra: Object.freeze([]),
  }),
  Contact: Object.freeze({
    name: "Contact",
    prefix: ID_PREFIX.Contact,
    nameField: "Name",
    sourceType: "crm_record",
    fields: Object.freeze([f("Title", "Title", "string"), f("Department", "Department", "string")]),
    extra: Object.freeze([]),
  }),
  Task: Object.freeze({
    name: "Task",
    prefix: ID_PREFIX.Task,
    nameField: "Subject",
    sourceType: "crm_activity",
    fields: Object.freeze([
      f("Status", "Status", "picklist"),
      f("Priority", "Priority", "picklist"),
      f("Type", "Task Type", "picklist"),
      f("ActivityDate", "Due Date", "date"),
      f("Owner.Name", "Assigned To", "string"),
    ]),
    extra: Object.freeze(["WhatId", "WhoId", "CompletedDateTime"]),
  }),
  Event: Object.freeze({
    name: "Event",
    prefix: ID_PREFIX.Event,
    nameField: "Subject",
    sourceType: "crm_activity",
    fields: Object.freeze([
      f("StartDateTime", "Start", "datetime"),
      f("EndDateTime", "End", "datetime"),
      f("Location", "Location", "string"),
      f("Type", "Event Type", "picklist"),
      f("Owner.Name", "Assigned To", "string"),
    ]),
    extra: Object.freeze(["WhatId", "WhoId"]),
  }),
});

/** Exact select list: Id, record name, AccountId (non-Account), fields, extra metadata, audit dates. */
export function selectList(objectName) {
  const def = OBJECTS[objectName];
  if (!def) throw new TypeError(`Unknown Salesforce object: ${objectName}`);
  return [
    "Id",
    def.nameField,
    ...(objectName === "Account" ? [] : ["AccountId"]),
    ...def.fields.map((field) => field.api),
    ...def.extra,
    "CreatedDate",
    "LastModifiedDate",
  ].join(", ");
}

/** Read a possibly dotted API path (`Owner.Name`) from a row. */
export function readField(row, api) {
  let cursor = row;
  for (const part of api.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}
