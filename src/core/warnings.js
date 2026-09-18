/**
 * Degradation warnings shared by every stage.
 *
 * FR-1.5 requires that any source-side read failure degrade to a warning instead
 * of aborting the import; FR-3.4/FR-4.2 require that source-side gaps (empty
 * reasoning, missing tool result) be *counted and attributed*, never silent.
 * One collector carries all of that to the report, and severity is explicit so
 * a caller can decide whether a warning is acceptable
 * (`source-missing`) or disqualifying (`refused`).
 *
 * @module dsh-zcode-migrate/core/warnings
 */

/** Severities, ordered from harmless to blocking. */
export const SEVERITY = {
  /** Source-side gap that faithful migration cannot fill (counted as such). */
  info: 'info',
  /** Recoverable degradation: something was substituted or skipped. */
  warning: 'warning',
  /** The item could not be migrated; the rest of the run continues. */
  error: 'error',
};

/**
 * @typedef {object} WarningEntry
 * @property {string} code - stable machine-readable code (e.g. `empty-reasoning`).
 * @property {string} severity - one of {@link SEVERITY}.
 * @property {string} message - human-readable, Chinese, states the consequence.
 * @property {string} [sessionId] - source session the entry belongs to.
 * @property {string} [where] - sub-location (message id, part id, path, …).
 * @property {object} [detail] - small structured extra facts for the report.
 */

/** Collects warnings and counters for one run. */
export class WarningLog {
  /** @param {string} [scope] - label used when the collector is nested (per session). */
  constructor(scope) {
    /** @type {WarningEntry[]} */
    this.items = [];
    /** @type {string|undefined} */
    this.scope = scope;
  }

  /**
   * Record one entry.
   * @param {string} code - stable code.
   * @param {string} message - human-readable consequence.
   * @param {object} [extra] - `severity`, `sessionId`, `where`, `detail`.
   * @returns {WarningLog} this collector, for chaining.
   */
  add(code, message, extra = {}) {
    this.items.push({
      code,
      severity: extra.severity ?? SEVERITY.warning,
      message,
      ...(this.scope !== undefined ? { sessionId: this.scope } : {}),
      ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
      ...(extra.where !== undefined ? { where: extra.where } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    });
    return this;
  }

  /** @param {WarningLog} other - merge another collector's entries. */
  merge(other) {
    this.items.push(...other.items);
    return this;
  }

  /** @returns {number} number of recorded entries. */
  get length() {
    return this.items.length;
  }

  /**
   * Count entries per code.
   * @returns {Record<string, number>} code → count.
   */
  counts() {
    const out = {};
    for (const w of this.items) out[w.code] = (out[w.code] ?? 0) + 1;
    return out;
  }

  /** @returns {WarningEntry[]} entries at `error` severity. */
  errors() {
    return this.items.filter((w) => w.severity === SEVERITY.error);
  }

  /** @returns {WarningEntry[]} a detached copy, safe to serialize. */
  toJSON() {
    return this.items.map((w) => ({ ...w }));
  }
}
