/**
 * The `/zcode-import` command surface (FR-7.1) and the settings namespace (FR-7.2).
 *
 * Both registrations are optional by construction: the command runtime and the
 * settings provider are separate services, and a harness build without either
 * still migrates correctly (FR-8.2). Everything the command needs is resolved
 * at invocation time through `ctx.get(...)`, so a missing service produces a
 * readable message instead of a load failure.
 *
 * @module dsh-zcode-migrate/commands
 */

import { join } from 'node:path';
import { normalizeConfig } from './core/config.js';
import { WarningLog } from './core/warnings.js';
import { withImportLock } from './core/import-lock.js';
import { importMany, pendingSessions, scan, status, writeReport } from './migrate.js';
import { createPersistenceSink } from './target/session-sink.js';
import { loadRegistry, saveRegistry } from './target/registry.js';

/** Command name registered with the harness. */
export const COMMAND_NAME = 'zcode-import';

/** Usage text, shown for `/zcode-import help` and on an unknown verb. */
const USAGE = [
  '用法：/zcode-import [scan | status | import <源会话ID> | help] [--force] [--source=<ZCode目录>] [--legacy] [--dry-run]',
  '',
  '不带参数 = 直接同步（扫描并导入所有未导入/有更新的会话）——最常用的一条。',
  '  scan            看看有哪些源会话、各自导没导过',
  '  status          看看已经导了多少、缺多少',
  '  import <ID>     只导一个（ID 可用尾部片段）',
  '  help            显示这段说明',
].join('\n');

/** Verbs that mean "sync everything pending" — including no verb at all. */
const SYNC_VERBS = new Set(['', 'all', 'sync', 'update', 'run', 'import-all']);
/** Verbs that mean "list the sources". */
const SCAN_VERBS = new Set(['scan', 'ls', 'list']);

/**
 * Parse the command's raw input into a verb and flags.
 *
 * The verb is the first bare token, so a user who types flags first
 * (`/zcode-import --force all`) still gets the documented behaviour instead of
 * a verb literally named `--force`.
 *
 * @param {string} rawInput - text following the command name.
 * @returns {{ verb: string, args: string[], flags: Record<string, string|boolean> }} parsed invocation.
 */
export function parseInvocation(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  let verb = '';
  /** @type {string[]} */
  const args = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (const token of tokens) {
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq === -1) flags[body] = true;
      else flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (verb === '') verb = token;
    else args.push(token);
  }
  return { verb, args, flags };
}

/**
 * Build the effective config for one invocation: base config plus flags.
 *
 * @param {object} baseConfig - normalized plugin config.
 * @param {Record<string, string|boolean>} flags - parsed flags.
 * @returns {object} normalized config.
 */
function configWithFlags(baseConfig, flags) {
  const overrides = {};
  if (typeof flags.source === 'string') overrides.source = flags.source;
  if (flags.legacy === true) overrides.legacy = true;
  if (flags.report === false) overrides.report = false;
  return normalizeConfig({ ...baseConfig, ...overrides });
}

/**
 * Format a byte/char count for a one-line summary.
 * @param {number} value - count.
 * @returns {string} human-readable count.
 */
function count(value) {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0);
}

/**
 * Rows of the migration state for one source session.
 * @param {object} summary - scan summary.
 * @param {object} record - registry record, when present.
 * @returns {string} one aligned line.
 */
function describeSession(summary, record) {
  let state = '未导入';
  if (record !== undefined) {
    state = record.sourceUpdatedAt === summary.updatedAt ? '已是最新' : '源有更新';
  }
  const reasoning = summary.reasoningCount > 0 ? `${summary.reasoningCount} 段思路` : '—';
  return `  ${summary.id}  [${state}]  ${summary.messageCount} 消息 / ${reasoning}  ${JSON.stringify(summary.title || '(无标题)')}`;
}

/**
 * Execute one `/zcode-import` invocation.
 *
 * @param {object} options - `{ config, deps, rawInput, onProgress }`.
 * @returns {Promise<{ kind: 'success'|'error', text: string }>} command result.
 */
