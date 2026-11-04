import { McpClientError } from "./client.js";

/** Deterministic JSON with recursively sorted object keys (arrays keep order). */
export function canonicalize(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value ?? {}));
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Replay client: serves recorded entries by tool name + canonical args.
 * Repeated identical calls consume matching entries in capture order; the last
 * one is reused afterwards. Unmatched call -> McpClientError REPLAY_UNMATCHED;
 * unknown tool -> TOOL_NOT_FOUND; recorded error -> TOOL_ERROR with `payload`.
 * Implements McpToolClient. `calls` records every call for assertions.
 */
export class ReplayMcpClient {
  /**
   * @param {{entries: Array<{tool: string, args?: object, result?: object, error?: object}>, tools?: Array<{name: string, description?: string}>}} source
   */
  constructor({ entries, tools } = {}) {
    this.entries = entries ?? [];
    this.tools = tools ?? [...new Set(this.entries.map((e) => e.tool))].map((name) => ({ name }));
    this.calls = [];
    this.byKey = new Map();
    this.cursor = new Map();
    for (const entry of this.entries) {
      const key = `${entry.tool}\u0000${canonicalize(entry.args)}`;
      if (!this.byKey.has(key)) this.byKey.set(key, []);
      this.byKey.get(key).push(entry);
    }
  }
  async listTools() { return { tools: this.tools.map((t) => ({ ...t })) }; }
  async callTool(name, args = {}) {
    this.calls.push({ name, args });
    if (!this.tools.some((t) => t.name === name)) {
      throw new McpClientError("TOOL_NOT_FOUND", `Tool not found: ${name}`, { tool: name });
    }
    const key = `${name}\u0000${canonicalize(args)}`;
    const list = this.byKey.get(key);
    if (!list) throw new McpClientError("REPLAY_UNMATCHED", `No captured response for ${name} with these arguments`, { tool: name });
    const i = Math.min(this.cursor.get(key) ?? 0, list.length - 1);
    this.cursor.set(key, i + 1);
    const entry = list[i];
    if (entry.error !== undefined) {
      throw new McpClientError("TOOL_ERROR", `Captured tool error for ${name}`, { tool: name, payload: clone(entry.error) });
    }
    return clone(entry.result);
  }
}
