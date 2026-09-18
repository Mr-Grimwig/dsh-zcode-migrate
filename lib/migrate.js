/**
 * Import orchestration: scan → plan → reconcile → write → verify → report.
 *
 * ## What makes a second import safe (FR-6)
 *
 * Reconciliation compares the **stored DSH log** with a freshly planned one,
 * turn by turn, using the per-turn digests the plan carries:
 *
 * - stored log absent                → `create`   (FR-4.1)
 * - stored turns are a prefix, same  → `skip`     (FR-6.1, idempotent)
 * - stored turns are a strict prefix → `append`   (FR-6.2, tail only)
 * - anything else                    → `conflict` (FR-6.3, refuse; `--force` copies)
 *
 * The stored log is the authority rather than the registry because that is the
 * artifact whose consistency actually matters: if the registry is lost, this
 * still refuses to overwrite, and if the log was hand-edited, this notices.
 *
 * ## What makes the result trustworthy (NFR-3, AC-1)
 *
 * After writing, the log is read back through the same official API and every
 * reasoning block is compared with its source counterpart using `===`. The
 * verdict lands in the report, so fidelity is a *checked result* rather than a
 * claim.
 *
 * @module dsh-zcode-migrate/migrate
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEVERITY, WarningLog } from './core/warnings.js';
import { sha256, shortHash, stableStringify, targetSessionId } from './core/digest.js';
import { planSession } from './transform/plan.js';
import { validateEventLog } from './transform/validate.js';
import { restampSeq } from './target/session-sink.js';
import { reasoningBlocksOf } from './target/dsh-log-reader.js';
import { CONTENT_DIGEST_VERSION, CONTENT_EVENT_TYPES, splitTurns } from './transform/event-log.js';
import { getRecord, loadRegistry, putRecord } from './target/registry.js';
import { mountWorkspace } from './target/workspace.js';
import { listSessions as listSqliteSessions, openZcodeDatabase, readSession as readSqliteSession } from './source/sqlite-source.js';
import { listRolloutSessions, readRolloutSession } from './source/rollout-source.js';
import { listLegacySessions, readLegacySession } from './source/legacy-source.js';

/**
 * Find the first `session/title` event in a slice.
 * @param {object[]} events - events to scan.
 * @returns {object|undefined} the title event.
 */
function titleEventOf(events) {
  return events.find((event) => event.type === 'session/title');
}

/**
 * Decide what to do with one plan against the stored target log.
 *
 * @param {object} plan - plan from `planSession`.
 * @param {{header: object, events: object[]}|undefined} stored - current stored log.
 * @returns {{ mode: 'create'|'skip'|'append'|'conflict', events?: object[], reason?: string, detail?: object }}
 *   the decision; `append` carries the events still to write.
 */
