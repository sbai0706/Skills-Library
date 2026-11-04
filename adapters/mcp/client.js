/**
 * MCP tool client interface (shared by Mode A replay and a future Mode B live client).
 *
 * @typedef {Object} McpToolDescriptor
 * @property {string} name
 * @property {string} [description]
 *
 * @typedef {Object} McpToolResult
 * @property {Array<{type: string, text?: string}>} [content]
 * @property {object} [structuredContent]
 * @property {boolean} [isError]
 *
 * @typedef {Object} McpToolClient
 * @property {() => Promise<{tools: McpToolDescriptor[]}>} listTools
 * @property {(name: string, args?: object) => Promise<McpToolResult|object>} callTool
 *   Resolves with the tool result; rejects with an Error (ideally McpClientError)
 *   for transport/connector failures. Use mapMcpError / unwrapToolResult to turn
 *   either outcome into an ADAPTER_* error.
 */

/** Error thrown by clients. `code` is one of MCP_CLIENT_ERROR_CODES; `payload` is a raw connector error, if any. */
export class McpClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
    Object.assign(this, details);
  }
}

export const MCP_CLIENT_ERROR_CODES = Object.freeze([
  "TOOL_NOT_FOUND",
  "REPLAY_UNMATCHED",
  "TOOL_ERROR",
]);

/**
 * Check an object against the McpToolClient interface. Returns problems (empty when valid).
 * @param {unknown} client
 * @returns {string[]}
 */
export function mcpClientProblems(client) {
  if (typeof client !== "object" || client === null) return ["client is not an object"];
  const problems = [];
  if (typeof client.listTools !== "function") problems.push("listTools is not a function");
  if (typeof client.callTool !== "function") problems.push("callTool is not a function");
  return problems;
}

/** Throw a TypeError when `client` does not satisfy McpToolClient; otherwise return it. */
export function assertMcpToolClient(client) {
  const problems = mcpClientProblems(client);
  if (problems.length > 0) throw new TypeError(`Invalid McpToolClient: ${problems.join("; ")}`);
  return client;
}

/** Validate a listTools() response. Returns problems (empty when valid). */
export function listToolsProblems(response) {
  if (typeof response !== "object" || response === null || !Array.isArray(response.tools)) {
    return ["listTools result must be {tools: []}"];
  }
  return response.tools.flatMap((tool, i) =>
    typeof tool?.name === "string" && tool.name !== "" ? [] : [`tools[${i}]: name missing or empty`]);
}
