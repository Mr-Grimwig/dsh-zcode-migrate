#!/usr/bin/env node
/**
 * Standalone CLI for `dsh-zcode-migrate`.
 *
 * Exists so the migration can be *operated and audited without a running
 * harness*: scan the source, dry-run a plan, import through a real DSH JSONL
 * backend rooted at a scratch directory, and verify a migrated log against its
 * source. The same modules back the in-harness `/zcode-import` command, so what
 * is verified here is what the command does.
 *
 * Usage:
 *   node scripts/cli.mjs scan    [--source=<dir>] [--legacy] [--json]
 *   node scripts/cli.mjs plan    <sessionId> [--source=<dir>] [--json]
 *   node scripts/cli.mjs import  [<sessionId>...] [--all] [--root=<dir>] [--force] [--dry-run]
 *   node scripts/cli.mjs status  [--state=<dir>]
 *   node scripts/cli.mjs verify  [<sessionId>...] [--root=<dir>] [--source=<dir>]
 *
 * `--root` points at a DSH **sessions root** (normally `<dsh home>/sessions`);
 * `import` needs one, because writing goes through the harness's own JSONL
 * backend.
 *
 * @module dsh-zcode-migrate/scripts/cli
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig } from '../src/core/config.js';
import { WarningLog } from '../src/core/warnings.js';
import { importMany, openSource, reasoningTextsOf, scan as scanSource, status as statusOf, verifyRecord } from '../src/migrate.js';
import { loadRegistry, saveRegistry } from '../src/target/registry.js';
import { writeReport } from '../src/migrate.js';
import { planSession } from '../src/transform/plan.js';
import { validateEventLog } from '../src/transform/validate.js';
import { readSessionArtifact } from '../src/target/dsh-log-reader.js';import { openJsonlBackend } from './jsonl-backend.mjs';

/**
 * Parse CLI arguments into positional and named parts.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ command: string, positional: string[], flags: Record<string, string|boolean> }} parsed argv.
 */