export function reconcile(plan, stored) {
  const planned = splitTurns(plan.events);

  if (stored === undefined) return { mode: 'create', events: plan.events };
  if (stored.events.length === 0) {
    // Created but never materialized: everything still has to be written.
    return { mode: 'append', events: plan.events };
  }

  const existing = splitTurns(stored.events);

  // Prelude comparison ignores `session/title` (whose whole point is to change
  // over time — a rename appends a new one rather than rewriting history) and
  // every non-content event, so the harness's own bookkeeping cannot make an
  // already-imported session look rewritten.
  if (stableStringify(planned.contentPrelude) !== stableStringify(existing.contentPrelude)) {
    return {
      mode: 'conflict',
      reason: 'prelude-differs',
      detail: {
        stored: existing.contentPrelude.map((e) => e.type),
        planned: planned.contentPrelude.map((e) => e.type),
      },
    };
  }

  // Contentless slices (a resume bracket) carry no migrated content and so are
  // not turns for comparison purposes.
  const storedTurns = existing.turns.filter((turn) => !turn.contentless);
  const plannedTurns = planned.turns.filter((turn) => !turn.contentless);

  if (storedTurns.length > plannedTurns.length) {
    return {
      mode: 'conflict',
      reason: 'source-shrank',
      detail: { storedTurns: storedTurns.length, plannedTurns: plannedTurns.length },
    };
  }

  for (let index = 0; index < storedTurns.length; index += 1) {
    if (storedTurns[index].digest !== plannedTurns[index].digest) {
      return {
        mode: 'conflict',
        reason: 'turn-content-rewritten',
        detail: { turnIndex: index, storedTurn: storedTurns[index].turn, plannedTurn: plannedTurns[index].turn },
      };
    }
  }

  const slot = stored.header ?? {};
  if (typeof slot.createdAt === 'number' && slot.createdAt !== plan.header.createdAt) {
    return {
      mode: 'conflict',
      reason: 'header-created-at-differs',
      detail: { stored: slot.createdAt, planned: plan.header.createdAt },
    };
  }
  if (typeof slot.cwd === 'string' && typeof plan.header.cwd === 'string' && slot.cwd !== plan.header.cwd) {
    return {
      mode: 'conflict',
      reason: 'header-cwd-differs',
      detail: { stored: slot.cwd, planned: plan.header.cwd },
    };
  }

  const plannedTitle = titleEventOf(planned.prelude);
  const storedTitle = titleEventOf(existing.prelude);
  const titleChanged =
    plannedTitle !== undefined &&
    (storedTitle === undefined || storedTitle.data?.title !== plannedTitle.data?.title);

  // Where to cut *the plan* is a different question from where the next sequence
  // number starts, and conflating them corrupts the log: a stored log that was
  // resumed carries lifecycle events the plan does not have, so slicing the plan
  // at the stored event count cuts into the middle of a turn and appends a
  // fragment. The plan is cut by its own event counts over the turns that
  // matched; the stored count is used only as the starting seq.
  const consumedInPlan =
    planned.prelude.length +
    plannedTurns.slice(0, storedTurns.length).reduce((total, turn) => total + turn.eventCount, 0);
  const tail = plan.events.slice(consumedInPlan);
  if (tail.length === 0 && !titleChanged) return { mode: 'skip' };

  /** @type {object[]} */
  let increment = tail;
  if (titleChanged) {
    increment = [
      {
        type: 'session/title',
        seq: existing.consumed,
        time: plan.titleTime,
        data: plannedTitle.data,
      },
      ...tail,
    ];
  }
  return {
    mode: 'append',
    events: restampSeq(increment, existing.consumed),
    ...(titleChanged ? { detail: { titleChanged: true } } : {}),
  };
}

/**
 * Read back a stored log and compare every reasoning block with its source.
 *
 * This is AC-1/NFR-3 as an executable check: source order, block count, and
 * exact text (`===`) for every migrated reasoning block.
 *
 * @param {import('./source/model.js').SourceSession} session - source session.
 * @param {object[]} storedEvents - events read back from the target.
 * @returns {{ ok: boolean, sourceBlocks: number, storedBlocks: number, chars: number, firstMismatch?: object }}
 *   verdict.
 */
export function verifyFidelity(session, storedEvents) {
  const sourceTexts = session.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.kind === 'reasoning' && part.text !== '')
    .map((part) => part.text);
  const storedTexts = storedEvents
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text);

  const chars = storedTexts.reduce((total, text) => total + text.length, 0);
  if (sourceTexts.length !== storedTexts.length) {
    return {
      ok: false,
      sourceBlocks: sourceTexts.length,
      storedBlocks: storedTexts.length,
      chars,
      firstMismatch: { index: -1, reason: 'count-differs' },
    };
  }
  for (let index = 0; index < sourceTexts.length; index += 1) {
    if (sourceTexts[index] !== storedTexts[index]) {
      return {
        ok: false,
        sourceBlocks: sourceTexts.length,
        storedBlocks: storedTexts.length,
        chars,
        firstMismatch: {
          index,
          reason: 'text-differs',
          sourceChars: sourceTexts[index].length,
          storedChars: storedTexts[index].length,
          sourceHead: sourceTexts[index].slice(0, 60),
          storedHead: storedTexts[index].slice(0, 60),
        },
      };
    }
  }
  return { ok: true, sourceBlocks: sourceTexts.length, storedBlocks: storedTexts.length, chars };
}

/**
 * Open the best available source reader (FR-1.2/1.3/1.4).
 *
 * `auto` prefers SQLite and falls back to the rollout transcripts; an explicit
 * mode is honoured even when the preferred file is missing, so the user can see
 * the specific failure instead of a silent switch.
 *
 * @param {object} config - normalized config.
 * @param {import('./core/warnings.js').WarningLog} warn - warning sink.
 * @returns {{ kind: 'sqlite'|'rollout'|'none', list: (o?: object) => Array<object>, read: (id: string, o?: object) => object|undefined, close: () => void, detail: object }}
 *   a source facade.
 */
