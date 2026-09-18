/**
 * Migration registry: what has already been imported (FR-6, FR-7.3).
 *
 * The registry is **bookkeeping, not authority**. Whether a re-import skips,
 * appends, or conflicts is decided by comparing the *stored DSH log* against a
 * freshly planned one (see `reconcile` in `../migrate.js`), because the log is
 * the thing that must stay consistent and it survives a lost or hand-edited
 * registry. What the registry adds is the information the log cannot tell us:
 * which ZCode session a target came from, what the source looked like when it
 * was imported, and how much was migrated.
 *
 * That split is deliberate: deleting the registry costs nothing but a full
 * re-comparison, while trusting a stale registry could silently skip a source
 * that had moved on.
 *
 * @module dsh-zcode-migrate/target/registry
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Registry file name inside the state directory. */
export const REGISTRY_FILE = 'registry.json';

/** Registry schema version (bumped only on an incompatible shape change). */
export const REGISTRY_VERSION = 1;

/**
 * @typedef {object} MigrationRecord
 * @property {string} sourceId - ZCode session id.
 * @property {string} targetId - DSH session id.
 * @property {string} variant - `''` for the canonical target, else the forced-copy token.
 * @property {string} title - source title at import time.
 * @property {string} cwd - source workspace path at import time.
 * @property {string} importedAt - ISO timestamp of the last successful import.
 * @property {string} [firstImportedAt] - ISO timestamp of the first import.
 * @property {'create'|'append'|'force'} lastMode - how that import wrote.
 * @property {number} sourceMessageCount - source messages seen then.
 * @property {number} sourceUpdatedAt - source `time_updated` seen then.
 * @property {string[]} turnDigests - per-turn digests of the stored log.
 * @property {number} eventCount - events in the stored log at that point.
 * @property {object} [stats] - the plan stats of that import, for the report.
 * @property {number} [warningCount] - warnings raised by that import.
 */

/**
 * Load the registry, tolerating absence and corruption.
 *
 * A missing registry is normal (first run). A corrupt one is *reported* rather
 * than fatal: the log-based reconciliation is authoritative, so a fresh
 * registry only costs redundant comparisons.
 *
 * @param {string} stateDir - state directory.
 * @param {object} [options] - `{ warn }`.
 * @returns {{ version: number, sessions: Record<string, MigrationRecord>, loaded: boolean, corrupted?: string }} registry.
 */
export function loadRegistry(stateDir, options = {}) {
  const warn = options.warn;
  const path = join(stateDir, REGISTRY_FILE);
  if (!existsSync(path)) return { version: REGISTRY_VERSION, sessions: {}, loaded: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.sessions !== 'object') {
      throw new Error('registry.json 结构不符合预期');
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : REGISTRY_VERSION,
      sessions: parsed.sessions ?? {},
      loaded: true,
    };
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    warn?.add(
      'registry-unreadable',
      `注册表无法读取（${message}），已按空注册表继续；一致性由 DSH 会话日志本身保证，不会重复导入`,
      { where: path, severity: 'warning' },
    );
    return { version: REGISTRY_VERSION, sessions: {}, loaded: false, corrupted: message };
  }
}

/**
 * Persist the registry atomically (temp file + rename).
 *
 * @param {string} stateDir - state directory (created when absent).
 * @param {object} registry - registry object.
 * @returns {string} the file written.
 */
export function saveRegistry(stateDir, registry) {
  const path = join(stateDir, REGISTRY_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ version: REGISTRY_VERSION, sessions: registry.sessions }, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  return path;
}

/**
 * Registry key for one source session and target variant.
 * @param {string} sourceId - ZCode session id.
 * @param {string} [variant] - forced-copy token (`''` for the canonical target).
 * @returns {string} key.
 */
export function registryKey(sourceId, variant = '') {
  return variant === '' ? sourceId : `${sourceId}#${variant}`;
}

/**
 * Look up one record.
 * @param {object} registry - registry.
 * @param {string} sourceId - ZCode session id.
 * @param {string} [variant] - forced-copy token.
 * @returns {MigrationRecord|undefined} record.
 */
export function getRecord(registry, sourceId, variant = '') {
  return registry.sessions[registryKey(sourceId, variant)];
}

/**
 * Insert or replace one record.
 * @param {object} registry - registry (mutated).
 * @param {MigrationRecord} record - record to store.
 * @returns {MigrationRecord} the stored record.
 */
export function putRecord(registry, record) {
  registry.sessions[registryKey(record.sourceId, record.variant)] = record;
  return record;
}

/**
 * Every record for one source session, newest import first.
 * @param {object} registry - registry.
 * @param {string} sourceId - ZCode session id.
 * @returns {MigrationRecord[]} matching records.
 */
export function recordsFor(registry, sourceId) {
  return Object.values(registry.sessions)
    .filter((record) => record.sourceId === sourceId)
    .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}