export async function runCommand(options) {
  const { rawInput, onProgress } = options;
  const invocation = parseInvocation(rawInput);
  const config = configWithFlags(options.config, invocation.flags);
  const warn = new WarningLog();
  const deps = { ...options.deps, warn };
  deps.sink = resolveSink(deps);
  const { verb, args, flags } = invocation;

  if (verb === 'help' || verb === '-h' || verb === '--help') return { kind: 'success', text: USAGE };

  if (SCAN_VERBS.has(verb)) {
    const inventory = scan(config, { warn });
    const registry = loadRegistry(config.stateDirResolved, { warn });
    const lines = [
      `ZCode 数据源：${inventory.sourceKind}（${config.zcodeHome}，来自 ${config.zcodeHomeOrigin}）`,
      `共 ${count(inventory.sessions.length)} 个会话：`,
      '',
      ...inventory.sessions.slice(0, 30).map((summary) => describeSession(summary, registry.sessions[summary.id])),
    ];
    if (inventory.sessions.length > 30) lines.push(`  …（其余 ${inventory.sessions.length - 30} 个未列出，完整清单见 scan 报告）`);
    lines.push('', '用 `/zcode-import` 直接同步全部，或 `/zcode-import import <源会话ID>` 只导一个。');
    return { kind: 'success', text: lines.join('\n') };
  }

  if (verb === 'status') {
    const state = await status(config, { warn, sink: deps.sink });
    const lines = [
      `已迁移会话：${count(state.records.length)} 个（注册表：${state.registryPath}）`,
      `源侧会话：${count(state.sourceSessions)} 个，其中待导入/有更新：${count(state.pending)} 个`,
      state.blocked.length > 0
        ? `冲突待定：${count(state.blocked.length)} 个（源侧已发生过的历史被改写，无法追加修复；用 \`/zcode-import import <ID> --force\` 另建副本）`
        : undefined,
      config.autoImport === 'pending'
        ? '自动同步：已开启（每次启动 DSH 时自动补齐，无需手动执行）'
        : '自动同步：已关闭（autoImport: off）；用 /zcode-import 手动同步',
      `最近一次报告：${state.reportPath}`,
      '',
    ].filter((line) => line !== undefined);
    for (const record of state.records.slice(0, 20)) {
      lines.push(
        `  ${record.sourceId} → ${record.targetId}  [${record.lastMode}]  ${count(record.eventCount)} 事件  思路 ${count(record.stats?.reasoningBlocks)} 段  ${record.importedAt}`,
      );
    }
    if (state.records.length > 20) lines.push(`  …（其余 ${state.records.length - 20} 个未列出）`);
    return { kind: 'success', text: lines.join('\n') };
  }

  if (verb !== 'import' && !SYNC_VERBS.has(verb)) {
    return { kind: 'error', text: `未知子命令「${verb}」。${USAGE}` };
  }

  if (deps.sink === undefined) {
    return {
      kind: 'error',
      text: 'sessionPersistence 服务不可用，无法写入会话。请确认 DSH 已加载会话持久化插件（通常是 @deepseek-ai/dsh-session-persistence-jsonl）。',
    };
  }

  const inventory = scan(config, { warn });
  let sessionIds = [];
  if (verb === 'import') {
    const requested = args[0];
    if (requested === undefined) return { kind: 'error', text: `需要给出源会话 ID。${USAGE}` };
    const match = inventory.sessions.find((summary) => summary.id === requested) ??
      inventory.sessions.find((summary) => summary.id.endsWith(requested));
    if (match === undefined) return { kind: 'error', text: `找不到源会话「${requested}」。先用 /zcode-import scan 查看可用会话。` };
    sessionIds = [match.id];
  } else {
    const pending = await pendingSessions({
      config,
      registry: loadRegistry(config.stateDirResolved, { warn }),
      sink: deps.sink,
      force: flags.force === true,
      warn,
    });
    sessionIds = pending.ids;
    if (sessionIds.length === 0) {
      const blockedNote =
        pending.blocked.length > 0
          ? `\n另有 ${count(pending.blocked.length)} 个会话因源侧历史被改写而无法追加重放，已跳过（用 /zcode-import status 查看，或对单个会话加 --force 另建副本）。`
          : '';
      return {
        kind: 'success',
        text:
          `已是最新：${count(pending.total)} 个源会话都已导入，没有需要同步的内容。` +
          (config.autoImport === 'pending' ? '\n（自动同步已开启，之后 ZCode 侧有新增会在下次启动时自动补齐。）' : '') +
          blockedNote,
      };
    }
    if (pending.missingInStore > 0) {
      warn.add(
        'targets-missing-in-store',
        `${pending.missingInStore} 个会话在注册表里记着已导入，但 DSH 存储里不存在（可能被删除或换了 DSH home），本次会重新导入`,
        { severity: 'warning' },
      );
    }
  }

  const startedAt = new Date().toISOString();
  // The boot-time auto-import takes the same lock, so a manual run and an
  // automatic one can never both decide to append the same increment.
  const locked = await withImportLock(
    config.stateDirResolved,
    { label: `${COMMAND_NAME} ${verb}` },
    () =>
      importMany({
        config,
        sessionIds,
        sink: deps.sink,
        registry: loadRegistry(config.stateDirResolved, { warn }),
        workspaceRegistry: deps.workspaceRegistry,
        sessionsStore: deps.sessionsStore,
        force: flags.force === true,
        dryRun: flags['dry-run'] === true,
        warn,
        onProgress,
      }),
  );
  if (!locked.ran) {
    return {
      kind: 'error',
      text: `已有另一次迁移在进行中（${locked.reason}${locked.holder?.label !== undefined ? `：${locked.holder.label}` : ''}），请等它结束后重试。`,
    };
  }
  const run = locked.value;
  const finishedAt = new Date().toISOString();
  const reportRun = { startedAt, finishedAt, mode: `${verb}${flags.force === true ? ' --force' : ''}`, sourceKind: inventory.sourceKind, config, results: run.results };

  // The registry is bookkeeping, not a report: it is what keeps the next run
  // cheap, so it is always written. Only the human-readable report is optional.
  saveRegistry(config.stateDirResolved, run.registry);
  if (config.report) {
    const paths = writeReport(config.stateDirResolved, reportRun);
    reportRun.reportPath = paths.markdownPath;
  }

  const summary = {
    imported: run.results.filter((result) => result.status === 'imported').length,
    appended: run.results.filter((result) => result.status === 'appended').length,
    skipped: run.results.filter((result) => result.status === 'skipped').length,
    conflicts: run.results.filter((result) => result.status === 'conflict').length,
    failed: run.results.filter((result) => result.status === 'failed').length,
    reasoningBlocks: run.results.reduce((total, result) => total + (result.stats?.reasoningBlocks ?? 0), 0),
    reasoningChars: run.results.reduce((total, result) => total + (result.stats?.reasoningChars ?? 0), 0),
    emptyReasoning: run.results.reduce((total, result) => total + (result.stats?.emptyReasoning ?? 0), 0),
    warnings: run.results.reduce((total, result) => total + (result.warnings ?? []).length, 0),
    fidelityFailed: run.results.filter((result) => result.fidelity !== undefined && !result.fidelity.ok).length,
  };

  const lines = [
    `迁移完成：新建 ${summary.imported}，增量追加 ${summary.appended}，跳过 ${summary.skipped}，冲突 ${summary.conflicts}，失败 ${summary.failed}`,
    `思路：${count(summary.reasoningBlocks)} 段 / ${count(summary.reasoningChars)} 字，逐字校验失败 ${summary.fidelityFailed} 个`,
    summary.emptyReasoning > 0 ? `源侧空思路块（非迁移丢失）：${summary.emptyReasoning}` : undefined,
    summary.conflicts > 0 ? '存在冲突：目标会话与源内容不一致，已拒绝改写。确认后可用 --force 生成全新副本。' : undefined,
    config.report ? `报告：${join(config.stateDirResolved, 'reports', 'latest.md')}` : undefined,
    summary.warnings > 0 ? `警告 ${summary.warnings} 条（详见报告）` : undefined,
  ].filter((line) => line !== undefined);
  return { kind: summary.failed > 0 ? 'error' : 'success', text: lines.join('\n') };
}