export function openSource(config, warn) {
  const sqlite = config.sourceMode === 'rollout' ? { ok: false, reason: 'mode-disabled', path: '' } : openZcodeDatabase(config.zcodeHome, { warn });

  if (sqlite.ok) {
    return {
      kind: 'sqlite',
      list: (options = {}) => listSqliteSessions(sqlite, options),
      read: (id, options = {}) => readSqliteSession(sqlite, id, options),
      close: () => sqlite.close(),
      detail: { path: sqlite.path },
    };
  }

  if (sqlite.reason === 'database-missing' || sqlite.reason === 'mode-disabled') {
    warn?.add(
      'source-rollout-fallback',
      `ZCode SQLite 主数据源不可用（${sqlite.reason}${sqlite.path ? `: ${sqlite.path}` : ''}），已改用 rollout 兜底源（FR-1.3）`,
      { severity: 'warning' },
    );
  }

  return {
    kind: 'rollout',
    list: (options = {}) => listRolloutSessions(config.zcodeHome, options),
    read: (id, options = {}) => readRolloutSession(config.zcodeHome, id, options),
    close: () => {},
    detail: { path: join(config.zcodeHome, 'cli', 'rollout') },
  };
}

/**
 * Which source sessions still need work, and why.
 *
 * Two independent reasons, because either alone is insufficient:
 *
 * - **the source moved on** — the registry recorded a different `time_updated`
 *   than the source reports now (FR-6.2). Cheap: no session log is read.
 * - **the target is missing** — the registry claims an import that the store
 *   does not contain (a deleted session, a restored `storages/` backup, a
 *   different DSH home). Registry-only bookkeeping would report "up to date"
 *   while the sidebar shows nothing, so the store is consulted once for the
 *   whole set rather than per session.
 *
 * Sessions whose import was *refused* (a conflict recorded in the registry) are
 * left out of the pending set, because retrying cannot resolve them and
 * re-reporting them on every boot would make the report noise. `--force` is the
 * deliberate way back in, and {@link status} surfaces them as blocked.
 *
 * @param {object} options - `{ config, registry, sink, warn, force }`.
 * @returns {Promise<{ ids: string[], sourceMovedOn: number, missingInStore: number, blocked: string[], total: number, force: boolean, inventory: object }>}
 *   the pending set.
 */
export { CONTENT_EVENT_TYPES, splitTurns };

export async function pendingSessions(options) {
  const { config, registry, sink, warn } = options;
  const force = options.force === true;
  const inventory = scan(config, { warn });

  /** @type {Set<string>} */
  let stored = new Set();
  let storeKnown = false;
  if (sink !== undefined && typeof sink.list === 'function') {
    const headers = await sink.list();
    if (headers !== undefined) {
      stored = new Set(headers.map((header) => String(header.id)));
      storeKnown = true;
    }
  }

  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const blocked = [];
  let sourceMovedOn = 0;
  let missingInStore = 0;
  for (const summary of inventory.sessions) {
    if (force) {
      ids.push(summary.id);
      continue;
    }
    const record = registry.sessions[summary.id];
    if (record === undefined) {
      ids.push(summary.id);
      continue;
    }
    if (record.conflict !== undefined) {
      blocked.push(summary.id);
      continue;
    }
    const moved = record.sourceUpdatedAt !== summary.updatedAt;
    const missing = storeKnown && !stored.has(String(record.targetId));
    if (moved) sourceMovedOn += 1;
    if (missing) missingInStore += 1;
    if (moved || missing) ids.push(summary.id);
  }

  const limited = config.maxSessions > 0 ? ids.slice(0, config.maxSessions) : ids;
  return { ids: limited, sourceMovedOn, missingInStore, blocked, total: inventory.sessions.length, force, inventory };
}

/**
 * Verify one migrated session: the stored log against the plan it was imported
 * from, and the current source against that same plan.
 *
 * Two different questions, deliberately kept apart:
 *
 * 1. **Did the migration write what it said it would?** — the stored log's
 *    per-turn digests must equal the recorded ones, and the reasoning blocks
 *    must equal the source's byte for byte. This is the AC-1/NFR-3 claim, and it
 *    is a statement about a *moment*: the import.
 * 2. **Has the source moved on since?** — reported as drift, not as a failure.
 *    A live ZCode session keeps growing, and FR-6.2 answers that with an append,
 *    so treating "the source is longer now" as a verification failure would make
 *    the check useless for exactly the sessions people care about most.
 *
 * @param {object} options - `{ record, artifact, plan, sourceReasoning, warn }`.
 * @returns {object} verification verdict with drift facts.
 */
