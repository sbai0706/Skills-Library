import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * Load an evidence fixture directory. Each fixture contains sources.json
 * (per-source data, mode, and account) and expected.json (asserted behavior).
 */
export function loadEvidenceFixture(name) {
  const dir = join(fixturesDir, name);
  return {
    name,
    sources: JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")),
    expected: JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")),
  };
}

/**
 * Fixture-backed evidence adapter. No network access.
 *
 * Per-source modes model real adapter outcomes:
 *   ok                 return the fixture records (default)
 *   unauthorized       authorization denied
 *   unavailable        retryable transport failure
 *   throw              throw an unexpected error
 *   malformed_envelope ok:true with a non-array 'records'
 *   malformed_records  return records exactly as written, including invalid ones,
 *                      so the skill's record validation is exercised
 *
 * @param {object} [options]
 * @param {string} [options.fixture] Fixture directory name.
 * @param {object} [options.sources] Inline sources object, overriding the fixture file.
 * @param {string[]} [options.supportedSources] Declared capabilities.
 * @returns {import("./evidence-adapter.js").EvidenceAdapter}
 */
export function createFixtureEvidenceAdapter(options = {}) {
  const fixture = options.fixture ? loadEvidenceFixture(options.fixture) : null;
  const dataset = options.sources ?? fixture?.sources;
  if (!dataset) throw new Error("createFixtureEvidenceAdapter requires a fixture name or inline sources");

  const supportedSources = options.supportedSources ?? Object.keys(dataset.sources);

  return {
    name: `fixture-evidence-adapter(${options.fixture ?? "inline"})`,
    supportedSources,
    async retrieve(request) {
      const source = dataset.sources[request.source_type];
      if (!source) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_SOURCE",
            message: `Source "${request.source_type}" is not available in this adapter.`,
            retryable: false,
          },
        };
      }
      const mode = source.mode ?? "ok";
      if (mode === "throw") throw new Error(`Simulated transport failure for ${request.source_type}`);
      if (mode === "unauthorized") {
        return {
          ok: false,
          error: {
            code: "ADAPTER_UNAUTHORIZED",
            message: `Caller is not permitted to read ${request.source_type} for this account.`,
            retryable: false,
          },
        };
      }
      if (mode === "unavailable") {
        return {
          ok: false,
          error: {
            code: "ADAPTER_UNAVAILABLE",
            message: `${request.source_type} did not respond within the timeout.`,
            retryable: true,
          },
        };
      }
      if (mode === "malformed_envelope") {
        return { ok: true, records: "not-an-array" };
      }
      return { ok: true, records: structuredClone(source.records ?? []) };
    },
  };
}
