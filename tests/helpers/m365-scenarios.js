import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_PREFIX, SALES_PREFIX, m365CaptureDoc, m365Entry, m365Hit, m365Page,
} from "./m365-capture.js";

/** Synthetic M365 scenarios shaped like a real capture for the fictional Northwind account. */

export const NORTHWIND_MAPPING_YAML = `# Synthetic mapping for the m365-northwind fixture (fictional; no real customer data).
version: 0.1.0
status: provisional
business_owner: TBD
approver: TBD
approval_date: null
source_documents: []
effective_date: null
change_history:
  - version: 0.1.0
    date: 2026-11-05
    change: Synthetic fixture mapping.
mapping_kind: m365_sharepoint_account_locations
accounts:
  - account_id: sf_001SYN0000000001AA
    label: Northwind Traders (fictional)
    locations:
      - web_url_prefix: "${SALES_PREFIX}"
      - web_url_prefix: "${DELIVERY_PREFIX}"
        search_folder_name: "Northwind"
`;

const proposal = m365Hit({ n: 1, name: "Example Proposal.pptx", lastModified: "2026-09-03T15:28:28.000Z" });
const notes = m365Hit({
  n: 2, name: "Example Meeting Notes.docx", folder: `${SALES_PREFIX}/Meetings`, lastModified: "2026-10-12T09:15:00.000Z",
  content: "Synthetic meeting outline<ddd/>",
});
const outsideRoot = m365Hit({
  n: 3, name: "Unrelated Root File.docx", webUrl: "https://contoso.sharepoint.com/Shared Documents/Unrelated Root File.docx",
});
const personal = m365Hit({
  n: 4, driveId: "b!SYNdrive0099", name: "Personal Draft.docx",
  webUrl: "https://contoso-my.sharepoint.com/personal/someone_contoso_com/Documents/Northwind Traders/Personal Draft.docx",
});
const delivery = m365Hit({
  n: 5, driveId: "b!SYNdrive0002", name: "Example Delivery Plan.xlsx", folder: `${DELIVERY_PREFIX}/Plans`,
  lastModified: "2026-08-20T07:00:00.000Z", content: null, summary: null,
});

export const northwindEntries = () => [
  m365Entry("Northwind Traders", 0, { result: m365Page([proposal, notes, outsideRoot, personal]) }),
  m365Entry("Northwind", 0, { result: m365Page([delivery, notes]) }),
];

export const scenarios = () => ({
  "m365-northwind": m365CaptureDoc(northwindEntries(), "Entirely fictional fixture; two searches, one outside-mapping and one personal hit excluded, one duplicate item."),
  "m365-unmapped": m365CaptureDoc([], "Entirely fictional fixture; empty capture for an account without a SharePoint mapping."),
});

/** Rewrite fixture files (run: node tests/helpers/m365-scenarios.js). */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, doc] of Object.entries(scenarios())) {
    const dir = new URL(`../../fixtures/${name}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL("capture.json", dir), `${JSON.stringify(doc, null, 2)}\n`);
    if (name === "m365-northwind") writeFileSync(new URL("mapping.yaml", dir), NORTHWIND_MAPPING_YAML);
  }
}