/**
 * Register the command and settings surface.
 *
 * @param {object} ctx - cordis context.
 * @param {object} options - `{ getConfig, logger, log }`.
 * @returns {{ dispose: () => void, registered: string[] }} what was installed.
 */
export function registerSurfaces(ctx, options) {
  const { getConfig, log } = options;
  /** @type {Array<() => void>} */
  const disposers = [];
  /** @type {string[]} */
  const registered = [];

  const commands = ctx.get?.('commands');
  if (commands !== undefined && typeof commands.register === 'function') {
    disposers.push(
      commands.register({
        name: COMMAND_NAME,
        description: '把 ZCode 的聊天记录与思路逐字迁移为 DSH 原生会话（直接回车即同步；另可 scan / status / import <ID>）',
        input: { hint: '直接回车同步；或 scan | status | import <源会话ID> [--force]' },
        handler: async ({ rawInput, signal }) => {
          try {
            return await runCommand({
              config: getConfig(),
              rawInput,
              deps: {
                persistence: ctx.get?.('sessionPersistence'),
                workspaceRegistry: ctx.get?.('workspaceRegistry'),
                sessionsStore: ctx.get?.('sessions'),
              },
              onProgress: ({ index, total, result }) => {
                log?.debug?.(`[zcode-migrate] ${index}/${total} ${result.sourceId} → ${result.status}`);
              },
              signal,
            });
          } catch (error) {
            const message = /** @type {Error} */ (error).message;
            log?.warn?.(`[zcode-migrate] 命令执行失败：${message}`);
            return { kind: 'error', text: `迁移失败：${message}` };
          }
        },
      }),
    );
    registered.push(`/${COMMAND_NAME}`);
  } else {
    log?.debug?.('[zcode-migrate] commands 服务不可用，已跳过斜杠命令注册（核心迁移能力不受影响）');
  }

  return {
    registered,
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* a failed dispose must not mask the rest */
        }
      }
    },
  };
}

/**
 * Resolve the write sink for one invocation from the live context.
 *
 * Built per invocation so its warnings land in the same log as the run that
 * produced them (the sink can warn about a backend that lacks `inspect`, for
 * instance), and so nothing is cached across config changes.
 *
 * @param {object} deps - `{ persistence, warn }`.
 * @returns {object|undefined} sink, or `undefined` when persistence is absent.
 */
export function resolveSink(deps) {
  if (deps.persistence === undefined || deps.persistence === null) return undefined;
  return createPersistenceSink(deps.persistence, { warn: deps.warn });
}