export function verifyRecord(options) {
  const { record, artifact, plan } = options;
  const storedTurns = artifact === undefined
    ? []
    : splitTurns(artifact.events).turns.filter((turn) => !turn.contentless).map((turn) => turn.digest);
  const recorded = Array.isArray(record.turnDigests) ? record.turnDigests : [];
  const currentScheme = record.digestVersion === CONTENT_DIGEST_VERSION;

  // Digests written by an older scheme cannot be compared against the current
  // one — that would report every previously migrated session as broken. The
  // question is still answerable: does the stored log match the plan the
  // *current* source produces?
  const planTurns = plan?.digests?.turns;
  const matchesPlan =
    Array.isArray(planTurns) &&
    storedTurns.length <= planTurns.length &&
    storedTurns.every((digest, index) => digest === planTurns[index]);

  const logMatchesRecord =
    artifact !== undefined &&
    currentScheme &&
    storedTurns.length === recorded.length &&
    storedTurns.every((digest, index) => digest === recorded[index]);

  // Drift: how many planned turns are new relative to the recorded import, and
  // whether the recorded prefix is still intact.
  let drift = 0;
  let prefixIntact = true;
  if (plan !== undefined) {
    drift = plan.digests.turns.length - recorded.length;
    if (currentScheme) {
      for (let index = 0; index < recorded.length && index < plan.digests.turns.length; index += 1) {
        if (recorded[index] !== plan.digests.turns[index]) {
          prefixIntact = false;
          break;
        }
      }
    } else {
      // An older record only carries the drift count; the current plan is the
      // available authority on whether the prefix still lines up.
      prefixIntact = matchesPlan;
    }
  }

  const blocks = artifact === undefined ? [] : reasoningBlocksOf(artifact.events);
  /** @type {object|undefined} */
  let fidelity;
  const expected = options.sourceReasoning;
  if (Array.isArray(expected) && drift <= 0 && prefixIntact) {
    fidelity = expected.length === blocks.length && expected.every((text, index) => text === blocks[index].text);
  }

  return {
    sourceId: record.sourceId,
    targetId: record.targetId,
    // A record from an older digest scheme is verified against the current
    // plan instead; `legacyRecord` tells the caller which question was answered.
    ok: currentScheme ? logMatchesRecord : matchesPlan,
    legacyRecord: !currentScheme,
    storedTurns: storedTurns.length,
    recordedTurns: recorded.length,
    storedEvents: artifact?.events.length ?? 0,
    chunkRows: artifact?.chunkRows ?? 0,
    reasoningBlocks: blocks.length,
    reasoningChars: blocks.reduce((total, block) => total + block.text.length, 0),
    drift,
    prefixIntact,
    fidelity: fidelity === undefined ? null : fidelity,
    ...(artifact?.path !== undefined ? { path: artifact.path } : {}),
  };
}

/**
 * Read the source session's reasoning texts, for verification and for the plan
 * summary the CLI prints.
 *
 * @param {import('./source/model.js').SourceSession} session - source session.
 * @returns {string[]} non-empty reasoning texts in order.
 */
export function reasoningTextsOf(session) {
  return session.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.kind === 'reasoning' && part.text !== '')
    .map((part) => part.text);
}

/**
 * List every migratable source session, newest first.
 *
 * @param {object} config - normalized config.
 * @param {object} [options] - `{ warn }`.
 * @returns {{ sourceKind: string, sessions: Array<object>, warnings: object[] }} inventory.
 */
export function scan(config, options = {}) {
  const warn = options.warn ?? new WarningLog();
  const source = openSource(config, warn);
  /** @type {Array<object>} */
  const sessions = source.list({ warn }).map((summary) => ({
    ...summary,
    targetId: targetSessionId(summary.id),
    sourceKind: source.kind,
  }));

  if (config.legacy) {
    const legacy = listLegacySessions(config.zcodeHome, { warn });
    for (const summary of legacy) {
      sessions.push({ ...summary, targetId: targetSessionId(summary.id), sourceKind: 'legacy' });
    }
  }
  source.close();
  return { sourceKind: source.kind, detail: source.detail, sessions, warnings: warn.toJSON() };
}

