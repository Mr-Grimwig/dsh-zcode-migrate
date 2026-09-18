/**
 * Zero-touch operation: the boot-time auto-import and the lock that makes it
 * safe alongside a manual `/zcode-import`.
 *
 * The point of these tests is the *contract*, not the mechanics: an automatic
 * run must never force anything, never block boot, never double-run, and must
 * stay quiet about conflicts that are expected for a source session that was
 * mid-turn when it was first imported.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { autoImportDefault, normalizeConfig } from '../src/core/config.js';
import { acquireImportLock, DEFAULT_STALE_MS, withImportLock } from '../src/core/import-lock.js';
import { runAutoImport } from '../src/auto-import.js';
import { WarningLog } from '../src/core/warnings.js';
import { createMemorySink } from '../src/target/session-sink.js';
import { loadRegistry, saveRegistry } from '../src/target/registry.js';
import { createFixture, sampleTurns } from './fixtures/zcode-fixture.mjs';

/** A logger that records what the plugin said. */
function recordingLogger() {
  /** @type {string[]} */
  const lines = [];
  return {
    lines,
    info: (message) => lines.push(`info: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    debug: (message) => lines.push(`debug: ${message}`),
  };
}

describe('autoImport configuration', () => {
  it('defaults to topping up at boot, so no command is ever required', () => {
    assert.equal(autoImportDefault(), 'pending');
    assert.equal(normalizeConfig({}).autoImport, 'pending');
  });

  it('accepts an explicit off, and anything unknown falls back to the default', () => {
    assert.equal(normalizeConfig({ autoImport: 'off' }).autoImport, 'off');
    assert.equal(normalizeConfig({ autoImport: 'nonsense' }).autoImport, 'pending');
  });
});

describe('import lock', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'zcm-lock-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets one holder in and refuses the next', () => {
    const first = acquireImportLock(dir, { label: 'first' });
    assert.equal(first.ok, true);
    const second = acquireImportLock(dir, { label: 'second' });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'locked');
    assert.equal(second.holder.label, 'first');
    first.release();
    const third = acquireImportLock(dir, { label: 'third' });
    assert.equal(third.ok, true);
    third.release();
  });

  it('takes over a lock whose owner is gone', () => {
    writeFileSync(
      join(dir, 'import.lock'),
      `${JSON.stringify({ pid: 999_999_999, label: 'crashed', startedAt: Date.now() })}\n`,
      'utf8',
    );
    const lock = acquireImportLock(dir, { label: 'recovery' });
    assert.equal(lock.ok, true);
    assert.equal(lock.tookOver, true);
    lock.release();
  });

  it('takes over a lock older than the staleness window', () => {
    writeFileSync(
      join(dir, 'import.lock'),
      `${JSON.stringify({ pid: process.pid, label: 'ancient', startedAt: Date.now() - DEFAULT_STALE_MS - 1000 })}\n`,
      'utf8',
    );
    const lock = acquireImportLock(dir, { label: 'fresh' });
    assert.equal(lock.ok, true);
    assert.equal(lock.tookOver, true);
    lock.release();
  });

  it('releases in every outcome, including a thrown body', async () => {
    await assert.rejects(() =>
      withImportLock(dir, { label: 'boom' }, async () => {
        throw new Error('body failed');
      }),
    );
    assert.equal(existsSync(join(dir, 'import.lock')), false, 'the lock is gone after a failure');

    const outcome = await withImportLock(dir, { label: 'busy' }, async () => 'ran');
    assert.equal(outcome.ran, true);
    assert.equal(outcome.value, 'ran');
  });

  it('reports the busy case instead of queueing', async () => {
    const holder = acquireImportLock(dir, { label: 'holder' });
    const outcome = await withImportLock(dir, { label: 'other' }, async () => 'never');
    assert.equal(outcome.ran, false);
    assert.equal(outcome.reason, 'locked');
    holder.release();
  });
});

describe('boot-time auto import', () => {
  /** @type {{ dir: string, stateDir: string, sessionId: string }} */
  let context;

  before(() => {
    const home = mkdtempSync(join(tmpdir(), 'zcm-auto-'));
    const dir = join(home, 'zcode');
    const fixture = createFixture({ dir });
    fixture.close();
    context = { dir, stateDir: join(home, 'state'), sessionId: fixture.sessionId };
  });

  after(() => {
    rmSync(join(context.dir, '..'), { recursive: true, force: true });
  });

  /** Config for the fixture source, with a private state directory. */
  const configFor = (stateDir) => normalizeConfig({ source: context.dir, stateDir, report: false });

  it('imports pending sessions without being asked', async () => {
    const stateDir = join(context.stateDir, 'first');
    const sink = createMemorySink();
    const logger = recordingLogger();
    const result = await runAutoImport({ config: configFor(stateDir), persistence: sink, logger });

    assert.equal(result.status, 'ran');
    assert.match(result.summary, /新建 1/);
    assert.equal(sink.sessions.size, 1);
    assert.ok(logger.lines.some((line) => line.includes('自动迁移开始')));
    assert.ok(logger.lines.some((line) => line.includes('自动迁移完成')));
    assert.equal(existsSync(join(stateDir, 'import.lock')), false, 'the lock is released');
  });

  it('does nothing at all when everything is current', async () => {
    const stateDir = join(context.stateDir, 'second');
    const sink = createMemorySink();
    const config = configFor(stateDir);
    await runAutoImport({ config, persistence: sink, logger: recordingLogger() });

    const logger = recordingLogger();
    const second = await runAutoImport({ config, persistence: sink, logger });
    assert.equal(second.status, 'current');
    assert.equal(logger.lines.filter((line) => line.includes('自动迁移开始')).length, 0, 'no work, no noise');
  });

  it('tops up only what the source gained, and never forces', async () => {
    const stateDir = join(context.stateDir, 'third');
    const sink = createMemorySink();
    const config = configFor(stateDir);
    const first = await runAutoImport({ config, persistence: sink, logger: recordingLogger() });
    assert.equal(first.status, 'ran');
    const targetId = [...sink.sessions.keys()][0];
    const eventsAfterFirst = sink.sessions.get(targetId).events.length;

    const reopened = createFixture({ dir: context.dir, turns: sampleTurns() });
    reopened.appendTurn({
      turnId: 'turn-auto',
      messages: [
        { role: 'user', id: 'u-auto', at: 1_700_000_100_000, parts: [{ type: 'text', text: '后来的一轮' }] },
        {
          role: 'assistant',
          id: 'a-auto',
          at: 1_700_000_100_500,
          finish: 'stop',
          parts: [{ type: 'step-start' }, { type: 'reasoning', text: '后来产生的思路' }, { type: 'step-finish', reason: 'stop' }],
        },
      ],
    });
    reopened.close();

    const second = await runAutoImport({ config, persistence: sink, logger: recordingLogger() });
    assert.equal(second.status, 'ran');
    assert.match(second.summary, /增量追加 1/);
    assert.ok(sink.sessions.get(targetId).events.length > eventsAfterFirst);
    const statuses = second.results.map((result) => result.status);
    assert.ok(!statuses.includes('conflict'), 'an automatic run must not have forced anything');
  });

  it('records a conflict as a conflict, without rewriting and without throwing', async () => {
    const stateDir = join(context.stateDir, 'fourth');
    const sink = createMemorySink();
    const config = configFor(stateDir);
    await runAutoImport({ config, persistence: sink, logger: recordingLogger() });
    const targetId = [...sink.sessions.keys()][0];
    const before = JSON.stringify(sink.sessions.get(targetId).events);

    const tampered = createFixture({ dir: context.dir, turns: sampleTurns() });
    tampered.rewritePart('a1-p1', { text: '改写过的思路' });
    tampered.close();

    const logger = recordingLogger();
    const result = await runAutoImport({ config, persistence: sink, logger });
    assert.equal(result.status, 'ran', 'a conflict is a recorded outcome, not a crash');
    assert.match(result.summary, /冲突 1/);
    assert.equal(JSON.stringify(sink.sessions.get(targetId).events), before, 'nothing was overwritten');
    assert.ok(logger.lines.some((line) => line.includes('冲突的会话未被改写')), 'the user is told what to do');

    // Reported once: a refusal cannot be resolved by retrying, so repeating it
    // every boot would only make the report noise.
    const second = await runAutoImport({ config, persistence: sink, logger: recordingLogger() });
    assert.equal(second.status, 'current');
    assert.equal(second.pending, 0);

    // `status` still surfaces it, so the decision is not lost.
    const { status } = await import('../src/migrate.js');
    const state = await status(config, { warn: new WarningLog() });
    assert.equal(state.blocked.length, 1);

    // And `--force` is the deliberate way to make a fresh copy.
    const { importSession } = await import('../src/migrate.js');
    const { loadRegistry } = await import('../src/target/registry.js');
    const forced = await importSession({
      config,
      sourceId: context.sessionId,
      sink,
      registry: loadRegistry(stateDir, { warn: new WarningLog() }),
      force: true,
      warn: new WarningLog(context.sessionId),
    });
    assert.equal(forced.status, 'imported');
    assert.notEqual(forced.targetId, targetId, 'the original is left untouched');
    assert.equal(sink.sessions.size, 2);
  });

  it('stays out of the way when another run holds the lock', async () => {
    const stateDir = join(context.stateDir, 'busy');
    const sink = createMemorySink();
    const config = configFor(stateDir);
    const holder = acquireImportLock(stateDir, { label: 'manual run' });
    const logger = recordingLogger();
    const result = await runAutoImport({ config, persistence: sink, logger });
    assert.equal(result.status, 'busy');
    assert.equal(sink.sessions.size, 0, 'a busy plugin does not import');
    holder.release();
  });

  it('leaves a usable registry behind for the command path', async () => {
    const stateDir = join(context.stateDir, 'registry');
    const sink = createMemorySink();
    const config = configFor(stateDir);
    await runAutoImport({ config, persistence: sink, logger: recordingLogger() });
    const registry = loadRegistry(stateDir, { warn: new WarningLog() });
    assert.equal(Object.keys(registry.sessions).length, 1);
    assert.ok(readFileSync(join(stateDir, 'registry.json'), 'utf8').includes(context.sessionId));
    saveRegistry(stateDir, registry);
  });
});
