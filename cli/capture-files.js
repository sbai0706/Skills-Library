import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared by the capture-plan CLIs: repository paths and the `.captures/`-only skeleton writer. */

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CAPTURES_DIR = resolve(REPO_ROOT, ".captures");

export class CaptureFileUsageError extends Error {}

const underCaptures = (target) => {
  const rel = relative(CAPTURES_DIR, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Write an empty valid `mcp-capture/1` skeleton. Writes only inside `<repo root>/.captures/`
 * (git-ignored); there is deliberately no override; an existing file is never overwritten
 * (the write error has code EEXIST).
 * @param {string} path
 * @param {{sourceSystem: string, connector: string}} options
 * @throws {CaptureFileUsageError} for a refused target
 */
export function initCaptureFile(path, { sourceSystem, connector }) {
  const target = resolve(path);
  const isDirectory = /[\\/]$/.test(path) || target === CAPTURES_DIR || (() => {
    try { return statSync(target).isDirectory(); } catch { return false; }
  })();
  if (isDirectory) throw new CaptureFileUsageError("--init-capture needs a file path such as .captures/<slug>.json, not a directory.");
  if (!underCaptures(target)) {
    throw new CaptureFileUsageError("--init-capture refuses any target outside the repository's .captures/ directory.");
  }
  const doc = {
    format_version: "mcp-capture/1",
    capture: { created_at: new Date().toISOString(), source_system: sourceSystem, connector },
    entries: [],
  };
  mkdirSync(dirname(target), { recursive: true });
  const realRel = relative(realpathSync(CAPTURES_DIR), realpathSync(dirname(target)));
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new CaptureFileUsageError("--init-capture refuses any target outside the repository's .captures/ directory.");
  }
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx" });
  return { initialized: target, entries: 0, note: "Append one entry per recorded call, in call order, then run --validate." };
}
