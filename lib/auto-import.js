/**
 * Boot-time auto-migration (`autoImport: 'pending'`).
 *
 * The plugin's whole job is to keep a DSH install in step with a ZCode install,
 * so the simplest possible operation is *none*: install once, and every boot
 * tops up whatever ZCode has gained since. That is what this module does, under
 * four deliberate constraints:
 *
 * 1. **It never blocks startup.** The run is scheduled after the tree is up and
 *    awaited by nobody; failures are logged, not thrown.
 * 2. **It never overwrites.** No `--force` here: a conflict is recorded in the
 *    report and left for a human, exactly as the command path does (FR-6.3).
 * 3. **It runs at most once per process**, and takes the shared import lock, so
 *    it cannot race a `/zcode-import` invocation.
 * 4. **It is bounded work.** Only sessions whose source moved on are touched
 *    (FR-6.2), so a steady state costs a scan and nothing else.
 *
 * @module dsh-zcode-migrate/auto-import
 */

import { mkdirSync } from 'node:fs';
import { WarningLog } from './core/warnings.js';
import { acquireImportLock } from './core/import-lock.js';
import { importMany, pendingSessions, scan, status, writeReport } from './migrate.js';
import { loadRegistry, saveRegistry } from './target/registry.js';
import { createPersistenceSink } from './target/session-sink.js';

/** Fallback wait for contexts without `ctx.inject` (test fakes, odd hosts). */
const SERVICE_WAIT_MS = 5_000;
const SERVICE_POLL_MS = 100;

/**
 * Wait until a service is available on the context.
 *
 * Only the fallback path uses this: a real cordis context gets
 * {@link scheduleAutoImport}'s `ctx.inject`, which is event-driven and never
 * polls. The plugin declares no hard dependencies (FR-8.2), so at load time the
 * persistence service may simply not be mounted yet.
 *
 * @param {object} ctx - cordis context.
 * @param {string} name - service name.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<any|undefined>} the service, or `undefined` on timeout.
 */
async function waitForService(ctx, name, timeoutMs = SERVICE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const service = ctx.get?.(name);
    if (service !== undefined) return service;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, SERVICE_POLL_MS));
  }
}

/**
 * Run one auto-import pass.
 *
 * Exported so tests can drive it directly with a config and a sink.
 *
 * @param {object} options - `{ config, persistence, workspaceRegistry, logger, warn }`.
 * @returns {Promise<object>} a summary: `{ status, pending, results?, report? }`.
 */
export async function runAutoImport(options) {
  const { config, logger } = options;
  const stateDir = config.stateDirResolved;
  const warn = options.warn ?? new WarningLog();
  mkdirSync(stateDir, { recursive: true });

  // Hold the lock across the whole pass so a concurrent `/zcode-import` either
  // sees a locked state or is itself refused, never both appending.
  const lock = acquireImportLock(stateDir, { label: 'auto-import' });
  if (!lock.ok) {
    logger?.debug?.(`[zcode-migrate] 自动迁移跳过：${lock.reason}`);
    return { status: 'busy', reason: lock.reason };
  }

  try {
    const sink = createPersistenceSink(options.persistence, { warn });
    const registry = loadRegistry(stateDir, { warn });
    const pending = await pendingSessions({ config, registry, sink, warn });
    const pendingIds = pending.ids;
    if (pendingIds.length === 0) return { status: 'current', pending: 0 };
    const inventory = pending.inventory;

    const startedAt = new Date().toISOString();
    logger?.info?.(`[zcode-migrate] 自动迁移开始：${pendingIds.length} 个会话有待同步`);
    const run = await importMany({
      config,
      sessionIds: pendingIds,
      sink,
      registry,
      workspaceRegistry: options.workspaceRegistry,
      force: false,
      warn,
    });
    saveRegistry(stateDir, run.registry);
    const report = writeReport(stateDir, {
      startedAt,
      finishedAt: new Date().toISOString(),
      mode: 'auto-import',
      sourceKind: inventory.sourceKind,
      config,
      results: run.results,
    });

    const count = (status_) => run.results.filter((result) => result.status === status_).length;
    const fidelityFailed = run.results.filter((result) => result.fidelity !== undefined && !result.fidelity.ok).length;
    const conflicts = count('conflict');
    const summary =
      `自动迁移完成：新建 ${count('imported')}，增量追加 ${count('appended')}，跳过 ${count('skipped')}，` +
      `冲突 ${conflicts}，失败 ${count('failed')}（逐字校验失败 ${fidelityFailed}）`;
    // Conflicts are expected for a source session that was mid-turn when it was
    // first imported, so they are reported at info level, not as errors.
    logger?.info?.(`[zcode-migrate] ${summary}`);
    if (conflicts > 0) {
      logger?.info?.('[zcode-migrate] 冲突的会话未被改写；在 ZCode 中空闲后再导入，或用 /zcode-import all --force 另建副本');
    }
    return { status: 'ran', pending: pendingIds.length, summary, report: report.markdownPath, results: run.results };
  } catch (error) {
    // A failed auto-run must never disturb the harness: log and move on.
    logger?.warn?.(`[zcode-migrate] 自动迁移失败（不影响 DSH 使用）：${/** @type {Error} */ (error).message}`);
    return { status: 'failed', reason: /** @type {Error} */ (error).message };
  } finally {
    lock.release();
  }
}

/**
 * Schedule the boot-time pass, if the configuration asks for it.
 *
 * @param {object} ctx - cordis context.
 * @param {object} options - `{ getConfig, logger }`.
 * @returns {{ scheduled: boolean, done: Promise<object>|undefined }} handle.
 */
export function scheduleAutoImport(ctx, options) {
  const config = options.getConfig();
  if (config.autoImport !== 'pending') return { scheduled: false, done: undefined };

  /**
   * Run the pass, reporting rather than throwing.
   * @param {object} persistence - the persistence service.
   * @returns {Promise<object>} summary.
   */
  const begin = (persistence) => {
    const done = runAutoImport({
      config: options.getConfig(),
      persistence,
      workspaceRegistry: ctx.get?.('workspaceRegistry'),
      sessionsStore: ctx.get?.('sessions'),
      logger: options.logger,
    });
    done.catch((error) => options.logger?.warn?.(`[zcode-migrate] 自动迁移异常：${error?.message ?? error}`));
    return done;
  };

  // Preferred path: cordis's own dependency injection. It fires the moment the
  // service exists (instead of polling for it), and if the service is never
  // mounted the callback simply never runs — which is the correct outcome for a
  // build without session storage.
  if (typeof ctx.inject === 'function') {
    const fiber = ctx.inject(['sessionPersistence'], (injected) => {
      const persistence = injected?.sessionPersistence ?? injected?.get?.('sessionPersistence') ?? ctx.get('sessionPersistence');
      if (persistence === undefined) return;
      begin(persistence);
    });
    return { scheduled: true, fiber };
  }

  // Fallback for a context without injection: one bounded wait, never a block.
  const done = (async () => {
    const persistence = await waitForService(ctx, 'sessionPersistence');
    if (persistence === undefined) {
      options.logger?.debug?.('[zcode-migrate] 自动迁移跳过：sessionPersistence 服务未就绪');
      return { status: 'no-persistence' };
    }
    return begin(persistence);
  })();
  done.catch((error) => options.logger?.warn?.(`[zcode-migrate] 自动迁移异常：${error?.message ?? error}`));
  return { scheduled: true, done };
}
