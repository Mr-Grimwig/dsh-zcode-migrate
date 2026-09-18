/**
 * Configuration defaults, normalization, and home resolution (FR-1.1).
 *
 * The plugin must work with *no* configuration, so every field has a default
 * and normalization is total: unknown fields are ignored, bad types fall back
 * with a warning rather than throwing. The same normalizer serves the cordis
 * loader config, the settings namespace, and the standalone CLI, so all three
 * paths behave identically.
 *
 * @module dsh-zcode-migrate/core/config
 */

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * @typedef {object} MigrateConfig
 * @property {string|undefined} source - explicit ZCode home (FR-1.1, highest precedence).
 * @property {'auto'|'db'|'rollout'} sourceMode - which primary source to read.
 * @property {boolean} legacy - also read the pre-3.0 `projects/**\/*.jsonl` layout.
 * @property {boolean} createMissingDirs - create a workspace dir that no longer exists.
 * @property {'off'|'pending'} autoImport - top up pending sessions at boot, without being asked.
 * @property {string} stateDir - registry + report directory.
 * @property {number} maxSessions - 0 = no limit; otherwise newest N by default.
 * @property {boolean} report - write a JSON/markdown report next to the registry.
 */

/** Field defaults, also the schema defaults surfaced to the settings UI. */
export const DEFAULT_CONFIG = Object.freeze({
  source: undefined,
  sourceMode: 'auto',
  legacy: false,
  createMissingDirs: false,
  autoImport: 'pending',
  stateDir: undefined,
  maxSessions: 0,
  report: true,
});

/** Source modes this plugin understands. */
export const SOURCE_MODES = Object.freeze(['auto', 'db', 'rollout']);

/** Auto-import modes. */
export const AUTO_IMPORT_MODES = Object.freeze(['off', 'pending']);

/**
 * The default auto-import mode.
 *
 * `pending` is deliberate: this plugin exists to keep a DSH install in step with
 * a ZCode install, and "install once, then never think about it again" is the
 * simplest operation the requirement can have. A boot-time pass only ever
 * appends sessions ZCode gained since the last run, and never forces a rewrite
 * (FR-6.3) — the cost of being wrong is a scan and a log line.
 *
 * @returns {'off'|'pending'} the default mode.
 */
export function autoImportDefault() {
  return DEFAULT_CONFIG.autoImport;
}

/**
 * Expand a leading `~`, matching DSH's own rule.
 * @param {string} path - candidate path.
 * @returns {string} expanded path.
 */
export function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the DSH home: configured > `$DSH_HOME` > `~/.dsh`.
 * @param {string} [configured] - explicit override.
 * @param {Record<string, string|undefined>} [env] - environment (defaults to `process.env`).
 * @returns {string} absolute DSH home.
 */
export function resolveDshHome(configured, env = process.env) {
  const candidates = [configured, env.DSH_HOME];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const expanded = expandHomePath(candidate.trim());
      return isAbsolute(expanded) ? normalize(expanded) : resolve(expanded);
    }
  }
  return join(homedir(), '.dsh');
}

/**
 * Resolve the ZCode home: explicit source > `$ZCODE_HOME` > `~/.zcode` (FR-1.1).
 * @param {string} [configured] - explicit `source` config value.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {{ path: string, origin: 'config'|'env'|'default' }} resolved home and why.
 */
export function resolveZcodeHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = expandHomePath(configured.trim());
    return { path: isAbsolute(expanded) ? normalize(expanded) : resolve(expanded), origin: 'config' };
  }
  const fromEnv = env.ZCODE_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const expanded = expandHomePath(fromEnv.trim());
    return { path: isAbsolute(expanded) ? normalize(expanded) : resolve(expanded), origin: 'env' };
  }
  return { path: join(homedir(), '.zcode'), origin: 'default' };
}

/**
 * Coerce one boolean field.
 * @param {unknown} value - raw value.
 * @param {boolean} fallback - default.
 * @returns {boolean} coerced value.
 */
function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

/**
 * Normalize raw configuration into a total {@link MigrateConfig}.
 * @param {Partial<MigrateConfig>} [raw] - raw config from any surface.
 * @param {Record<string, string|undefined>} [env] - environment for home resolution.
 * @returns {MigrateConfig & { zcodeHome: string, zcodeHomeOrigin: string, dshHome: string, stateDirResolved: string }}
 *   normalized config with resolved homes.
 */
export function normalizeConfig(raw = {}, env = process.env) {
  const source =
    typeof raw.source === 'string' && raw.source.trim() !== '' ? raw.source.trim() : DEFAULT_CONFIG.source;
  const zcodeHome = resolveZcodeHome(source, env);
  const dshHome = resolveDshHome(undefined, env);

  const sourceMode = SOURCE_MODES.includes(raw.sourceMode) ? raw.sourceMode : DEFAULT_CONFIG.sourceMode;
  const autoImport = AUTO_IMPORT_MODES.includes(raw.autoImport) ? raw.autoImport : DEFAULT_CONFIG.autoImport;
  const stateDirRaw = typeof raw.stateDir === 'string' && raw.stateDir.trim() !== '' ? raw.stateDir.trim() : undefined;
  const stateDirResolved = stateDirRaw === undefined
    ? join(dshHome, 'zcode-migrate')
    : resolve(expandHomePath(stateDirRaw));

  const maxSessionsRaw = Number(raw.maxSessions);
  const maxSessions =
    Number.isFinite(maxSessionsRaw) && maxSessionsRaw > 0 ? Math.floor(maxSessionsRaw) : DEFAULT_CONFIG.maxSessions;

  return {
    source,
    sourceMode,
    legacy: bool(raw.legacy, DEFAULT_CONFIG.legacy),
    createMissingDirs: bool(raw.createMissingDirs, DEFAULT_CONFIG.createMissingDirs),
    autoImport,
    stateDir: stateDirRaw,
    maxSessions,
    report: bool(raw.report, DEFAULT_CONFIG.report),
    zcodeHome: zcodeHome.path,
    zcodeHomeOrigin: zcodeHome.origin,
    dshHome,
    stateDirResolved,
  };
}
