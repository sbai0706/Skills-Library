import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountSearchPlan, evidencePlan } from "../../adapters/salesforce/capture-plan.js";
import { sfOk, sid, textEnvelope } from "./salesforce-capture.js";

/** Synthetic scenario data. Entirely fictional: no real customer data. */

export const NORTHWIND_ID = sid("001", 1);
export const NORTHWIND_ACCOUNT_ID = `sf_${NORTHWIND_ID}`;
export const LOGISTICS_ID = sid("001", 2);

const owner = { attributes: { type: "User" }, Name: "Avery Example" };
const audit = { CreatedDate: "2026-01-05T09:00:00.000+0000", LastModifiedDate: "2026-10-20T12:30:00.000+0000" };

export const northwindSearchRow = {
  Id: NORTHWIND_ID, Name: "Northwind Traders", Website: "https://www.northwind-traders.example",
  BillingCity: "Columbus", BillingState: "OH", BillingCountry: "USA", Owner: owner,
};

export const northwindRows = {
  Account: [{
    Id: NORTHWIND_ID, Name: "Northwind Traders", Industry: "Logistics", Type: "Customer",
    Website: "https://www.northwind-traders.example", NumberOfEmployees: 250, AnnualRevenue: 12000000,
    BillingCity: "Columbus", BillingState: "OH", BillingCountry: "USA", Owner: owner, ...audit,
  }],
  Opportunity: [
    {
      Id: sid("006", 1), Name: "Phoenix Upgrade", AccountId: NORTHWIND_ID, StageName: "Awareness", Amount: 50000,
      CloseDate: "2026-12-15", Probability: 10, ForecastCategoryName: "Pipeline", Type: "New Business",
      LeadSource: "Referral", Owner: owner, Cluster__c: "Cluster East", Qualification_Score__c: 42,
      Budget_Status__c: "Approved", Primary_Buyer_Authority__c: null, Awareness_of_Pain__c: null,
      What_s_the_Trigger_and_why_now__c: null, Cost_of_Inaction__c: null, Buying_Path__c: null, ...audit,
    },
    {
      Id: sid("006", 2), Name: "Fleet Review", AccountId: NORTHWIND_ID, StageName: "Prospecting", Amount: null,
      CloseDate: "2027-01-31", Probability: null, ForecastCategoryName: null, Type: null, LeadSource: null,
      Owner: null, Cluster__c: null, Qualification_Score__c: null, Budget_Status__c: null, ...audit,
    },
  ],
  Contact: [{
    Id: sid("003", 1), Name: "Jordan Sample", AccountId: NORTHWIND_ID, Title: "VP Operations", Department: "Operations",
    // Present in the synthetic row on purpose: the adapter must never select or map these.
    Email: "jordan.sample@northwind-traders.example", Phone: "+1 555 0100", ...audit,
  }],
  Task: [{
    Id: sid("00T", 1), Subject: "Follow up call", AccountId: NORTHWIND_ID, Status: "Completed", Priority: "Normal",
    Type: "Call", ActivityDate: "2026-10-01", Owner: owner, WhatId: sid("006", 1), WhoId: sid("003", 1),
    CompletedDateTime: "2026-10-01T15:00:00.000+0000", ...audit,
  }],
  Event: [],
};

/** Capture entries for the evidence phase; Opportunity and Task are wrapped as MCP text envelopes. */
export function evidenceEntries(accountId, rows) {
  return evidencePlan(accountId).calls.map((call) => {
    const result = sfOk(call.step, rows[call.step] ?? []);
    const wrapped = call.step === "Opportunity" || call.step === "Task" ? textEnvelope(result) : result;
    return { tool: "dispatch_readonly", args: call.args, result: wrapped, captured_at: "2026-11-04T10:00:02Z" };
  });
}

/** Account search entries for a term returning the given rows. */
export function searchEntries(term, rows) {
  const call = accountSearchPlan(term).calls[0];
  return [{ tool: "dispatch_readonly", args: call.args, result: sfOk("Account", rows), captured_at: "2026-11-04T10:00:01Z" }];
}

export const captureDoc = (entries, note) => ({
  format_version: "mcp-capture/1",
  capture: { created_at: "2026-11-04T10:00:00Z", source_system: "salesforce", connector: "synthetic-salesforce-connector", note },
  entries,
});

export function scenarios() {
  return {
    "salesforce-northwind": captureDoc(
      [...searchEntries("Northwind Traders", [northwindSearchRow]), ...evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows)],
      "Entirely fictional fixture; unique match then CRM evidence.",
    ),
    "salesforce-ambiguous": captureDoc(
      searchEntries("Northwind", [
        { ...northwindSearchRow, Id: LOGISTICS_ID, Name: "Northwind Logistics" },
        northwindSearchRow,
      ].sort((a, b) => a.Name.localeCompare(b.Name))),
      "Entirely fictional fixture; two plausible accounts.",
    ),
  };
}

/** Rewrite fixture files (run: node tests/helpers/salesforce-scenarios.js). */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, doc] of Object.entries(scenarios())) {
    const dir = new URL(`../../fixtures/${name}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL("capture.json", dir), `${JSON.stringify(doc, null, 2)}\n`);
  }
}

