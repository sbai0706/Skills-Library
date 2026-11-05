import { createHash } from "node:crypto";
import {
  SNIPPET_LABEL, cleanSnippet, displayName, fieldLine, fileTypeOf, headerLine, locationOf, siteOf,
} from "./format.js";
import { PROVIDER } from "./constants.js";

/** Stable record key: no raw drive/item IDs in the record_id. */
export function recordIdOf(driveId, itemId) {
  return `src_m365_${createHash("sha256").update(`${driveId}/${itemId}`, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Validated SharePoint file hit -> source record (P4 design section 5). The hit must already have
 * passed the adapter's strict check. Cross-record flags (copy count, truncation, claim exclusion)
 * are stamped by the adapter afterwards.
 * @param {object} hit
 * @param {{accountId: string, retrievedAt: string, classification: string}} ctx
 */
export function mapHit(hit, ctx) {
  const name = displayName(hit.name);
  const fileType = fileTypeOf(hit.name);
  const location = locationOf(hit.webUrl);
  const lastModified = new Date(hit.lastModifiedDateTime).toISOString();
  const snippet = cleanSnippet(hit);
  const lines = [
    headerLine(name),
    ...(fileType ? [fieldLine(name, "File type", fileType)] : []),
    fieldLine(name, "Location", location),
    fieldLine(name, "Last modified", lastModified),
    ...(snippet ? [SNIPPET_LABEL, snippet] : []),
  ];
  return {
    record_id: recordIdOf(hit.driveId, hit.id),
    account_id: ctx.accountId,
    source_type: "internal_document",
    title: `SharePoint document: ${name}`.slice(0, 500),
    content: lines.join("\n"),
    source_uri: new URL(hit.webUrl).href,
    published_at: null,
    occurred_at: lastModified,
    retrieved_at: ctx.retrievedAt,
    access_classification: ctx.classification,
    question_ids: [],
    metadata: {
      provider: PROVIDER,
      record_type: "sharepoint_file",
      m365_drive_id: hit.driveId,
      m365_item_id: hit.id,
      m365_file_name: name,
      ...(fileType ? { m365_file_type: fileType } : {}),
      m365_site: siteOf(hit.webUrl),
      m365_location: location,
      m365_last_modified: lastModified,
      ...(snippet ? { m365_snippet: true } : {}),
    },
  };
}
