import test from "node:test";
import assert from "node:assert/strict";
import { createM365SharePointEvidenceAdapter, createM365StructuredClaimExtractor, validateM365AccountMapping } from "../adapters/m365/index.js";
import { createCompositeClaimExtractor, createSalesforceStructuredClaimExtractor } from "../adapters/salesforce/index.js";
import { createSalesforceEvidenceAdapter } from "../adapters/salesforce/index.js";
import { normalizeEvidence } from "../skills/evidence-normalize/index.js";
import { SALES_PREFIX, NORTHWIND_SF_ID, m365Entry, m365Hit, m365Page, m365Replay, oneAccount } from "./helpers/m365-capture.js";
import { replay } from "./helpers/salesforce-capture.js";
import { NORTHWIND_ACCOUNT_ID, evidenceEntries, northwindRows } from "./helpers/salesforce-scenarios.js";

const NOW = () => new Date("2026-11-05T10:00:00Z");
const MAPPING = validateM365AccountMapping(oneAccount([{ web_url_prefix: SALES_PREFIX }]));
const extractor = createM365StructuredClaimExtractor();
const request = { account_id: NORTHWIND_SF_ID, questions: [{ id: "FM-CTX-001", text: "a?" }], source_type: "internal_document", context: {} };

async function records(hits, options = {}) {
  const client = m365Replay([m365Entry("Northwind Traders", 0, { result: m365Page(hits) })]);
  const result = await createM365SharePointEvidenceAdapter({ client, mapping: MAPPING, now: NOW, ...options }).retrieve(request);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.records;
}

test("claims are Location, File type and Last modified, with golden strings and verbatim excerpts", async () => {
  const [record] = await records([m365Hit({ n: 1, name: "Example Proposal.pptx" })]);
  const result = extractor.extract(record);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [
    {
      claim: 'SharePoint document "Example Proposal.pptx" Location: /sites/ExampleSales/Shared Documents/Northwind Traders',
      excerpt: 'SharePoint document "Example Proposal.pptx" - Location: /sites/ExampleSales/Shared Documents/Northwind Traders',
      completeness: "complete",
    },
    {
      claim: 'SharePoint document "Example Proposal.pptx" File type: pptx',
      excerpt: 'SharePoint document "Example Proposal.pptx" - File type: pptx',
      completeness: "complete",
    },
    {
      claim: 'SharePoint document "Example Proposal.pptx" Last modified: 2026-09-03T15:28:28.000Z',
      excerpt: 'SharePoint document "Example Proposal.pptx" - Last modified: 2026-09-03T15:28:28.000Z',
      completeness: "complete",
    },
  ]);
  for (const { excerpt } of result.candidates) assert.ok(record.content.split("\n").includes(excerpt), "every excerpt is a content line");
});

test("a file without a type has two claims; the wording is Last modified, never published or created", async () => {
  const [record] = await records([m365Hit({ n: 1, name: "README" })]);
  const claims = extractor.extract(record).candidates.map((c) => c.claim);
  assert.equal(claims.length, 2);
  assert.ok(claims.every((claim) => !/published|created|occurred/i.test(claim)));
  assert.ok(claims.some((claim) => claim.endsWith("Last modified: 2026-09-03T15:28:28.000Z")));
});

test("the snippet is never a claim: no snippet text in any candidate, whatever the content says", async () => {
  const marker = "ZZZ-SNIPPET-MARKER";
  const [record] = await records([m365Hit({ n: 1, content: `the budget is $5 million ${marker}` })]);
  assert.ok(record.content.includes(marker), "the snippet is in the content");
  const text = JSON.stringify(extractor.extract(record).candidates);
  assert.ok(!text.includes(marker) && !text.includes("budget"));
  // The extractor does not read `content` at all: replacing it changes nothing.
  assert.deepEqual(extractor.extract({ ...record, content: "different" }), extractor.extract(record));
});

