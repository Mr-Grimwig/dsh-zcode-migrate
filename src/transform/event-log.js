/**
 * Reading a session log as *turns of content*.
 *
 * One module owns this because two very different callers must agree on it
 * exactly:
 *
 * - the planner, which records per-turn digests so a later run can tell "nothing
 *   changed" from "the source was rewritten" (FR-6);
 * - reconciliation, which compares a stored log against a freshly planned one.
 *
 * If they disagreed by a single field, every import would look like a conflict.
 *
 * ## Content vs. bookkeeping
 *
 * The harness surrounds a migrated log with events that are not migrated
 * content: `session/end-seed` marks the seed boundary every time a session is
 * resumed, `permission/preset` / `sandbox/mode` / `approval/policy` describe the
 * environment, `request/header` / `request/context` describe a model call, and
 * `todo/write`, `command/run`, `command/done`, `session/title` and
 * `assistant/chunk` are log-only state or stream fragments.
 *
 * Reconciliation therefore compares only {@link CONTENT_EVENT_TYPES}, and
 * digests only each event's `type` and `data`. Positional metadata (`seq`,
 * `time`, `surfaceOp`, `sourceEventSeqs`) is excluded on purpose: inserting one
 * lifecycle event shifts all of it, and a session that was merely *opened* in
 * DSH must not look rewritten.
 *
 * The full event count is still tracked per turn, because appending needs the
 * true next sequence number — content comparison and sequence math are
 * deliberately separate.
 *
 * @module dsh-zcode-migrate/transform/event-log
 */

import { sha256, stableStringify } from '../core/digest.js';

/**
 * Version of the content-digest scheme.
 *
 * Recorded alongside the digests, because a scheme change is not a data change:
 * an existing registry's digests were computed by the previous rule, and
 * comparing them against the new rule would report every migrated session as
 * broken. When the version differs, verification re-derives the expectation from
 * the current source instead of trusting the stale numbers.
 *
 * Bump this whenever {@link splitTurns}'s digest input changes.
 */
export const CONTENT_DIGEST_VERSION = 2;

/** Events that carry migrated content — the only ones reconciliation compares. */
export const CONTENT_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
]);

/**
 * @typedef {object} TurnSlice
 * @property {number|null} turn - the turn number the slice belongs to.
 * @property {string} digest - content digest, empty for a contentless slice.
 * @property {number} eventCount - every stored event in the slice.
 * @property {boolean} contentless - true when the slice holds no content events.
 */

/**
 * Split an event log into the prelude and its turn slices.
 *
 * The prelude is everything outside a `turn/start` … `turn/end` bracket: the
 * head of the log (a title, environment events) *and* any trailing bracket left
 * by a resume. Its length still counts toward the sequence.
 *
 * @param {object[]} events - events in log order.
 * @returns {{ prelude: object[], contentPrelude: object[], turns: TurnSlice[], consumed: number }} parts of the log.
 */
export function splitTurns(events) {
  /** @type {object[]} */
  const prelude = [];
  /** @type {TurnSlice[]} */
  const turns = [];
  /** @type {object[]|null} */
  let current = null;
  let currentTurn = null;

  const close = () => {
    if (current === null) return;
    const content = current.filter((event) => CONTENT_EVENT_TYPES.has(event.type));
    turns.push({
      turn: currentTurn,
      digest:
        content.length === 0
          ? ''
          : sha256(stableStringify(content.map((event) => ({ type: event.type, data: event.data })))),
      eventCount: current.length,
      contentless: content.length === 0,
    });
    current = null;
    currentTurn = null;
  };

  for (const event of events) {
    if (event.type === 'turn/start') {
      close();
      current = [event];
      currentTurn = typeof event.data?.turn === 'number' ? event.data.turn : null;
      continue;
    }
    if (current === null) {
      prelude.push(event);
      continue;
    }
    current.push(event);
    if (event.type === 'turn/end') close();
  }
  close();

  return {
    prelude,
    contentPrelude: prelude.filter((event) => CONTENT_EVENT_TYPES.has(event.type)),
    turns,
    consumed: prelude.length + turns.reduce((total, turn) => total + turn.eventCount, 0),
  };
}