function parseArgv(argv) {
  const [command = '', ...rest] = argv;
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (const token of rest) {
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags[body] = true;
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return { command, positional, flags };
}

/**
 * Build the config for one invocation.
 * @param {Record<string, string|boolean>} flags - parsed flags.
 * @returns {object} normalized config.
 */
function buildConfig(flags) {
  return normalizeConfig({
    ...(typeof flags.source === 'string' ? { source: flags.source } : {}),
    ...(typeof flags.state === 'string' ? { stateDir: flags.state } : {}),
    ...(flags.legacy === true ? { legacy: true } : {}),
    ...(typeof flags.mode === 'string' ? { sourceMode: flags.mode } : {}),
    ...(flags['create-missing-dirs'] === true ? { createMissingDirs: true } : {}),
    ...(typeof flags.max === 'string' ? { maxSessions: Number(flags.max) } : {}),
  });
}

/**
 * Print a value, JSON-encoded when `--json` was passed.
 * @param {unknown} value - value to print.
 * @param {boolean} asJson - whether to print JSON.
 * @param {string} [text] - human-readable rendering.
 * @returns {void}
 */
function emit(value, asJson, text) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${text ?? String(value)}\n`);
}

/** Entry point. */
async function main() {
  const { command, positional, flags } = parseArgv(process.argv.slice(2));
  const config = buildConfig(flags);
  const asJson = flags.json === true;

  if (command === 'scan') {
    const warn = new WarningLog();
    const inventory = scanSource(config, { warn });
    const registry = loadRegistry(config.stateDirResolved, { warn });
    const rows = inventory.sessions.map((summary) => {
      const record = registry.sessions[summary.id];
      return {
        ...summary,
        state: record === undefined ? 'new' : record.sourceUpdatedAt === summary.updatedAt ? 'current' : 'updated',
        importedTo: record?.targetId ?? null,
      };
    });
    emit(
      { sourceKind: inventory.sourceKind, sourceHome: config.zcodeHome, sourceHomeOrigin: config.zcodeHomeOrigin, sessions: rows, warnings: warn.toJSON() },
      asJson,
      [
        `ZCode 数据源：${inventory.sourceKind}（${config.zcodeHome}，来自 ${config.zcodeHomeOrigin}）`,
        `会话数：${rows.length}`,
        ...rows.map(
          (row) =>
            `  ${row.state === 'new' ? '·' : row.state === 'current' ? '✓' : '↑'} ${row.id}  ${row.messageCount} 消息 / ${row.reasoningCount} 思路  ${JSON.stringify(row.title || '(无标题)')}  ${row.directory}`,
        ),
      ].join('\n'),
    );
    return 0;
  }

  if (command === 'plan') {
    const sessionId = positional[0];
    if (sessionId === undefined) throw new Error('plan 需要源会话 ID');
    const warn = new WarningLog(sessionId);
    const source = openSource(config, warn);
    const session = source.read(sessionId, { warn });
    source.close();
    if (session === undefined) throw new Error(`找不到源会话 ${sessionId}`);
    const plan = planSession(session, { warn });
    const verdict = validateEventLog(plan.events);
    emit(
      {
        targetId: plan.targetId,
        header: plan.header,
        stats: plan.stats,
        turns: plan.turns.length,
        events: plan.events.length,
        digests: { content: plan.digests.content, turns: plan.digests.turns.length },
        validation: verdict,
        warnings: warn.toJSON(),
      },
      asJson,
      [
        `源会话：${session.id}  →  目标会话：${plan.targetId}`,
        `工作区：${plan.cwd || '(无)'}`,
        `事件：${plan.events.length}，回合：${plan.turns.length}，步骤：${plan.stats.steps}`,
        `思路：${plan.stats.reasoningBlocks} 段 / ${plan.stats.reasoningChars} 字（空块 ${plan.stats.emptyReasoning}）`,
        `工具调用：${plan.stats.toolCalls}（合成结果 ${plan.stats.toolResultsSynthesized}）`,
        `结构校验：${verdict.ok ? '通过' : `失败：${verdict.errors.slice(0, 3).join('；')}`}`,
        `警告：${warn.length}`,
      ].join('\n'),
    );
    return verdict.ok ? 0 : 1;
  }

  if (command === 'import') {
    // Defaults to the harness's own sessions root, so `npm run import` works
    // without arguments on the machine that has DSH installed.
    const root = typeof flags.root === 'string' ? flags.root : join(config.dshHome, 'sessions');
    const warn = new WarningLog();
    const backend = await openJsonlBackend({ root, warn });
    const inventory = scanSource(config, { warn });
    let sessionIds = positional;
    if (sessionIds.length === 0 || flags.all === true) {
      const registry = loadRegistry(config.stateDirResolved, { warn });
      sessionIds = inventory.sessions
        .filter((summary) => {
          const record = registry.sessions[summary.id];
          return flags.force === true || record === undefined || record.sourceUpdatedAt !== summary.updatedAt;
        })
        .map((summary) => summary.id);
      if (config.maxSessions > 0) sessionIds = sessionIds.slice(0, config.maxSessions);
    }
    if (sessionIds.length === 0) {
      emit({ status: 'noop', message: '所有源会话都已是最新' }, asJson, '所有源会话都已是最新，无需导入。');
      await backend.close();
      return 0;
    }

    const startedAt = new Date().toISOString();
    const run = await importMany({
      config,
      sessionIds,
      sink: backend.sink,
      registry: loadRegistry(config.stateDirResolved, { warn }),
      force: flags.force === true,
      dryRun: flags['dry-run'] === true,
      warn,
      onProgress: ({ index, total, result }) => {
        if (!asJson) process.stderr.write(`  [${index}/${total}] ${result.sourceId} → ${result.status}\n`);
      },
    });
    const finishedAt = new Date().toISOString();
    const reportRun = {
      startedAt,
      finishedAt,
      mode: `cli import${flags.force === true ? ' --force' : ''}${flags['dry-run'] === true ? ' --dry-run' : ''}`,
      sourceKind: inventory.sourceKind,
      config,
      results: run.results,
    };
    mkdirSync(config.stateDirResolved, { recursive: true });
    saveRegistry(config.stateDirResolved, run.registry);
    const paths = writeReport(config.stateDirResolved, reportRun);
    await backend.close();

    const summary = {
      imported: run.results.filter((r) => r.status === 'imported').length,
      appended: run.results.filter((r) => r.status === 'appended').length,
      skipped: run.results.filter((r) => r.status === 'skipped').length,
      conflicts: run.results.filter((r) => r.status === 'conflict').length,
      failed: run.results.filter((r) => r.status === 'failed').length,
      fidelityFailed: run.results.filter((r) => r.fidelity !== undefined && !r.fidelity.ok).length,
      reasoningBlocks: run.results.reduce((total, r) => total + (r.stats?.reasoningBlocks ?? 0), 0),
      reasoningChars: run.results.reduce((total, r) => total + (r.stats?.reasoningChars ?? 0), 0),
      warnings: warn.length,
    };
    emit(
      { summary, report: paths, results: run.results },
      asJson,
      [
        `导入完成：新建 ${summary.imported}，追加 ${summary.appended}，跳过 ${summary.skipped}，冲突 ${summary.conflicts}，失败 ${summary.failed}`,
        `思路：${summary.reasoningBlocks} 段 / ${summary.reasoningChars} 字，逐字校验失败 ${summary.fidelityFailed}`,
        `报告：${paths.markdownPath}`,
      ].join('\n'),
    );
    return summary.failed > 0 || summary.conflicts > 0 ? 1 : 0;
  }

  if (command === 'audit') {
    // Plans every source session and compares the planned reasoning against the
    // source, writing nothing and needing no DSH root. This is the
    // zero-side-effect form of the fidelity claim: it answers "would the
    // migration reproduce every thinking block byte for byte?" before anything
    // has been migrated, which is the safest way to check a whole corpus.
    const warn = new WarningLog();
    const inventory = scanSource(config, { warn });
    const source = openSource(config, warn);
    /** @type {Array<object>} */
    const results = [];
    let blocks = 0;
    let chars = 0;
    let events = 0;
    let invalid = 0;
    const started = Date.now();

    for (const summary of inventory.sessions) {
      const sessionWarn = new WarningLog(summary.id);
      const session = source.read(summary.id, { sessionWarn });
      if (session === undefined) {
        results.push({ sourceId: summary.id, ok: false, reason: 'unreadable' });
        continue;
      }
      const plan = planSession(session, { sessionWarn });
      const verdict = validateEventLog(plan.events);
      const expected = reasoningTextsOf(session);
      const planned = plan.events
        .filter((event) => event.type === 'assistant/message')
        .flatMap((event) => event.data.message.content)
        .filter((block) => block.type === 'reasoning')
        .map((block) => block.text);
      const fidelity = expected.length === planned.length && expected.every((text, index) => text === planned[index]);

      blocks += planned.length;
      chars += planned.reduce((total, text) => total + text.length, 0);
      events += plan.events.length;
      if (!verdict.ok) invalid += 1;
      results.push({
        sourceId: summary.id,
        targetId: plan.targetId,
        ok: fidelity && verdict.ok,
        reasoningBlocks: planned.length,
        emptyReasoning: plan.stats.emptyReasoning,
        toolCalls: plan.stats.toolCalls,
        events: plan.events.length,
        fidelity,
        validation: verdict.ok ? 'ok' : verdict.errors.slice(0, 2),
      });
    }
    source.close();

    const failed = results.filter((result) => !result.ok);
    emit(
      {
        sourceKind: inventory.sourceKind,
        sourceHome: config.zcodeHome,
        sessions: results.length,
        reasoningBlocks: blocks,
        reasoningChars: chars,
        events,
        invalidEventLogs: invalid,
        failed: failed.length,
        elapsedMs: Date.now() - started,
        results,
      },
      asJson,
      [
        `只读审计（不写入任何内容）：${results.length - failed.length}/${results.length} 个会话通过`,
        `思路 ${blocks} 段 / ${chars} 字全部与源逐字相等；事件 ${events} 条，结构非法 ${invalid} 个`,
        ...failed.slice(0, 10).map((result) => `  ✗ ${result.sourceId}：${JSON.stringify(result.validation ?? result.reason)}`),
      ].join('\n'),
    );
    return failed.length === 0 ? 0 : 1;
  }

  if (command === 'status') {
    const warn = new WarningLog();
    const state = await statusOf(config, { warn });
    emit(state, asJson, [
      `已迁移：${state.records.length} 个会话（注册表 ${state.registryPath}）`,
      `源侧：${state.sourceSessions} 个，待导入/有更新：${state.pending} 个`,
      `最近报告：${state.reportPath}`,
    ].join('\n'));
    return 0;
  }

  if (command === 'verify') {
    const root = typeof flags.root === 'string' ? flags.root : join(config.dshHome, 'sessions');
    const warn = new WarningLog();
    const registry = loadRegistry(config.stateDirResolved, { warn });
    const records = Object.values(registry.sessions);
    const targets = positional.length > 0
      ? records.filter((record) => positional.includes(record.sourceId) || positional.includes(record.targetId))
      : records;
    if (targets.length === 0) {
      emit({ status: 'noop' }, asJson, '注册表里没有可校验的会话（先执行 import）。');
      return 0;
    }

    const source = openSource(config, warn);
    /** @type {Array<object>} */
    const results = [];
    for (const record of targets) {
      const artifact = readSessionArtifact(root, record.targetId);
      const session = source.read(record.sourceId, { warn });
      const plan = session === undefined ? undefined : planSession(session, { warn });
      results.push(
        verifyRecord({
          record,
          artifact,
          plan,
          sourceReasoning: session === undefined ? undefined : reasoningTextsOf(session),
        }),
      );
    }
    source.close();

    const failed = results.filter((result) => !result.ok);
    const drifted = results.filter((result) => result.drift > 0);
    const mismatched = results.filter((result) => result.fidelity === false);
    const legacy = results.filter((result) => result.legacyRecord === true);
    emit(
      { root, checked: results.length, failed: failed.length, drifted: drifted.length, legacyRecords: legacy.length, fidelityMismatch: mismatched.length, results },
      asJson,
      [
        `逐字校验：${results.length - failed.length}/${results.length} 通过（读取自 ${root}）`,
        '含义：落盘日志与导入时的计划逐回合一致，且思路与源逐字相等。',
        legacy.length > 0
          ? `  · ${legacy.length} 条记录写于旧版摘要口径，已改用"与当前源逐回合比对"来判定（导入一次即升级记录）`
          : undefined,
        ...drifted.map((result) => `  ↑ ${result.sourceId}：导入后源侧新增 ${result.drift} 个回合（增量导入可补齐）`),
        ...mismatched.map((result) => `  ✗ ${result.sourceId}：思路与源不一致，请连同报告反馈`),
        ...results.map(
          (result) =>
            `  ${result.ok ? '✓' : '✗'} ${result.sourceId} → ${result.targetId}  ${result.reasoningBlocks} 段 / ${result.reasoningChars} 字` +
            `${result.drift > 0 ? `（源侧较导入时 +${result.drift} 回合）` : ''}`,
        ),
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    );
    return failed.length === 0 && mismatched.length === 0 ? 0 : 1;
  }

  process.stderr.write(
    [
      '用法：cli.mjs <scan|audit|plan|import|status|verify> [参数]',
      '  scan   列出源会话与迁移状态',
      '  audit  只读审计：全量演练并逐字比对思路，不写入任何内容',
      '  plan   <sessionId>  只演练单个会话，输出事件统计与结构校验',
      '  import [<sessionId>...] [--all] [--force] [--dry-run]  不指定会话时处理所有待同步的',
      '  status 汇总迁移状态',
      '  verify [<sessionId>...]  逐字比对已迁移的思路',
      '通用：--source=<ZCode 目录> --state=<状态目录> --legacy --mode=auto|db|rollout --json',
      '      --root=<DSH sessions 根目录>，默认取 <DSH 主目录>/sessions',
    ].join('\n') + '\n',
  );
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`错误：${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
