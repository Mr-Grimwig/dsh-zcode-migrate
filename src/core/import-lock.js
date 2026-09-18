/**
 * A cross-process lock for import runs.
 *
 * Two writers can race here — a boot-time auto-import and a user typing
 * `/zcode-import all` — and DSH's persistence coordinator serializes writes per
 * session but knows nothing about *our* two runs both computing the same
 * increment and both appending it. The lock is what keeps "already imported"
 * decisions meaningful.
 *
 * It is a plain lock file created with `wx` (atomic on every platform), holding
 * the owner's pid and start time. A lock whose owner is gone, or which is older
 * than the staleness window, is taken over — a crashed run must not wedge the
 * plugin forever.
 *
 * @module dsh-zcode-migrate/core/import-lock
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Default staleness window: longer than any plausible import, short enough to self-heal. */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

/** Lock file name inside the state directory. */
export const LOCK_FILE = 'import.lock';

/**
 * Whether a process with this pid exists.
 * @param {number} pid - process id.
 * @returns {boolean} true when it looks alive.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours to signal.
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Acquire the import lock.
 *
 * @param {string} stateDir - state directory (created when absent).
 * @param {object} [options] - `{ label, staleMs, now }`.
 * @returns {{ ok: true, release: () => void, tookOver?: boolean } | { ok: false, reason: string, holder?: object }}
 *   outcome.
 */
export function acquireImportLock(stateDir, options = {}) {
  const path = join(stateDir, LOCK_FILE);
  const label = options.label ?? 'import';
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  mkdirSync(stateDir, { recursive: true });

  const payload = () => `${JSON.stringify({ pid: process.pid, label, startedAt: Date.now() })}\n`;
  /** @type {boolean} */
  let tookOver = false;

  try {
    writeFileSync(path, payload(), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
      return { ok: false, reason: `lock-unwritable: ${/** @type {Error} */ (error).message}` };
    }
    /** @type {object|undefined} */
    let holder;
    try {
      holder = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      holder = undefined;
    }
    const age = holder?.startedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - Number(holder.startedAt);
    const ownerGone = holder?.pid !== undefined && !pidAlive(Number(holder.pid));
    if (age < staleMs && !ownerGone) return { ok: false, reason: 'locked', holder };
    // Take over a stale or orphaned lock.
    writeFileSync(path, payload(), 'utf8');
    tookOver = true;
  }

  let released = false;
  return {
    ok: true,
    tookOver,
    release: () => {
      if (released) return;
      released = true;
      try {
        const holder = JSON.parse(readFileSync(path, 'utf8'));
        // Only remove our own lock: a takeover by a later run must survive us.
        if (Number(holder?.pid) === process.pid) rmSync(path, { force: true });
      } catch {
        /* a missing or unreadable lock is already released */
      }
    },
  };
}

/**
 * Run `body` while holding the import lock, releasing it in every outcome.
 *
 * @param {string} stateDir - state directory.
 * @param {object} options - `{ label, staleMs, onBusy }`.
 * @param {() => Promise<T>} body - work to run under the lock.
 * @returns {Promise<{ ran: true, value: T } | { ran: false, reason: string, holder?: object }>} outcome.
 * @template T
 */
export async function withImportLock(stateDir, options, body) {
  const lock = acquireImportLock(stateDir, options);
  if (!lock.ok) {
    options.onBusy?.(lock);
    return { ran: false, reason: lock.reason, ...(lock.holder !== undefined ? { holder: lock.holder } : {}) };
  }
  try {
    return { ran: true, value: await body() };
  } finally {
    lock.release();
  }
}
