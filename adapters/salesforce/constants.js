/** Frozen constants shared by the Salesforce adapters and the capture-plan builders. */

/** The only MCP tool the Salesforce adapters ever call (read-only). */
export const SF_TOOL = "dispatch_readonly";
export const DEFAULT_API_VERSION = "v66.0";
export const API_VERSION_PATTERN = /^v\d{2,3}\.\d$/;
export const ACCOUNT_SEARCH_LIMIT = 50;
export const MAX_PAGES_PER_QUERY = 10;
export const MAX_VALUE_LENGTH = 500;

/** Evidence objects in the fixed query order. */
export const OBJECT_ORDER = Object.freeze(["Account", "Opportunity", "Contact", "Task", "Event"]);

/** Maximum records kept per object (the SOQL LIMIT is keep + 1 to detect truncation). */
export const DEFAULT_OBJECT_LIMITS = Object.freeze({
  Account: 1,
  Opportunity: 200,
  Contact: 100,
  Task: 100,
  Event: 50,
});

export const ID_PREFIX = Object.freeze({
  Account: "001",
  Opportunity: "006",
  Contact: "003",
  Task: "00T",
  Event: "00U",
});

export const CLASSIFICATIONS = Object.freeze(["public", "internal", "confidential"]);
