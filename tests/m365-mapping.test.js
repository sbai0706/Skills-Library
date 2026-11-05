import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  M365MappingError, findAccountMapping, isPersonalUrl, loadM365AccountMapping, matchPrefix, normalizePrefix,
  parseWebUrl, validateM365AccountMapping,
} from "../adapters/m365/index.js";
import { validate } from "../schemas/index.js";
import { NORTHWIND_SF_ID, SALES_PREFIX, mappingDoc, oneAccount } from "./helpers/m365-capture.js";

const examplePath = fileURLToPath(new URL("../reference/m365-account-mapping.example.yaml", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "m365-mapping-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const loc = (prefix, extra = {}) => ({ web_url_prefix: prefix, ...extra });

test("the committed example validates, is provisional and fictional only", () => {
  const text = readFileSync(examplePath, "utf8");
  const doc = YAML.parse(text);
  assert.deepEqual(validate("m365AccountMapping", doc), { valid: true, errors: [] });
  assert.equal(doc.status, "provisional");
  const mapping = loadM365AccountMapping(examplePath);
  assert.equal(mapping.status, "provisional");
  assert.equal(mapping.accounts.length, 1);
  assert.equal(mapping.accounts[0].account_id, NORTHWIND_SF_ID);
  assert.deepEqual(mapping.accounts[0].locations.map((l) => l.folder_name), ["Northwind Traders", "Northwind"]);
  assert.deepEqual(mapping.accounts[0].locations.map((l) => l.classification), [null, "confidential"]);
  const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const hosts = code.match(/https:\/\/[^/"\s]+/g);
  assert.ok(hosts.length >= 2);
  for (const host of hosts) assert.equal(host, "https://contoso.sharepoint.com");
  for (const id of text.match(/sf_001\w+/g)) assert.match(id, /^sf_001SYN/);
});

test("normalization keeps the case, strips trailing slashes and derives the search folder name", () => {
  assert.equal(normalizePrefix(`  ${SALES_PREFIX}//  `), SALES_PREFIX);
  const mapping = validateM365AccountMapping(oneAccount([loc(`${SALES_PREFIX}/`), loc("https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Other", { search_folder_name: " Custom " })]));
  assert.deepEqual(mapping.accounts[0].locations.map((l) => [l.prefix, l.key, l.folder_name]), [
    [SALES_PREFIX, SALES_PREFIX.toLowerCase(), "Northwind Traders"],
    ["https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Other", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Other".toLowerCase(), "Custom"],
  ]);
  assert.deepEqual(findAccountMapping(mapping, NORTHWIND_SF_ID).locations.length, 2);
  assert.equal(findAccountMapping(mapping, "sf_001SYN0000000002AA"), null);
});

test("/sites/ and /teams/ library paths are accepted (also case-insensitively), acct_ ids too", () => {
  const ok = [
    "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents",
    "https://contoso.sharepoint.com/teams/ExampleTeam/Shared Documents/Northwind",
    "https://CONTOSO.sharepoint.com/Sites/ExampleSales/Shared Documents/x",
    "https://contoso.sharepoint.com/TEAMS/ExampleTeam/Docs/a/b/c",
  ];
  for (const prefix of ok) assert.doesNotThrow(() => validateM365AccountMapping(oneAccount([loc(prefix)])), prefix);
  assert.doesNotThrow(() => validateM365AccountMapping(oneAccount([loc(SALES_PREFIX)], "acct_northwind_001")));
});

const REJECTED = [
  ["OneDrive host", "https://contoso-my.sharepoint.com/personal/someone_contoso_com/Documents/Northwind", "personal_onedrive_host"],
  ["OneDrive host (case-insensitive)", "https://CONTOSO-MY.sharepoint.com/sites/x/Docs", "personal_onedrive_host"],
  ["personal segment", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/personal/Northwind", "personal_segment"],
  ["personal segment (case-insensitive)", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Personal", "personal_segment"],
  ["root-site library", "https://contoso.sharepoint.com/Shared Documents/Northwind", "not_site_library_path"],
  ["root of a site (no library)", "https://contoso.sharepoint.com/sites/ExampleSales", "not_site_library_path"],
  ["team with no library", "https://contoso.sharepoint.com/teams/ExampleTeam", "not_site_library_path"],
  ["another top-level path", "https://contoso.sharepoint.com/portals/ExampleSales/Docs", "not_site_library_path"],
  ["http", "http://contoso.sharepoint.com/sites/ExampleSales/Shared Documents", "not_https"],
  ["query", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents?x=1", "query_or_fragment"],
  ["fragment", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents#top", "query_or_fragment"],
  ["percent-encoded", "https://contoso.sharepoint.com/sites/ExampleSales/Shared%20Documents/Northwind", "percent_encoded"],
  ["dot-dot", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/../Other", "dot_segment"],
  ["empty segment", "https://contoso.sharepoint.com/sites//Shared Documents/x", "empty_segment"],
  ["foreign host", "https://example.com/sites/ExampleSales/Shared Documents", "host_not_sharepoint"],
  ["host with a port", "https://contoso.sharepoint.com:8443/sites/ExampleSales/Docs", "host_not_sharepoint"],
  ["backslash", "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents\\x", "invalid_characters"],
  ["too long", `https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/${"a".repeat(1000)}`, "too_long"],
];

for (const [label, prefix, kind] of REJECTED) {
  test(`rejected: ${label}`, () => {
    assert.throws(
      () => validateM365AccountMapping(oneAccount([loc(prefix)])),
      (error) => {
        assert.ok(error instanceof M365MappingError);
        assert.ok(error.problems.includes(`accounts[0].locations[0].web_url_prefix: ${kind}`), error.problems.join("|"));
        const text = [error.message, ...error.problems].join("\n");
        assert.ok(!/contoso|sharepoint.com|https?:|Northwind|Example/i.test(text), `a rejection message leaked a value: ${text}`);
        return true;
      },
    );
  });
}

test("rejected: structure problems (whole file, no value echoed)", () => {
  const dup = [{ account_id: NORTHWIND_SF_ID, locations: [loc(SALES_PREFIX)] }, { account_id: NORTHWIND_SF_ID, locations: [loc(SALES_PREFIX)] }];
  const eleven = Array.from({ length: 11 }, (_, i) => loc(`${SALES_PREFIX}${i}`));
  const cases = [
    [mappingDoc(dup), "duplicate_account"],
    [oneAccount([loc(SALES_PREFIX), loc(SALES_PREFIX.toUpperCase().replace("HTTPS", "https"))]), "duplicate_prefix"],
    [oneAccount([loc(SALES_PREFIX), loc(`${SALES_PREFIX}/`)]), "duplicate_prefix"],
    [oneAccount([loc(SALES_PREFIX)], "sf_001SYN0000000001"), "invalid_account_id"],
    [oneAccount([loc(SALES_PREFIX)], "Northwind Traders"), "invalid_account_id"],
    [oneAccount([loc(SALES_PREFIX, { search_folder_name: "   " })]), "invalid_folder_name"],
    [oneAccount([loc(SALES_PREFIX, { search_folder_name: "x".repeat(201) })]), "invalid_folder_name"],
    [oneAccount(eleven), "locations"],
    [oneAccount([loc(SALES_PREFIX, { classification: "public" })]), "schema"],
    [oneAccount([loc(SALES_PREFIX, { surprise: true })]), "schema"],
    [oneAccount([]), "schema"],
    [mappingDoc([], { status: "draft" }), "schema"],
    [mappingDoc([], { mapping_kind: "other" }), "schema"],
    [{ ...mappingDoc([]), extra_key: 1 }, "schema"],
    [(() => { const { approver, ...rest } = mappingDoc([]); return rest; })(), "schema"],
    [null, "schema"],
  ];
  for (const [doc, kind] of cases) {
    assert.throws(() => validateM365AccountMapping(doc), (error) => {
      assert.ok(error instanceof M365MappingError);
      assert.ok([error.message, ...error.problems].some((text) => text.includes(kind)), `${kind}: ${error.problems.join("|")}`);
      assert.ok(!/contoso|https?:|Northwind|Example/.test([error.message, ...error.problems].join("\n")));
      return true;
    }, kind);
  }
});

test("an empty accounts list is a valid mapping (every account is unmapped)", () => {
  const mapping = validateM365AccountMapping(mappingDoc([]));
  assert.deepEqual(mapping.accounts, []);
});

test("loading failures say what failed without echoing file contents", () => {
  assert.throws(() => loadM365AccountMapping(join(tmp, "missing.yaml")), /cannot be read/);
  const broken = join(tmp, "broken.yaml");
  writeFileSync(broken, "accounts: [unclosed\n  secret-customer-name: {");
  assert.throws(() => loadM365AccountMapping(broken), (error) => error instanceof M365MappingError && /not valid YAML/.test(error.message) && !/secret/.test(error.message));
  const wrong = join(tmp, "wrong.yaml");
  writeFileSync(wrong, "hello: secret-customer-name\n");
  assert.throws(() => loadM365AccountMapping(wrong), (error) => error instanceof M365MappingError && !/secret/.test([error.message, ...error.problems].join("\n")));
});

test("isPersonalUrl: -my host or any personal path segment (decoded, case-insensitive)", () => {
  assert.equal(isPersonalUrl("https://contoso-my.sharepoint.com/personal/x/Documents/a.docx"), true);
  assert.equal(isPersonalUrl("https://contoso-my.sharepoint.com/anything"), true);
  assert.equal(isPersonalUrl("https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Personal/a.docx"), true);
  assert.equal(isPersonalUrl("https://contoso.sharepoint.com/sites/ExampleSales/Shared%20Documents/%70ersonal/a.docx"), true);
  assert.equal(isPersonalUrl(`${SALES_PREFIX}/a.docx`), false);
  assert.equal(isPersonalUrl(`${SALES_PREFIX}/personal-notes.docx`), false);
  assert.equal(isPersonalUrl("not a url"), false);
});

test("matchPrefix: segment boundary, case-insensitive, raw or percent-decoded URL, all matches returned", () => {
  const mapping = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX), loc(`${SALES_PREFIX}/Meetings`)]));
  const locations = mapping.accounts[0].locations;
  assert.equal(matchPrefix(`${SALES_PREFIX}/a.docx`, locations).length, 1);
  assert.equal(matchPrefix(`${SALES_PREFIX}/Meetings/a.docx`, locations).length, 2);
  assert.equal(matchPrefix(`${SALES_PREFIX.toUpperCase()}/A.DOCX`, locations).length, 1);
  assert.equal(matchPrefix(`${SALES_PREFIX}2/a.docx`, locations).length, 0, "Northwind Traders2 is a different folder");
  assert.equal(matchPrefix(SALES_PREFIX, locations).length, 0, "the folder itself is not a document under it");
  assert.equal(matchPrefix(`${SALES_PREFIX.replaceAll(" ", "%20")}/a.docx`, locations).length, 1, "percent-encoded webUrl");
  assert.equal(matchPrefix("https://contoso.sharepoint.com/Shared Documents/Northwind Traders/a.docx", locations).length, 0);
});

const SITE = "https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders";
const traversal = [
  ["dot-dot", `${SITE}/../../../OtherSite/Shared Documents/x.docx`],
  ["dot-dot into a sibling site", `${SITE}/../../../ExampleDelivery/Shared Documents/Clients/x.docx`],
  ["dot-dot in the middle", `https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders/Sub/../../Other/x.docx`],
  ["single dot", `${SITE}/./x.docx`],
  ["encoded dot-dot (%2e%2e)", `${SITE}/%2e%2e/%2e%2e/OtherSite/x.docx`],
  ["encoded dot-dot (%2E%2E)", `${SITE}/%2E%2E/x.docx`],
  ["encoded slash (%2F) then dot-dot", `${SITE}/..%2F..%2FOtherSite/x.docx`],
  ["encoded slash (%2f) in a segment", `${SITE}/Sub%2fSecret/x.docx`],
  ["encoded backslash (%5C)", `${SITE}/Sub%5CSecret/x.docx`],
  ["literal backslash", `${SITE}/Sub\\Secret/x.docx`],
  ["backslash dot-dot", `${SITE}/..\\..\\OtherSite/x.docx`],
  ["empty segment", `${SITE}//x.docx`],
  ["malformed percent escape", `${SITE}/%E0%A4%A/x.docx`],
  ["userinfo", "https://user@contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders/x.docx"],
  ["port", "https://contoso.sharepoint.com:8443/sites/ExampleSales/Shared Documents/Northwind Traders/x.docx"],
  ["http", "http://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders/x.docx"],
  ["another host with the prefix as a path", `https://evil.example/https://contoso.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders/x.docx`],
];

for (const [label, webUrl] of traversal) {
  test(`matchPrefix: ${label} is outside the mapping`, () => {
    const { locations } = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX)])).accounts[0];
    assert.equal(parseWebUrl(webUrl), null, "the URL does not parse into a segment list");
    assert.deepEqual(matchPrefix(webUrl, locations), []);
  });
}

test("parseWebUrl splits the raw path and decodes each segment once; matching compares segment arrays", () => {
  assert.deepEqual(parseWebUrl("HTTPS://Contoso.SharePoint.com/sites/ExampleSales/Shared%20Documents/Q%231%20Plan.docx?x=1#frag"), {
    host: "contoso.sharepoint.com",
    segments: ["sites", "ExampleSales", "Shared Documents", "Q#1 Plan.docx"],
  });
  assert.equal(parseWebUrl("https://contoso.sharepoint.com"), null);
  assert.equal(parseWebUrl(undefined), null);
  assert.deepEqual(parseWebUrl("https://contoso.sharepoint.com/sites/a%2541/b.docx").segments, ["sites", "a%41", "b.docx"], "decoded once, not twice");
  const { locations } = validateM365AccountMapping(oneAccount([loc(SALES_PREFIX)])).accounts[0];
  assert.equal(matchPrefix("https://CONTOSO.sharepoint.com/SITES/examplesales/shared documents/NORTHWIND TRADERS/x.docx", locations).length, 1);
  assert.equal(matchPrefix("https://other.sharepoint.com/sites/ExampleSales/Shared Documents/Northwind Traders/x.docx", locations).length, 0, "host differs");
  assert.equal(matchPrefix(`${SITE}%2FSub/x.docx`, locations).length, 0, "an encoded slash cannot extend the prefix");
});

test("isPersonalUrl also sees a personal segment that a raw path hides from URL normalization", () => {
  assert.equal(isPersonalUrl(`${SITE}/../../../../personal/x.docx`), true);
  assert.equal(isPersonalUrl(`${SITE}/%2e%2e/personal/x.docx`), true);
});