test("records marked claim-excluded keep their content but yield no claims", async () => {
  const hits = Array.from({ length: 12 }, (_, i) => m365Hit({ n: i + 1, name: `Doc ${i + 1}.docx`, lastModified: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const all = await records(hits);
  const counts = all.map((record) => extractor.extract(record).candidates.length);
  assert.equal(counts.filter((n) => n === 3).length, 10);
  assert.equal(counts.filter((n) => n === 0).length, 2);
  assert.ok(all.slice(10).every((record) => record.metadata.m365_claim_excluded === true && record.content.length > 0));
  const total = counts.reduce((a, b) => a + b, 0);
  assert.ok(total <= 30, "at most 30 claims per account");
});

test("every candidate passes evidence.normalize with zero rejections", async () => {
  const all = await records([m365Hit({ n: 1, name: "Example Proposal.pptx" }), m365Hit({ n: 2, name: "No Extension" })]);
  const result = await normalizeEvidence({ account_id: NORTHWIND_SF_ID, records: all }, { extractor });
  assert.equal(result.status, "success");
  assert.deepEqual(result.data.rejected_records ?? [], []);
  assert.deepEqual(result.data.rejected_records ?? [], []);
  assert.equal(result.data.claim_count, 5);
  assert.ok(result.data.claims.every((item) => item.source_type === "internal_document"));
});

test("a record of another provider yields no candidates; absent or odd metadata is not an error", () => {
  assert.deepEqual(extractor.extract({ metadata: { provider: "salesforce" } }), { ok: true, candidates: [] });
  assert.deepEqual(extractor.extract({ metadata: {} }), { ok: true, candidates: [] });
  assert.deepEqual(extractor.extract({}), { ok: true, candidates: [] });
  assert.deepEqual(extractor.extract(null), { ok: true, candidates: [] });
});

test("incomplete M365 metadata is EXTRACTOR_MALFORMED_RESPONSE", async () => {
  const [record] = await records([m365Hit({ n: 1 })]);
  for (const key of ["m365_file_name", "m365_location", "m365_last_modified"]) {
    const broken = structuredClone(record);
    delete broken.metadata[key];
    const result = extractor.extract(broken);
    assert.equal(result.ok, false, key);
    assert.equal(result.error.code, "EXTRACTOR_MALFORMED_RESPONSE");
    const blank = structuredClone(record);
    blank.metadata[key] = "";
    assert.equal(extractor.extract(blank).ok, false, `${key} blank`);
  }
  const typeBlank = structuredClone(record);
  typeBlank.metadata.m365_file_type = "";
  assert.equal(extractor.extract(typeBlank).ok, false);
});

test("the composite of the Salesforce and M365 extractors handles mixed records", async () => {
  const sf = await createSalesforceEvidenceAdapter({ client: replay(evidenceEntries(NORTHWIND_ACCOUNT_ID, northwindRows)), now: NOW })
    .retrieve({ account_id: NORTHWIND_ACCOUNT_ID, questions: [{ id: "FM-CTX-001", text: "a?" }], source_type: "crm", context: {} });
  assert.equal(sf.ok, true);
  const m365 = await records([m365Hit({ n: 1, name: "Example Proposal.pptx" })]);
  const composite = createCompositeClaimExtractor([createSalesforceStructuredClaimExtractor(), extractor]);
  let salesforceClaims = 0;
  for (const record of sf.records) {
    const result = await composite.extract(record);
    assert.equal(result.ok, true);
    assert.ok(result.candidates.every((c) => !c.claim.startsWith("SharePoint document")));
    salesforceClaims += result.candidates.length;
  }
  assert.ok(salesforceClaims > 0);
  const result = await composite.extract(m365[0]);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every((c) => c.claim.startsWith("SharePoint document")));
  assert.equal(composite.name, "composite-claim-extractor(salesforce-structured-claim-extractor+m365-structured-claim-extractor)");
  const mixed = await normalizeEvidence({ account_id: NORTHWIND_SF_ID, records: [...sf.records, ...m365] }, { extractor: composite });
  assert.equal(mixed.status, "success");
  assert.deepEqual(mixed.data.rejected_records ?? [], []);
});
