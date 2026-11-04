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

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * Replay client: serves recorded entries by tool name + canonical args.
 * Repeated identical calls consume matching entries in capture order. By default, once a
 * key's entries are consumed the next call throws REPLAY_UNMATCHED (reason `replay_exhausted`);
 * pass `{reuseLast: true}` to keep serving the last entry. Unmatched call -> REPLAY_UNMATCHED
 * (reason `replay_unmatched`); unknown tool -> TOOL_NOT_FOUND; recorded error -> TOOL_ERROR with `payload`.
 * Implements McpToolClient. `calls` records every call with its RAW (unredacted) args.
 */
export class ReplayMcpClient {
  /**
   * @param {{entries: Array<{tool: string, args?: object, result?: *, error?: object}>, tools?: Array<{name: string, description?: string}>, reuseLast?: boolean}} source
   */
  constructor({ entries, tools, reuseLast = false } = {}) {
    this.entries = entries ?? [];
    this.tools = tools ?? [...new Set(this.entries.map((e) => e.tool))].map((name) => ({ name }));
    this.reuseLast = reuseLast === true;
    this.calls = [];
    this.byKey = new Map();
    this.cursor = new Map();
    this.consumed = new Set();
    this.entries.forEach((entry, index) => {
      const key = `${entry.tool}\u0000${canonicalize(entry.args)}`;
      if (!this.byKey.has(key)) this.byKey.set(key, []);
      this.byKey.get(key).push({ entry, index });
    });
  }
  async listTools() { return { tools: this.tools.map((t) => ({ ...t })) }; }
  /** Entries never served so far: [{index, tool}] (no payloads). */
  unconsumed() {
    return this.entries.flatMap((e, index) => (this.consumed.has(index) ? [] : [{ index, tool: e.tool }]));
  }
  async callTool(name, args = {}) {
    this.calls.push({ name, args });
    if (!this.tools.some((t) => t.name === name)) {
      throw new McpClientError("TOOL_NOT_FOUND", `Tool not found: ${name}`, { tool: name });
    }
    const key = `${name}\u0000${canonicalize(args)}`;
    const list = this.byKey.get(key);
    if (!list) throw new McpClientError("REPLAY_UNMATCHED", `No captured response for ${name} with these arguments`, { tool: name, reason: "replay_unmatched" });
    const next = this.cursor.get(key) ?? 0;
    if (next >= list.length && !this.reuseLast) {
      throw new McpClientError("REPLAY_UNMATCHED", `Captured responses for ${name} with these arguments are exhausted`, { tool: name, reason: "replay_exhausted" });
    }
    const { entry, index } = list[Math.min(next, list.length - 1)];
    this.cursor.set(key, next + 1);
    this.consumed.add(index);
    if (entry.error !== undefined) {
      throw new McpClientError("TOOL_ERROR", `Captured tool error for ${name}`, { tool: name, payload: clone(entry.error) });
    }
    return clone(entry.result);
  }
}
