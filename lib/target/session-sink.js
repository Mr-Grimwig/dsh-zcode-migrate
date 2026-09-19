/**
 * The write seam: how planned events reach DSH (FR-4.4).
 *
 * Production writes go through `ctx.sessionPersistence` — the official service,
 * the same one the harness itself writes with — so the plugin inherits the
 * backend's own guarantees (frame encoding, header validation, contiguous-seq
 * checks, crash repair) instead of re-implementing them. Direct-to-disk writing
 * is deliberately *not* implemented: a hand-written artifact would have to
 * reproduce the backend's container exactly, and any mistake there would produce
 * a log DSH refuses to resume.
 *
 * ## Two service generations
 *
 * The harness changed this seam: the older generation exposes
 * `create`/`append`/`inspect` on the service and writes log format v0; the newer
 * one hands out a `SessionHandle` from `create`/`open` and writes format v3,
 * where `assistant/message` carries its stream inline and the header declares
 * `isSeeded` instead of `seedLength`. Both are supported here, chosen by
 * capability probe ({@link detectGeneration}) rather than by a version string,
 * because the API shape is the thing that actually decides how to write.
 *
 * A second, in-memory sink exists for tests and for `--dry-run` reporting; both
 * satisfy the same interface, so the migration logic is exercised identically
 * with and without a real backend.
 *
 * @module dsh-zcode-migrate/target/session-sink
 */

import { SEVERITY } from '../core/warnings.js';

/** Log format version implied by each service generation. */
export const FORMAT_VERSION = Object.freeze({ service: 0, handle: 3 });

/**
 * @typedef {object} SessionSink
 * @property {string} kind - backend label for reports.
 * @property {0|3} formatVersion - the log format this backend reads and writes.
 * @property {(id: string) => Promise<{header: object, events: object[]}|undefined>} inspect
 *   Current stored log, or `undefined` when the session is absent.
 * @property {() => Promise<Array<object>|undefined>} list
 *   Every stored session's header, or `undefined` when this backend cannot list
 *   cheaply — the caller then falls back to registry-only bookkeeping.
 * @property {(header: object) => Promise<void>} create - register a new session's metadata.
 * @property {(id: string, events: object[]) => Promise<void>} append - durably append a contiguous batch.
 */

/**
 * Which generation of the persistence service this is.
 *
 * `open` is the marker: it exists only in the handle generation, and it is the
 * one call the plugin needs for incremental writes there.
 *
 * @param {object} sessionPersistence - the harness persistence service.
 * @returns {'handle'|'service'} generation.
 */
export function detectGeneration(sessionPersistence) {
  return typeof sessionPersistence?.open === 'function' ? 'handle' : 'service';
}

/**
 * Whether an error means "this session does not exist", which every backend
 * reports its own way and which is the normal path for a first import.
 * @param {unknown} error - thrown value.
 * @returns {boolean} true when the session is simply absent.
 */
function isAbsent(error) {
  const message = String(/** @type {Error} */ (error)?.message ?? error);
  return /no session|not found|absent|unknown session|does not exist|ERR_SESSION_PERSISTENCE_NOT_FOUND|SessionPersistenceNotFound/i.test(
    message,
  );
}

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
  const generation = detectGeneration(sessionPersistence);

  if (generation === 'handle' && !has('create')) {
    warn?.add('persistence-incomplete', 'sessionPersistence 既没有 create 也没有可用的写入句柄', {
      severity: SEVERITY.error,
    });
  }
  if (generation === 'service' && (!has('create') || !has('append'))) {
    warn?.add('persistence-incomplete', 'sessionPersistence 缺少 create/append，无法写入会话', {
      severity: SEVERITY.error,
    });
  }

  /** Open write handles, so `create` + `append` behaves like one session write. */
  const handles = new Map();

  /** Open a write handle for the handle generation. */
  const writeHandle = async (id) => {
    const existing = handles.get(id);
    if (existing !== undefined) return existing;
    const handle = await sessionPersistence.open(id, 'write');
    handles.set(id, handle);
    return handle;
  };

  /** Close and forget a write handle. */
  const closeHandle = async (id) => {
    const handle = handles.get(id);
    if (handle === undefined) return;
    handles.delete(id);
    try {
      await handle.flush();
    } finally {
      await handle.close();
    }
  };

  return {
    kind: 'sessionPersistence',
    formatVersion: FORMAT_VERSION[generation],

    async list() {
      if (!has('list')) return undefined;
      try {
        const entries = await sessionPersistence.list();
        // The handle generation lists snapshots; normalize to headers so every
        // caller keeps seeing one shape.
        return [...entries].map((entry) => entry?.header ?? entry);
      } catch (error) {
        warn?.add('persistence-list-failed', `列出既有会话失败，本次按注册表判断：${/** @type {Error} */ (error).message}`, {
          severity: SEVERITY.warning,
        });
        return undefined;
      }
    },

    async inspect(id) {
      try {
        if (generation === 'handle') {
          const handle = await sessionPersistence.open(id, 'read');
          try {
            const result = await handle.read();
            return { header: handle.header, events: [...result.events] };
          } finally {
            await handle.close();
          }
        }
        // `inspect` is the non-mutating read: it never commits crash recovery and
        // never publishes the session, which is what an import wants. Fall back to
        // `load` when it is unavailable.
        const method = has('inspect') ? 'inspect' : has('load') ? 'load' : undefined;
        if (method === undefined) return undefined;
        const view = await sessionPersistence[method](id);
        if (view === undefined || view === null) return undefined;
        return { header: view.meta ?? view.header, events: [...view.events] };
      } catch (error) {
        if (isAbsent(error)) return undefined;
        warn?.add('persistence-inspect-failed', `读取既有会话失败，将按新会话处理：${/** @type {Error} */ (error).message}`, {
          severity: SEVERITY.warning,
          where: id,
        });
        return undefined;
      }
    },

    async create(header) {
      const result = await sessionPersistence.create(header);
      // The handle generation returns the open handle; the older one returns
      // nothing and expects the service-level append.
      if (result !== undefined && typeof result?.append === 'function') handles.set(header.id, result);
    },

    async append(id, events) {
      if (generation === 'handle') {
        const handle = await writeHandle(id);
        await handle.append(events);
        await closeHandle(id);
        return;
      }
      await sessionPersistence.append(id, events);
    },
  };
}

/**
 * In-memory sink for tests and dry runs.
 *
 * Stores the same event objects the real sink would persist, so structural
 * validation and fidelity comparison run against exactly what a real backend
 * would have received. `formatVersion` is configurable so the same tests can
 * exercise both service generations.
 *
 * @param {object} [options] - `{ formatVersion }`, defaults to the newer format.
 * @returns {SessionSink & { sessions: Map<string, {header: object, events: object[]}> }} memory sink.
 */
export function createMemorySink(options = {}) {
  /** @type {Map<string, {header: object, events: object[]}>} */
  const sessions = new Map();
  return {
    kind: 'memory',
    formatVersion: options.formatVersion ?? FORMAT_VERSION.handle,
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
