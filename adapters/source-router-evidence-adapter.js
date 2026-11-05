/**
 * EvidenceAdapter that dispatches on `request.source_type` to one adapter per source. Used by the
 * multi-source capture mode (Salesforce `crm` + M365 `internal_document`). It adds no logic of its
 * own: an unknown source is `UNSUPPORTED_SOURCE`, and a thrown error from an adapter propagates to
 * evidence.retrieve, which reports it as an unavailable source.
 * @param {Record<string, import("./evidence-adapter.js").EvidenceAdapter>} adapters source ID -> adapter
 */
export function createSourceRouterEvidenceAdapter(adapters) {
  if (typeof adapters !== "object" || adapters === null || Array.isArray(adapters) || Object.keys(adapters).length === 0) {
    throw new TypeError("createSourceRouterEvidenceAdapter requires a non-empty object of adapters");
  }
  for (const [source, adapter] of Object.entries(adapters)) {
    if (typeof adapter?.retrieve !== "function") throw new TypeError(`adapter for ${source} must implement retrieve()`);
  }
  const table = new Map(Object.entries(adapters));
  return {
    name: `source-router-evidence-adapter(${[...table.keys()].join("+")})`,
    supportedSources: [...table.keys()],
    async retrieve(request) {
      const adapter = table.get(request?.source_type);
      if (!adapter) {
        return {
          ok: false,
          error: { code: "UNSUPPORTED_SOURCE", message: "No adapter serves this source.", retryable: false },
        };
      }
      return adapter.retrieve(request);
    },
  };
}