/**
 * Import one source session end to end.
 *
 * @param {object} options - `{ config, sourceId, sink, registry, warn, force, workspaceRegistry, dryRun }`.
 * @returns {Promise<object>} a per-session result for the report.
 */
export async function importSession(options) {
  const {
    config,
    sourceId,
    sink,
    registry,
    force = false,
    workspaceRegistry,
    dryRun = false,
    sourceFacade,
  } = options;
  const warn = options.warn ?? new WarningLog(sourceId);

  const source = sourceFacade ?? openSource(config, warn);
  let session;
  try {
    session = source.kind === 'legacy' ? readLegacySession(config.zcodeHome, sourceId, { warn }) : source.read(sourceId, { warn });
  } catch (error) {
    warn.add('source-read-failed', `读取源会话失败：${/** @type {Error} */ (error).message}`, {
      sessionId: sourceId,
      severity: SEVERITY.error,
    });
    return { sourceId, status: 'failed', reason: 'read-failed', warnings: warn.toJSON() };
  } finally {
    if (sourceFacade === undefined) source.close();
  }

  if (session === undefined) {
    warn.add('source-session-missing', '源会话不存在或无法读取', { sessionId: sourceId, severity: SEVERITY.error });
    return { sourceId, status: 'failed', reason: 'missing', warnings: warn.toJSON() };
  }

  if (session.messages.length === 0) {
    warn.add('source-session-empty', '源会话没有任何消息，已跳过（不产生空的 DSH 会话）', {
      sessionId: sourceId,
      severity: SEVERITY.info,
    });
    return { sourceId, status: 'skipped', reason: 'empty-source', warnings: warn.toJSON() };
  }

  const record = getRecord(registry, sourceId);
  const planned = planSession(session, { warn });
  const verdict = validateEventLog(planned.events);
  if (!verdict.ok) {
    warn.add('event-log-invalid', `生成的事件流未通过结构校验，已中止该会话的导入：${verdict.errors.slice(0, 3).join('；')}`, {
      sessionId: sourceId,
      severity: SEVERITY.error,
    });
    return {
      sourceId,
      status: 'failed',
      reason: 'invalid-event-log',
      errors: verdict.errors,
      warnings: warn.toJSON(),
    };
  }

  // A forced re-import goes to a *new* target, so the existing session is never
  // rewritten (FR-6.3). The variant keeps the id stable for that content.
  const variant = force ? shortHash(`${planned.digests.content}:${Date.now()}` , 12) : '';
  const plan = force ? planSession(session, { warn, variant }) : planned;
  const targetId = plan.targetId;

  // A session that is *live* in this DSH process owns an in-memory cursor.
  // Appending to its log from outside would leave that cursor behind, so the
  // harness's own next write would collide with a sequence we already used —
  // i.e. writing here would corrupt the session it is trying to help. Skip it;
  // the next boot (or the next import after it goes idle) picks it up.
  const live = options.sessionsStore?.get?.(targetId);
  if (!dryRun && live !== undefined) {
    warn.add(
      'session-live',
      '该会话当前正在 DSH 中打开（活动会话），为避免与它的内存状态冲突，本次跳过；DSH 重启后会自动补齐',
      { sessionId: sourceId, severity: SEVERITY.info },
    );
    return {
      sourceId,
      targetId,
      title: plan.title,
      cwd: plan.cwd,
      status: 'skipped',
      reason: 'live-in-dsh',
      variant,
      stats: plan.stats,
      warnings: warn.toJSON(),
    };
  }

  const stored = dryRun ? undefined : await sink.inspect(targetId);
  const decision = dryRun ? { mode: 'create', events: plan.events } : reconcile(plan, stored);

  const result = {
    sourceId,
    targetId,
    title: plan.title,
    cwd: plan.cwd,
    status: decision.mode,
    variant,
    sourceMessages: session.messages.length,
    stats: plan.stats,
    digests: { content: plan.digests.content, turns: plan.digests.turns.length },
    previousTarget: record?.targetId ?? null,
    warnings: warn.toJSON(),
  };

  if (decision.mode === 'conflict') {
    // A conflict on a session that was imported while a tool call was still in
    // flight is expected rather than alarming: the synthetic outcome-unknown
    // result in the stored log can never match the real outcome the source
    // recorded afterwards. Say so, so the user is not left guessing whether the
    // plugin or their session is at fault.
    const inFlight = (record?.stats?.toolResultsSynthesized ?? 0) > 0;
    warn.add(
      'conflict',
      `目标会话 ${targetId} 已存在且与本次生成的事件流不一致（${decision.reason}）：已拒绝原地重写。` +
        (inFlight
          ? '上次导入时该会话有工具调用尚未结束，源侧随后写入了真实结果，因此前缀必然不同；这是不可追加修复的，建议在该会话空闲后用 `--force` 另建全新副本。'
          : '若确认要以当前源内容生成全新副本，请加 --force。'),
      { sessionId: sourceId, severity: SEVERITY.error, detail: { ...decision.detail, inFlightAtImport: inFlight } },
    );
    // Record the refusal, so the steady state stays quiet: a conflict cannot be
    // resolved by retrying, and re-reporting it on every boot would train the
    // user to ignore it. `--force` (or deleting the session) is the way out.
    putRecord(registry, {
      ...(record ?? {}),
      sourceId,
      targetId,
      variant,
      title: plan.title,
      cwd: plan.cwd,
      importedAt: record?.importedAt ?? new Date().toISOString(),
      firstImportedAt: record?.firstImportedAt ?? new Date().toISOString(),
      lastMode: record?.lastMode ?? 'create',
      sourceMessageCount: session.messages.length,
      sourceUpdatedAt: session.updatedAt,
      turnDigests: record?.turnDigests ?? [],
      digestVersion: record?.digestVersion ?? CONTENT_DIGEST_VERSION,
      eventCount: record?.eventCount ?? 0,
      stats: plan.stats,
      warningCount: warn.length,
      conflict: {
        reason: decision.reason,
        detail: decision.detail ?? {},
        sourceUpdatedAt: session.updatedAt,
        at: new Date().toISOString(),
      },
    });
    return { ...result, status: 'conflict', conflict: { reason: decision.reason, detail: decision.detail }, warnings: warn.toJSON() };
  }

  if (decision.mode === 'skip') {
    result.status = 'skipped';
    result.reason = 'already-imported';
    result.eventCount = stored?.events.length ?? plan.events.length;
    result.fidelity = verifyFidelity(session, stored?.events ?? []);
  } else if (dryRun) {
    result.status = 'dry-run';
    result.planEvents = decision.events.length;
  } else {
    if (decision.mode === 'create') {
      await sink.create(plan.header);
    }
    await sink.append(targetId, decision.events);

    // Read back through the official API: the report's fidelity claim is a
    // measurement, not an assumption (NFR-3, AC-1).
    const written = await sink.inspect(targetId);
    result.status = decision.mode === 'create' ? 'imported' : 'appended';
    result.eventCount = written?.events.length ?? plan.events.length;
    result.fidelity = verifyFidelity(session, written?.events ?? []);
    if (!result.fidelity.ok) {
      warn.add('fidelity-mismatch', '写入后回读校验未通过，请把该会话连同报告一起反馈', {
        sessionId: sourceId,
        severity: SEVERITY.error,
        detail: result.fidelity.firstMismatch,
      });
      result.warnings = warn.toJSON();
    }

    result.mount = await mountWorkspace({
      registry: workspaceRegistry,
      sessionId: targetId,
      cwd: plan.cwd,
      createMissingDirs: config.createMissingDirs,
      warn,
    });

    const now = new Date().toISOString();
    putRecord(registry, {
      sourceId,
      targetId,
      variant,
      title: plan.title,
      cwd: plan.cwd,
      importedAt: now,
      firstImportedAt: record?.firstImportedAt ?? now,
      lastMode: decision.mode === 'create' ? 'create' : variant === '' ? 'append' : 'force',
      sourceMessageCount: session.messages.length,
      sourceUpdatedAt: session.updatedAt,
      turnDigests: plan.digests.turns,
      digestVersion: CONTENT_DIGEST_VERSION,
      eventCount: result.eventCount,
      stats: plan.stats,
      warningCount: warn.length,
    });
    result.warnings = warn.toJSON();
  }

  return result;
}

