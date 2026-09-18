/**
 * Barrel for the dependency-free core utilities.
 *
 * Exported as `dsh-zcode-migrate/core` so tests and external tooling can reach
 * the pure pieces — configuration resolution, digests, and the warning log —
 * without loading the plugin entry (which probes for harness packages).
 *
 * @module dsh-zcode-migrate/core
 */

export { DEFAULT_CONFIG, SOURCE_MODES, expandHomePath, normalizeConfig, resolveDshHome, resolveZcodeHome } from './config.js';
export { MIGRATE_NAMESPACE, deterministicUuid, messageId, sha256, shortHash, stableStringify, stateFileName, targetSessionId } from './digest.js';
export { SEVERITY, WarningLog } from './warnings.js';
