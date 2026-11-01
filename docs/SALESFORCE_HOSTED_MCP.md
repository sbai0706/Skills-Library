# Salesforce Hosted MCP setup

## Current state

This repository has a repository-scoped Codex MCP entry at `.codex/config.toml`. It is disabled until the Salesforce org and OAuth app are ready. It targets the production-style Salesforce **SObject Reads** endpoint, which is limited to schema discovery, SOQL queries, SOSL search, current-user context, recently viewed records, and relationship reads. It exposes no create, update, or delete tools.

The repository config is set for the standard production/Developer Edition endpoint. Its callback is:

```text
http://127.0.0.1:43127/callback/UN_ICqhDE3vG
```

The callback ID is derived from the complete MCP server URL using Codex's documented callback algorithm. For the standard sandbox endpoint, use `https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-reads` and callback `http://127.0.0.1:43127/callback/8dpBXZmh834f`. If the org uses My Domain, both its endpoint and callback ID depend on the actual org domain; do not create the app until that URL and callback have been regenerated.

## Salesforce setup that needs an org administrator

The Salesforce documentation requires a System Administrator or equivalent to create an External Client App. Server activation is also an administrator action. The hosted MCP service can be entitlement- or org-edition-dependent; Salesforce says Hosted MCP is intended for customers with Flex Credits.

Ask an administrator to:

1. In **Setup**, search **MCP Servers**, open **API Catalog → MCP Servers → Salesforce Servers**, open **sobject-reads**, and click **Activate**. Salesforce Hosted MCP servers are disabled by default and require administrator activation. If **MCP Servers** is absent, the org may lack the feature or entitlement; stop there and ask the Salesforce administrator to confirm Hosted MCP availability for the org.
2. In **Setup**, search **External Client App Manager**, click **New External Client App**, and enter required basic details (suggested name: `CAO Co-Pilot Read-Only MCP`; API name can remain auto-filled; contact email: the responsible owner).
3. Expand **API (Enable OAuth Settings)** and enable OAuth. Set the **Callback URL** to the exact value above for the standard production endpoint. Select these OAuth scopes only: **Access MCP servers (`mcp_api`)** and **Perform requests at any time (`refresh_token`)**.
4. Under **Security**, enable **Require Proof Key for Code Exchange (PKCE) extension for Supported Authorization Flows** and **Issue JSON Web Token (JWT)-based access tokens for named users**. Leave the secret requirements and other optional security settings off for this desktop public client. PKCE is the client protection; do not send or store a consumer secret in this repository.
5. Click **Create**. Then open the app's **Settings → OAuth Settings → Consumer Key and Secret**. Complete any verification code challenge Salesforce presents and copy only the **Consumer Key** (client ID). Do not copy the Consumer Secret.

For a sandbox, use its alternate URL and callback above. For My Domain, the administrator must use that org-specific server URL and the matching Codex callback before saving the ECA. After the app is created, Salesforce notes that it can take up to 30 minutes to become available. The administrator should also confirm the authenticated user has API access and read access to the required objects and fields. Salesforce sharing rules and field-level security continue to apply.

## Activate the repo-scoped Codex entry

After confirming that the production URL is correct, replace `REPLACE_WITH_EXTERNAL_CLIENT_APP_CONSUMER_KEY` in the ignored `.codex/config.toml` with the Consumer Key. Set `enabled = true`. Keep the callback URL and fixed port unchanged. The consumer key is a public OAuth client identifier for this PKCE desktop client; it is not a password. The project `.codex/` settings load only when the repository is trusted in Codex.

Authenticate using `codex mcp login salesforce_readonly`. Codex opens Salesforce sign-in; finish login and MFA in the browser. Then inspect the Codex MCP server status and tool list in the Codex MCP panel or CLI. Do not declare the integration connected until tools are listed and a read-only query succeeds.

If you use a sandbox, substitute the sandbox URL and callback shown above in both `.codex/config.toml` and the ECA. For a My Domain endpoint, use the appropriate `/d/<domain>/.../platform/sobject-reads` form from Salesforce's server URL guide and derive the matching Codex callback. Update the `url` and callback path together; a callback is server-URL-specific.

## Read-only proof of concept

Once authenticated, first list tools and their input schemas. Use the read-only SOQL tool with a harmless query such as:

```sql
SELECT Id, Name FROM Account ORDER BY Name LIMIT 5
```

Do not fetch additional customer data unless needed. Verify a search that returns no rows, a query with more than one page if the server exposes pagination, and an inaccessible object/field only if the account's permissions make that safe. Record only sanitized results (field names, tool names, counts, and error codes); never commit returned CRM rows, tokens, or raw logs.

## Repository boundary and future adapter

The existing workflow already depends on adapter contracts:

- `adapters/account-adapter.js` defines `searchAccounts()` and the stable account shape (`account_id`, `name`, optional domain/location/owner/active).
- `adapters/evidence-adapter.js` returns the repository's `source-record.schema.json` input contract. `evidence.normalize` then owns claim validation and the stable evidence schema.

Checked-in fixture account records are already adapter-shaped, not Salesforce wire data. Fixture source records are normalized to the repository's internal raw-source contract, not Salesforce SObject JSON. Never pass Hosted MCP tool output straight into a business skill. A future `SalesforceMcpAdapter` should live under `adapters/`, call only read tools, and map Salesforce record IDs to opaque `account_id` / `record_id` values; object and field names plus selected source references belong in flat `metadata`. It should preserve null versus unavailable fields where possible, set `retrieved_at` at retrieval time, retain `occurred_at` for CRM activities, and translate pagination tokens without leaking raw records. A Salesforce MCP search may require a second query or relationship call for details; determine that from the live tool schemas and responses before implementing.

No live Salesforce response has been observed yet, so actual tool envelope, pagination, empty-result and permission-denial behavior remain unverified. No adapter change is made in this setup task.

## Official references checked (2026-10-30)

- [Salesforce Hosted MCP setup overview](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/setup-overview.html)
- [Salesforce SObject Reads reference](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/sobject-reads.html)
- [Salesforce server URL guide](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/server-urls.html)
- [Salesforce External Client App setup](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html)
- [Salesforce Hosted MCP client connection overview](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/client-connection-overview.html)
- [Salesforce Hosted MCP GA transition](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/beta-to-ga-transition.html)
- [Codex MCP configuration and OAuth guide](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex configuration basics and project scope](https://learn.chatgpt.com/docs/config-file/config-basic)
- [Salesforce DX MCP setup](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev%20%20/sfdx_dev_mcp_server.htm)
- [Salesforce DX MCP tool reference](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-mcp-use-core-tools.html)
- [VS Code MCP authorization and workspace configuration](https://code.visualstudio.com/api/extension-guides/ai/mcp)