/**
 * Import many sessions with bounded concurrency, isolating per-session failures.
 *
 * @param {object} options - `{ config, sessionIds, sink, registry, warn, force, workspaceRegistry, dryRun, onProgress }`.
 * @returns {Promise<{results: object[], registry: object, warnings: object[]}>} aggregated outcome.
 */
export async function importMany(options) {
  const { config, sessionIds, sink, registry, workspaceRegistry, force = false, dryRun = false, onProgress } = options;
  const warn = options.warn ?? new WarningLog();
  const results = [];
  const facade = openSource(config, warn);

  try {
    for (const [index, sourceId] of sessionIds.entries()) {
      const sessionWarn = new WarningLog(sourceId);
      const result = await importSession({
        config,
        sourceId,
        sink,
        registry,
        force,
        dryRun,
        workspaceRegistry,
        sourceFacade: facade.kind === 'legacy' ? undefined : facade,
        warn: sessionWarn,
      });
      warn.items.push(...sessionWarn.items);
      results.push(result);
      onProgress?.({ index: index + 1, total: sessionIds.length, result });
    }
  } finally {
    facade.close();
  }
  return { results, registry, warnings: warn.toJSON() };
}

/**
 * Render a run report as JSON and Markdown (FR-7.3).
 *
 * @param {object} run - run summary `{ startedAt, finishedAt, mode, sourceKind, config, results }`.
 * @returns {{ json: object, markdown: string }} report bodies.
 */
