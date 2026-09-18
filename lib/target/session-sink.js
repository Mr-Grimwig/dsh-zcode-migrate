/**
 * The write seam: how planned events reach DSH (FR-4.4).
 *
 * Production writes go through `ctx.sessionPersistence` — the official service,
 * the same one the harness itself writes with — so the plugin inherits the
 * backend's own guarantees (frame encoding, header validation, contiguous-seq
 * checks, crash repair) instead of re-implementing them. Direct-to-disk writing
 * is deliberately *not* implemented: a hand-written artifact would have to
 * reproduce the packed `*-chunks` rows and multi-frame zstd container exactly,
 * and any mistake there would produce a log DSH refuses to resume.
 *
 * A second, in-memory sink exists for tests and for `--dry-run` reporting; both
 * satisfy the same interface, so the migration logic is exercised identically
 * with and without a real backend.
 *
 * The interface is intentionally tiny (`inspect` / `create` / `append`) so a
 * backend that only exposes the older two-method generation still fits: see
 * {@link createPersistenceSink}'s capability probe.
 *
 * @module dsh-zcode-migrate/target/session-sink
 */

import { SEVERITY } from '../core/warnings.js';

/**
 * @typedef {object} SessionSink
 * @property {string} kind - backend label for reports.
 * @property {(id: string) => Promise<{header: object, events: object[]}|undefined>} inspect
 *   Current stored log, or `undefined` when the session is absent.
 * @property {() => Promise<Array<object>|undefined>} list
 *   Every stored session's header, or `undefined` when this backend cannot list
 *   cheaply — the caller then falls back to registry-only bookkeeping.
 * @property {(header: object) => Promise<void>} create - register a new session's metadata.
 * @property {(id: string, events: object[]) => Promise<void>} append - durably append a contiguous batch.
 */

/**
 * Wrap a `ctx.sessionPersistence` service as a {@link SessionSink}.
 *
 * @param {object} sessionPersistence - the harness persistence service.
 * @param {object} [options] - `{ warn }`.
 * @returns {SessionSink} sink backed by the official API.
 */
export function createPersistenceSink(sessionPersistence, options = {}) {
  const warn = options.warn;
  const has = (method) => typeof sessionPersistence?.[method] === 'function';

  if (!has('create') || !has('append')) {
    warn?.add('persistence-incomplete', 'sessionPersistence 缺少 create/append，无法写入会话', {
      severity: SEVERITY.error,
    });
  }

  return {
    kind: 'sessionPersistence',

    async list() {
      if (!has('list')) return undefined;
      try {
        const headers = await sessionPersistence.list();
        return [...headers];
      } catch (error) {
        warn?.add('persistence-list-failed', `列出既有会话失败，本次按注册表判断：${/** @type {Error} */ (error).message}`, {
          severity: SEVERITY.warning,
        });
        return undefined;
      }
    },

    async inspect(id) {
      // `inspect` is the non-mutating read: it never commits crash recovery and
      // never publishes the session, which is what an import wants. Fall back to
      // `load` (the older/alternative generation) when it is unavailable.
      const method = has('inspect') ? 'inspect' : has('load') ? 'load' : undefined;
      if (method === undefined) return undefined;
      try {
        const view = await sessionPersistence[method](id);
        if (view === undefined || view === null) return undefined;
        return { header: view.meta ?? view.header, events: [...view.events] };
      } catch (error) {
        // Absent sessions are the normal path here, and every backend reports
        // that differently; only a real read fault is worth a warning.
        const message = String(/** @type {Error} */ (error)?.message ?? error);
        if (/no session|not found|absent|unknown session|does not exist/i.test(message)) return undefined;
        warn?.add('persistence-inspect-failed', `读取既有会话失败，将按新会话处理：${message}`, {
          severity: SEVERITY.warning,
          where: id,
        });
        return undefined;
      }
    },

    async create(header) {
      await sessionPersistence.create(header);
    },

    async append(id, events) {
      await sessionPersistence.append(id, events);
    },
  };
}

/**
 * In-memory sink for tests and dry runs.
 *
 * Stores the same event objects the real sink would persist, so structural
 * validation and fidelity comparison run against exactly what a real backend
 * would have received.
 *
 * @returns {SessionSink & { sessions: Map<string, {header: object, events: object[]}> }} memory sink.
 */
export function createMemorySink() {
  /** @type {Map<string, {header: object, events: object[]}>} */
  const sessions = new Map();
  return {
    kind: 'memory',
    sessions,
    async list() {
      return [...sessions.values()].map((entry) => entry.header);
    },
    async inspect(id) {
      const entry = sessions.get(id);
      if (entry === undefined) return undefined;
      return { header: entry.header, events: [...entry.events] };
    },
    async create(header) {
      if (sessions.has(header.id)) throw new Error(`session '${header.id}' already exists`);
      sessions.set(header.id, { header, events: [] });
    },
    async append(id, events) {
      const entry = sessions.get(id);
      if (entry === undefined) throw new Error(`session '${id}' was not created`);
      const next = entry.events.length;
      if (events.length > 0 && events[0].seq !== next) {
        throw new Error(`append must start at seq ${next}, got ${events[0].seq}`);
      }
      entry.events.push(...events);
    },
  };
}

/**
 * Re-stamp `seq` on a batch so it continues from `startSeq`.
 *
 * Needed when an increment must carry one extra leading event (a changed title)
 * that the planned log already accounted for at its own position: sequence
 * numbers are positional, so the tail has to move with it. `sourceEventSeqs`
 * references are remapped alongside, since they name seq values.
 *
 * @param {object[]} events - the batch to re-stamp (not mutated).
 * @param {number} startSeq - first seq for the batch.
 * @returns {object[]} fresh events with contiguous seqs.
 */
export function restampSeq(events, startSeq) {
  /** @type {Map<number, number>} */
  const remap = new Map();
  events.forEach((event, index) => remap.set(event.seq, startSeq + index));
  return events.map((event, index) => ({
    ...event,
    seq: startSeq + index,
    ...(Array.isArray(event.sourceEventSeqs)
      ? { sourceEventSeqs: event.sourceEventSeqs.map((seq) => remap.get(seq) ?? seq) }
      : {}),
  }));
}