export function buildReport(run) {
  const totals = {
    sessions: run.results.length,
    imported: 0,
    appended: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    events: 0,
    reasoningBlocks: 0,
    reasoningChars: 0,
    emptyReasoning: 0,
    toolCalls: 0,
    toolResultsSynthesized: 0,
    attachmentPlaceholders: 0,
    fidelityChecked: 0,
    fidelityOk: 0,
    warnings: 0,
    errors: 0,
  };
  for (const result of run.results) {
    if (result.status === 'imported') totals.imported += 1;
    else if (result.status === 'appended') totals.appended += 1;
    else if (result.status === 'skipped') totals.skipped += 1;
    else if (result.status === 'conflict') totals.conflicts += 1;
    else if (result.status === 'failed') totals.failed += 1;

    const stats = result.stats ?? {};
    totals.events += result.eventCount ?? stats.events ?? 0;
    totals.reasoningBlocks += stats.reasoningBlocks ?? 0;
    totals.reasoningChars += stats.reasoningChars ?? 0;
    totals.emptyReasoning += stats.emptyReasoning ?? 0;
    totals.toolCalls += stats.toolCalls ?? 0;
    totals.toolResultsSynthesized += stats.toolResultsSynthesized ?? 0;
    totals.attachmentPlaceholders += stats.filePlaceholders ?? 0;
    if (result.fidelity) {
      totals.fidelityChecked += 1;
      if (result.fidelity.ok) totals.fidelityOk += 1;
    }
    for (const warning of result.warnings ?? []) {
      totals.warnings += 1;
      if (warning.severity === SEVERITY.error) totals.errors += 1;
    }
  }

  const json = {
    tool: 'dsh-zcode-migrate',
    version: 1,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    mode: run.mode,
    sourceKind: run.sourceKind,
    sourceHome: run.config.zcodeHome,
    sourceHomeOrigin: run.config.zcodeHomeOrigin,
    stateDir: run.config.stateDirResolved,
    totals,
    sessions: run.results,
  };

  const lines = [];
  lines.push('# ZCode → DSH 迁移报告');
  lines.push('');
  lines.push(`- 运行模式：\`${run.mode}\``);
  lines.push(`- 数据源：\`${run.sourceKind}\`（${run.config.zcodeHome}，来自 ${run.config.zcodeHomeOrigin}）`);
  lines.push(`- 开始：${run.startedAt}`);
  lines.push(`- 结束：${run.finishedAt}`);
  lines.push(`- 状态目录：\`${run.config.stateDirResolved}\``);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 会话总数 | ${totals.sessions} |`);
  lines.push(`| 新建导入 | ${totals.imported} |`);
  lines.push(`| 增量追加 | ${totals.appended} |`);
  lines.push(`| 已是最新（跳过） | ${totals.skipped} |`);
  lines.push(`| 冲突（拒绝改写） | ${totals.conflicts} |`);
  lines.push(`| 失败 | ${totals.failed} |`);
  lines.push(`| DSH 事件总数 | ${totals.events} |`);
  lines.push(`| 思路块数 | ${totals.reasoningBlocks} |`);
  lines.push(`| 思路字符数 | ${totals.reasoningChars} |`);
  lines.push(`| 空思路块（源侧缺失，非迁移丢失） | ${totals.emptyReasoning} |`);
  lines.push(`| 工具调用 | ${totals.toolCalls} |`);
  lines.push(`| 合成占位工具结果 | ${totals.toolResultsSynthesized} |`);
  lines.push(`| 附件占位（二进制未迁移） | ${totals.attachmentPlaceholders} |`);
  lines.push(`| 逐字校验通过 | ${totals.fidelityOk}/${totals.fidelityChecked} |`);
  lines.push(`| 警告 / 错误 | ${totals.warnings} / ${totals.errors} |`);
  lines.push('');
  lines.push('## 逐会话明细');
  lines.push('');
  lines.push('| 源会话 | 目标会话 | 状态 | 事件 | 思路块 | 字符 | 逐字校验 | 警告 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of run.results) {
    const stats = result.stats ?? {};
    const fidelity =
      result.fidelity === undefined ? '—' : result.fidelity.ok ? '通过' : `不一致(块 ${result.fidelity.firstMismatch?.index ?? '?'})`;
    lines.push(
      `| ${result.sourceId} | ${result.targetId}${result.variant !== '' ? ` (force:${result.variant})` : ''} | ${result.status}` +
        `${result.conflict ? `:${result.conflict.reason}` : ''} | ${result.eventCount ?? stats.events ?? 0} | ${stats.reasoningBlocks ?? 0} | ${stats.reasoningChars ?? 0} | ${fidelity} | ${(result.warnings ?? []).length} |`,
    );
  }
  const problematic = run.results.filter((result) => (result.warnings ?? []).length > 0);
  if (problematic.length > 0) {
    lines.push('');
    lines.push('## 警告明细');
    lines.push('');
    for (const result of problematic) {
      lines.push(`### ${result.sourceId}`);
      lines.push('');
      for (const warning of result.warnings) {
        lines.push(`- \`${warning.severity}\` **${warning.code}**：${warning.message}${warning.where ? `（${warning.where}）` : ''}`);
      }
      lines.push('');
    }
  }

  return { json, markdown: `${lines.join('\n')}\n` };
}

/**
 * Persist a report to the state directory.
 *
 * @param {string} stateDir - state directory (created when absent).
 * @param {object} run - run summary.
 * @param {object} [options] - `{ stamp }`.
 * @returns {{ jsonPath: string, markdownPath: string, latestJsonPath: string, latestMarkdownPath: string }} written paths.
 */
export function writeReport(stateDir, run, options = {}) {
  const reportsDir = join(stateDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const { json, markdown } = buildReport(run);
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(reportsDir, `${stamp}.json`);
  const markdownPath = join(reportsDir, `${stamp}.md`);
  const latestJsonPath = join(reportsDir, 'latest.json');
  const latestMarkdownPath = join(reportsDir, 'latest.md');
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  writeFileSync(jsonPath, jsonText, 'utf8');
  writeFileSync(latestJsonPath, jsonText, 'utf8');
  writeFileSync(markdownPath, markdown, 'utf8');
  writeFileSync(latestMarkdownPath, markdown, 'utf8');
  return { jsonPath, markdownPath, latestJsonPath, latestMarkdownPath };
}

/**
 * Summarize migration state for `status` (FR-7.1).
 *
 * @param {object} config - normalized config.
 * @param {object} [options] - `{ warn }`.
 * @returns {Promise<{ registryPath: string, records: object[], sourceSessions: number, pending: number, reportPath: string }>} status.
 */
export async function status(config, options = {}) {
  const warn = options.warn ?? new WarningLog();
  const registry = loadRegistry(config.stateDirResolved, { warn });
  // Counted through the same helper the import paths use, so `status` can never
  // disagree with what a sync would actually do.
  const pendingState = await pendingSessions({ config, registry, sink: options.sink, warn });
  const pending = pendingState.ids.length;
  const sessions = pendingState.inventory.sessions;
  const blocked = pendingState.blocked;
  return {
    registryPath: join(config.stateDirResolved, 'registry.json'),
    reportPath: join(config.stateDirResolved, 'reports', 'latest.md'),
    records: Object.values(registry.sessions).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt))),
    sourceSessions: sessions.length,
    pending,
    blocked,
    warnings: warn.toJSON(),
  };
}
