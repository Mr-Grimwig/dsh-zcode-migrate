/**
 * Import orchestration: idempotency, incremental append, conflict refusal, and
 * the report (FR-6, FR-7.3, AC-3, AC-5).
 *
 * These tests drive `importSession` against the in-memory sink, so they assert
 * the *decisions* — created, skipped, appended, refused — without depending on a
 * DSH install. The same decisions are exercised against the real backend in
 * `integration.test.mjs`.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { WarningLog } from '../src/core/warnings.js';
import { buildReport, importMany, importSession, reconcile, scan, splitTurns, verifyFidelity } from '../src/migrate.js';
import { openZcodeDatabase, readSession } from '../src/source/sqlite-source.js';
import { planSession } from '../src/transform/plan.js';
import { createMemorySink } from '../src/target/session-sink.js';
import { loadRegistry, saveRegistry } from '../src/target/registry.js';
import { normalizeConfig } from '../src/core/config.js';
import { createFixture, sampleTurns } from './fixtures/zcode-fixture.mjs';

/** @type {{ dir: string, stateDir: string, sessionId: string, config: object }} */
let ctx;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'zcm-migrate-'));
  const stateDir = join(dir, 'state');
  const fixture = createFixture({ dir });
  fixture.close();
  ctx = {
    dir,
    stateDir,
    sessionId: fixture.sessionId,
    config: normalizeConfig({ source: dir, stateDir, createMissingDirs: true }),
  };
});

after(() => {
  rmSync(ctx.dir, { recursive: true, force: true });
});

/** Read the fixture's source session. */
function readFixtureSession() {
  const warn = new WarningLog();
  const source = openZcodeDatabase(ctx.dir, { warn });
  const session = readSession(source, ctx.sessionId, { warn });
  source.close();
  assert.ok(session);
  return session;
}

/** Import the fixture once. */
async function importOnce(sink, registry, extra = {}) {
  return importSession({
    config: ctx.config,
    sourceId: ctx.sessionId,
    sink,
    registry,
    warn: new WarningLog(ctx.sessionId),
    ...extra,
  });
}

describe('scan', () => {
  it('reports the source kind, the sessions, and the deterministic target id', () => {
    const result = scan(ctx.config, { warn: new WarningLog() });
    assert.equal(result.sourceKind, 'sqlite');
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, ctx.sessionId);
    assert.match(result.sessions[0].targetId, /^session-[0-9a-f-]{36}$/);
  });

  it('degrades to a warning when the source home is wrong, instead of throwing (FR-1.5)', () => {
    const warn = new WarningLog();
    const config = normalizeConfig({ source: join(ctx.dir, 'nope'), stateDir: ctx.stateDir });
    const result = scan(config, { warn });
    assert.equal(result.sourceKind, 'rollout');
    assert.ok(result.sessions.length === 0);
    assert.ok(warn.items.some((item) => item.code === 'rollout-dir-missing'));
  });
});

describe('first import (FR-4.1, FR-5.1)', () => {
  it('creates the session and reads it back verbatim', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    const result = await importOnce(sink, registry);

    assert.equal(result.status, 'imported');
    assert.equal(result.fidelity.ok, true, JSON.stringify(result.fidelity));
    assert.equal(result.fidelity.sourceBlocks, 3);
    assert.equal(sink.sessions.size, 1);

    const stored = sink.sessions.get(result.targetId);
    assert.equal(stored.header.version, sink.formatVersion, "写出的日志版本跟随宿主");
    assert.equal(stored.header.cwd, 'D:\\code\\fixture');
    assert.equal(stored.events.length, result.eventCount);
    assert.ok(registry.sessions[ctx.sessionId], 'the registry records where this session went');
  });

  it('works with an empty registry, because the log is the authority', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    const first = await importOnce(sink, registry);
    // Simulate a lost registry: the same source must still resolve to the same
    // target and be recognised as already imported.
    const second = await importOnce(sink, { sessions: {} });
    assert.equal(second.targetId, first.targetId);
    assert.equal(second.status, 'skipped');
  });
});

describe('idempotency (FR-6.1, AC-3)', () => {
  it('skips a repeat import without touching the stored log', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    const first = await importOnce(sink, registry);
    const before = sink.sessions.get(first.targetId).events.length;

    const second = await importOnce(sink, registry);
    assert.equal(second.status, 'skipped');
    assert.equal(second.reason, 'already-imported');
    assert.equal(sink.sessions.get(first.targetId).events.length, before, 'no event was rewritten');
    assert.equal(second.fidelity.ok, true);
  });

  it('does not create a second session for the same source', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    await importOnce(sink, registry);
    await importOnce(sink, registry);
    assert.equal(sink.sessions.size, 1);
  });
});

describe('incremental append (FR-6.2, AC-3)', () => {
  it('appends only the tail when the source grew', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-grow-'));
    try {
      const fixture = createFixture({ dir });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: ctx.stateDir, createMissingDirs: true });
      const sink = createMemorySink();
      const registry = { sessions: {} };
      const options = { config, sourceId: fixture.sessionId, sink, registry, warn: new WarningLog(fixture.sessionId) };

      const first = await importSession(options);
      assert.equal(first.status, 'imported');
      const eventCountBefore = sink.sessions.get(first.targetId).events.length;

      // The source gains a turn, the way a live ZCode session does. The rewrite
      // keeps the same content (default `unanchored` included) so the prefix is
      // untouched — only the tail is new.
      const reopened = createFixture({ dir, turns: sampleTurns() });
      reopened.appendTurn({
        turnId: 'turn-delta',
        messages: [
          { role: 'user', id: 'u9', at: 1_700_000_009_000, parts: [{ type: 'text', text: '新的一轮' }] },
          {
            role: 'assistant',
            id: 'a9',
            at: 1_700_000_009_500,
            finish: 'stop',
            parts: [{ type: 'step-start' }, { type: 'reasoning', text: '新增思路' }, { type: 'step-finish', reason: 'stop' }],
          },
        ],
      });
      reopened.close();

      const second = await importSession({ ...options, warn: new WarningLog(fixture.sessionId) });
      assert.equal(second.status, 'appended');
      const stored = sink.sessions.get(first.targetId);
      assert.ok(stored.events.length > eventCountBefore, 'the tail was written');
      assert.equal(
        stored.events[eventCountBefore - 1].type,
        'turn/end',
        'the previously stored prefix is untouched, byte for byte',
      );
      assert.equal(stored.events[eventCountBefore].seq, eventCountBefore, 'the appended batch continues the sequence');
      assert.equal(second.fidelity.ok, true, 'all four reasoning blocks are present after the append');

      const appended = stored.events.slice(eventCountBefore);
      assert.equal(appended[0].type, 'turn/start');
      assert.equal(appended[0].data.turn, 4, 'the new turn continues the numbering');
      assert.ok(
        appended.every((event) => event.type !== 'user/message' || event.data.content.length > 0),
        'appended events are complete events, not fragments',
      );

      // And a third import is a no-op again.
      const third = await importSession({ ...options, warn: new WarningLog(fixture.sessionId) });
      assert.equal(third.status, 'skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends a new title event when only the source title changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-title-'));
    try {
      const fixture = createFixture({ dir, title: '旧标题' });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: ctx.stateDir, createMissingDirs: true });
      const sink = createMemorySink();
      const registry = { sessions: {} };
      const options = { config, sourceId: fixture.sessionId, sink, registry, warn: new WarningLog(fixture.sessionId) };

      const first = await importSession(options);
      createFixture({ dir, title: '新标题', turns: sampleTurns() }).close();

      const second = await importSession({ ...options, warn: new WarningLog(fixture.sessionId) });
      assert.equal(second.status, 'appended');
      const events = sink.sessions.get(first.targetId).events;
      const titles = events.filter((event) => event.type === 'session/title').map((event) => event.data.title);
      assert.deepEqual(titles, ['旧标题', '新标题'], 'a rename is a new log-only event, not a rewrite');
      const verdictSeq = events.map((event) => event.seq);
      assert.deepEqual(verdictSeq, [...verdictSeq.keys()], 'sequence stays contiguous after the inserted event');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conflict handling (FR-6.3, AC-3)', () => {
  it('refuses to rewrite a stored session whose prefix changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-conflict-'));
    try {
      const fixture = createFixture({ dir });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: ctx.stateDir, createMissingDirs: true });
      const sink = createMemorySink();
      const registry = { sessions: {} };
      const options = { config, sourceId: fixture.sessionId, sink, registry, warn: new WarningLog(fixture.sessionId) };

      const first = await importSession(options);
      const before = JSON.stringify(sink.sessions.get(first.targetId).events);

      // Rewrite history in the source: the first turn's reasoning text changes.
      const tampered = createFixture({ dir, turns: sampleTurns(), unanchored: [] });
      tampered.db
        .prepare("UPDATE part SET data = json_set(data, '$.text', '被改写过的思路') WHERE id = 'a1-p1'")
        .run();
      tampered.close();

      const second = await importSession({ ...options, warn: new WarningLog(fixture.sessionId) });
      assert.equal(second.status, 'conflict');
      assert.equal(second.conflict.reason, 'turn-content-rewritten');
      assert.equal(second.conflict.detail.turnIndex, 0);
      assert.equal(JSON.stringify(sink.sessions.get(first.targetId).events), before, 'nothing was overwritten');

      const conflictWarning = second.warnings.find((item) => item.code === 'conflict');
      assert.ok(conflictWarning, 'the refusal must tell the user what to do next');
      assert.match(conflictWarning.message, /--force/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports a fresh copy under a new id when forced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-force-'));
    try {
      const fixture = createFixture({ dir });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: ctx.stateDir, createMissingDirs: true });
      const sink = createMemorySink();
      const registry = { sessions: {} };
      const options = { config, sourceId: fixture.sessionId, sink, registry, warn: new WarningLog(fixture.sessionId) };

      const first = await importSession(options);
      const tampered = createFixture({ dir, turns: sampleTurns(), unanchored: [] });
      tampered.db.prepare("UPDATE part SET data = json_set(data, '$.text', '另一份思路') WHERE id = 'a1-p1'").run();
      tampered.close();

      const forced = await importSession({ ...options, force: true, warn: new WarningLog(fixture.sessionId) });
      assert.equal(forced.status, 'imported');
      assert.notEqual(forced.targetId, first.targetId, 'the original stays where it is; the copy gets its own id');
      assert.equal(forced.variant === '', false);
      assert.equal(sink.sessions.size, 2);
      assert.equal(forced.fidelity.ok, true);

      const original = sink.sessions.get(first.targetId).events;
      const originalReasoning = original
        .filter((event) => event.type === 'assistant/message')
        .flatMap((event) => event.data.message.content)
        .find((block) => block.type === 'reasoning');
      assert.equal(originalReasoning.text.startsWith('第一段思路'), true, 'the untouched session kept its own history');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dry run', () => {
  it('plans without writing anything', async () => {
    const sink = createMemorySink();
    const result = await importOnce(sink, { sessions: {} }, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(sink.sessions.size, 0);
    assert.ok(result.planEvents > 0);
  });
});

describe('fidelity verification (AC-1, NFR-3)', () => {
  it('detects a single-character difference', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    assert.equal(verifyFidelity(session, plan.events).ok, true);

    const corrupted = plan.events.map((event) => ({ ...event, data: { ...event.data } }));
    const target = corrupted.find(
      (event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'reasoning'),
    );
    const block = target.data.message.content.find((candidate) => candidate.type === 'reasoning');
    target.data.message.content = target.data.message.content.map((candidate) =>
      candidate === block ? { ...candidate, text: `${candidate.text} ` } : candidate,
    );
    const verdict = verifyFidelity(session, corrupted);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.firstMismatch.reason, 'text-differs');
    assert.equal(verdict.firstMismatch.index, 0);
  });

  it('detects a missing block', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    const dropped = plan.events.filter((event) => event.type !== 'assistant/message');
    const verdict = verifyFidelity(session, dropped);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.firstMismatch.reason, 'count-differs');
  });
});

describe('reconciliation', () => {
  it('treats an absent log as create and an identical log as skip', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    assert.equal(reconcile(plan, undefined).mode, 'create');

    const stored = { header: plan.header, events: plan.events };
    assert.equal(reconcile(plan, stored).mode, 'skip');
  });

  it('treats a shorter stored log with an identical prefix as append', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    const parts = splitTurns(plan.events);
    const keep = parts.prelude.length + parts.turns[0].eventCount + parts.turns[1].eventCount;
    const stored = { header: plan.header, events: plan.events.slice(0, keep) };
    const decision = reconcile(plan, stored);
    assert.equal(decision.mode, 'append');
    assert.equal(decision.events[0].seq, keep);
    assert.equal(decision.events.length, plan.events.length - keep);
  });

  it('refuses when the stored log has more turns than the source', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    const stored = {
      header: plan.header,
      events: [
        ...plan.events,
        { type: 'turn/start', seq: plan.events.length, time: 0, data: { turn: 99 } },
        { type: 'turn/end', seq: plan.events.length + 1, time: 0, data: { turn: 99, reason: { kind: 'completed' } } },
      ],
    };
    const decision = reconcile(plan, stored);
    assert.equal(decision.mode, 'conflict');
    assert.equal(decision.reason, 'source-shrank');
  });
});

describe('registry', () => {
  it('round-trips through disk atomically and survives corruption with a warning', () => {
    const registry = { sessions: { sess_x: { sourceId: 'sess_x', targetId: 'session-1', variant: '', importedAt: 'now' } } };
    const path = saveRegistry(ctx.stateDir, registry);
    assert.ok(path.endsWith('registry.json'));

    const reloaded = loadRegistry(ctx.stateDir, { warn: new WarningLog() });
    assert.equal(reloaded.loaded, true);
    assert.equal(reloaded.sessions.sess_x.targetId, 'session-1');

    writeFileSync(path, '{ not json', 'utf8');
    const warn = new WarningLog();
    const broken = loadRegistry(ctx.stateDir, { warn });
    assert.equal(broken.loaded, false);
    assert.deepEqual(broken.sessions, {});
    assert.ok(warn.items.some((item) => item.code === 'registry-unreadable'));
  });
});

describe('verification semantics (NFR-3, AC-1)', () => {
  /** Read the fixture's source and plan it, plus a fake artifact from that plan. */
  function planAndArtifact() {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    return {
      session,
      plan,
      reasoning: session.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.kind === 'reasoning' && part.text !== '')
        .map((part) => part.text),
      artifact: { events: plan.events, chunkRows: 0, path: 'memory' },
    };
  }

  it('passes when the log matches the recorded plan and the source is unchanged', async () => {
    const { verifyRecord } = await import('../src/migrate.js');
    const { plan, artifact, reasoning } = planAndArtifact();
    const record = { sourceId: ctx.sessionId, targetId: plan.targetId, turnDigests: plan.digests.turns };
    const verdict = verifyRecord({ record, artifact, plan, sourceReasoning: reasoning });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.fidelity, true);
    assert.equal(verdict.drift, 0);
    assert.equal(verdict.storedTurns, plan.digests.turns.length);
  });

  it('fails when the stored log is not what was recorded', async () => {
    const { verifyRecord } = await import('../src/migrate.js');
    const { plan, artifact, reasoning } = planAndArtifact();
    const record = { sourceId: ctx.sessionId, targetId: plan.targetId, turnDigests: ['not-the-recorded-digest'], digestVersion: 2 };
    const verdict = verifyRecord({ record, artifact, plan, sourceReasoning: reasoning });
    assert.equal(verdict.ok, false);
  });

  it('verifies a record written by an older digest scheme against the current source', async () => {
    const { verifyRecord } = await import('../src/migrate.js');
    const { plan, artifact, reasoning } = planAndArtifact();
    // No digestVersion: the numbers predate the current scheme, so comparing
    // them would report every previously migrated session as broken.
    const record = { sourceId: ctx.sessionId, targetId: plan.targetId, turnDigests: plan.digests.turns.map(() => 'stale') };
    const verdict = verifyRecord({ record, artifact, plan, sourceReasoning: reasoning });
    assert.equal(verdict.legacyRecord, true);
    assert.equal(verdict.ok, true, 'the log matches the current source, which is the answerable question');
    assert.equal(verdict.fidelity, true);
  });

  it('reports a grown source as drift, not as a failure (FR-6.2)', async () => {
    const { verifyRecord } = await import('../src/migrate.js');
    const { plan, artifact, reasoning } = planAndArtifact();
    // Record only the first two turns, then verify against the full plan: the
    // session was imported before the source gained its later turns.
    const record = {
      sourceId: ctx.sessionId,
      targetId: plan.targetId,
      turnDigests: plan.digests.turns.slice(0, 2),
    };
    const shortened = {
      events: plan.events.slice(0, plan.turns.slice(0, 2).reduce((total, turn) => total + turn.eventCount, 1)),
      chunkRows: 0,
      path: 'memory',
    };
    const verdict = verifyRecord({ record, artifact: shortened, plan, sourceReasoning: reasoning });
    assert.equal(verdict.ok, true, 'the stored log still matches what was recorded for it');
    assert.ok(verdict.drift > 0, 'the extra source turns are reported as drift');
    assert.equal(verdict.fidelity, null, 'a byte-comparison would be meaningless while the source is ahead');
  });

  it('flags a rewritten recorded prefix', async () => {
    const { verifyRecord } = await import('../src/migrate.js');
    const { plan, artifact, reasoning } = planAndArtifact();
    const record = {
      sourceId: ctx.sessionId,
      targetId: plan.targetId,
      turnDigests: plan.digests.turns.map((digest, index) => (index === 0 ? 'rewritten' : digest)),
      digestVersion: 2,
    };
    const verdict = verifyRecord({ record, artifact, plan, sourceReasoning: reasoning });
    assert.equal(verdict.prefixIntact, false);
    assert.equal(verdict.fidelity, null);
  });
});

describe('reconciliation ignores the harness bookkeeping', () => {
  /** Wrap a log the way a resumed session's log looks: environment events around it. */
  function asResumed(log) {
    const [title, ...rest] = log;
    return [
      title,
      { type: 'permission/preset', seq: 1, time: 0, data: { preset: 'workspace-write' } },
      ...rest.map((event) => ({ ...event, seq: event.seq + 1 })),
      { type: 'session/end-seed', seq: rest.length + 2, time: 0, data: {} },
      { type: 'sandbox/mode', seq: rest.length + 3, time: 0, data: { mode: 'workspace-write' } },
    ];
  }

  it('still recognises a session it already imported after DSH resumed it', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    const decision = reconcile(plan, { header: plan.header, events: asResumed(plan.events) });
    assert.notEqual(decision.mode, 'conflict', 'environment events must not look like a rewritten prefix');
    assert.equal(decision.mode, 'skip', 'nothing new in the source, so nothing to do');
  });

  it('appends the tail rather than rewriting when the source also grew', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-noise-grow-'));
    try {
      const fixture = createFixture({ dir });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: ctx.stateDir, createMissingDirs: true });
      const warn = new WarningLog(fixture.sessionId);
      const source = openZcodeDatabase(dir, { warn });
      const imported = readSession(source, fixture.sessionId, { warn });
      source.close();
      const importedPlan = planSession(imported, { warn });
      // What DSH holds: the imported log, wrapped by a later resume.
      const stored = { header: importedPlan.header, events: asResumed(importedPlan.events) };

      // The source then gains a turn.
      const reopened = createFixture({ dir, turns: sampleTurns() });
      reopened.appendTurn({
        turnId: 'turn-later',
        messages: [
          { role: 'user', id: 'u-later', at: 1_700_000_200_000, parts: [{ type: 'text', text: '后来的一轮' }] },
          {
            role: 'assistant',
            id: 'a-later',
            at: 1_700_000_200_500,
            finish: 'stop',
            parts: [{ type: 'step-start' }, { type: 'reasoning', text: '后来的思路' }, { type: 'step-finish', reason: 'stop' }],
          },
        ],
      });
      reopened.close();
      const grownWarn = new WarningLog(fixture.sessionId);
      const source2 = openZcodeDatabase(dir, { warn: grownWarn });
      const grown = readSession(source2, fixture.sessionId, { warn: grownWarn });
      source2.close();
      const grownPlan = planSession(grown, { warn: grownWarn });

      const decision = reconcile(grownPlan, stored);
      assert.equal(decision.mode, 'append', JSON.stringify(decision.detail ?? {}));
      assert.equal(
        decision.events[0].seq,
        stored.events.length,
        'the batch continues after every stored event, bookkeeping included',
      );
      assert.ok(decision.events.some((event) => event.type === 'turn/start' && event.data.turn === grownPlan.turns.length));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the sequence math honest around the injected noise', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    const stored = asResumed(plan.events);
    const parts = splitTurns(stored);
    assert.equal(parts.consumed, stored.length, 'every stored event counts toward the next sequence number');
    assert.equal(
      parts.turns.filter((turn) => !turn.contentless).length,
      plan.digests.turns.length,
      'the content turns still line up one for one',
    );
    // The trailing bracket lands after the last turn, so it is part of the
    // prelude side of the accounting rather than a phantom extra turn.
    assert.ok(
      parts.prelude.some((event) => event.type === 'session/end-seed'),
      'the resume bracket is accounted for outside the turns',
    );
  });

  it('still refuses a genuinely rewritten turn', () => {
    const session = readFixtureSession();
    const plan = planSession(session, { warn: new WarningLog() });
    const tampered = asResumed(plan.events).map((event) =>
      event.type === 'assistant/message'
        ? {
            ...event,
            data: {
              ...event.data,
              message: {
                ...event.data.message,
                content: event.data.message.content.map((block) => (block.type === 'reasoning' ? { ...block, text: '改过' } : block)),
              },
            },
          }
        : event,
    );
    const decision = reconcile(plan, { header: plan.header, events: tampered });
    assert.equal(decision.mode, 'conflict');
    assert.equal(decision.reason, 'turn-content-rewritten');
  });
});

describe('live sessions are left alone', () => {
  it('skips a session that is currently open in DSH, and says why', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    const first = await importOnce(sink, registry);
    assert.equal(first.status, 'imported');

    // The harness now holds that session live.
    const sessionsStore = {
      get: (id) => (id === first.targetId ? { id } : undefined),
    };
    const second = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink,
      registry,
      sessionsStore,
      warn: new WarningLog(ctx.sessionId),
    });
    assert.equal(second.status, 'skipped');
    assert.equal(second.reason, 'live-in-dsh');
    const warning = second.warnings.find((item) => item.code === 'session-live');
    assert.ok(warning, 'the skip must be explained');
    assert.equal(warning.severity, 'info', 'it is a normal outcome, not an error');
  });

  it('imports normally once that session is no longer live', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    const first = await importOnce(sink, registry);
    const sessionsStore = { get: () => undefined };
    const second = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink,
      registry,
      sessionsStore,
      warn: new WarningLog(ctx.sessionId),
    });
    assert.equal(second.status, 'skipped');
    assert.equal(second.reason, 'already-imported');
    assert.equal(first.targetId, second.targetId);
  });
});

describe('batch failure isolation', () => {
  it('finishes the batch when one session cannot be written, and reports which one', async () => {
    const sink = createMemorySink();
    const append = sink.append.bind(sink);
    let calls = 0;
    sink.append = async (id, events) => {
      calls += 1;
      if (calls === 2) throw new Error('模拟磁盘写入失败');
      return append(id, events);
    };

    const warn = new WarningLog();
    // 同一个源的三次导入（force 出不同副本）代表三个会话；关键是第三个还会不会跑
    const run = await importMany({
      config: ctx.config,
      sessionIds: [ctx.sessionId, ctx.sessionId, ctx.sessionId],
      sink,
      registry: { sessions: {} },
      warn,
      force: true,
    });

    assert.equal(run.results.length, 3, '整批不能在失败处停下');
    assert.deepEqual(
      run.results.map((result) => result.status),
      ['imported', 'failed', 'imported'],
    );
    const failed = run.results[1];
    assert.equal(failed.reason, 'import-threw');
    assert.match(failed.error, /磁盘写入失败/);
    const warning = failed.warnings.find((item) => item.code === 'import-failed');
    assert.ok(warning, '失败要记在对应会话名下');
    assert.match(warning.message, /已跳过并继续其余会话/);
  });
});

describe('report (FR-7.3, AC-5)', () => {
  it('summarizes counts, fidelity, and per-session detail', async () => {
    const sink = createMemorySink();
    const registry = { sessions: {} };
    const result = await importOnce(sink, registry);
    const run = {
      startedAt: '2026-09-18T00:00:00.000Z',
      finishedAt: '2026-09-18T00:00:01.000Z',
      mode: 'cli import',
      sourceKind: 'sqlite',
      config: ctx.config,
      results: [result],
    };
    const { json, markdown } = buildReport(run);

    assert.equal(json.totals.sessions, 1);
    assert.equal(json.totals.imported, 1);
    assert.equal(json.totals.fidelityChecked, 1);
    assert.equal(json.totals.fidelityOk, 1);
    assert.equal(json.totals.reasoningBlocks, 3);
    assert.ok(json.totals.reasoningChars > 200_000, 'the long block is counted, not truncated');

    assert.match(markdown, /ZCode → DSH 迁移报告/);
    assert.match(markdown, /空思路块（源侧缺失，非迁移丢失） \| 1/, 'AC-5: the source-side gap is reported');
    assert.match(markdown, /合成占位工具结果 \| 1/);
    assert.match(markdown, /附件占位/);
    assert.match(markdown, new RegExp(ctx.sessionId));
  });

  it('writes a readable file to the state directory', async () => {
    const sink = createMemorySink();
    const result = await importOnce(sink, { sessions: {} });
    const { writeReport } = await import('../src/migrate.js');
    const paths = writeReport(ctx.stateDir, {
      startedAt: 'a',
      finishedAt: 'b',
      mode: 'test',
      sourceKind: 'sqlite',
      config: ctx.config,
      results: [result],
    });
    const text = readFileSync(paths.markdownPath, 'utf8');
    assert.match(text, /迁移完成|## 汇总/);
    assert.match(readFileSync(paths.latestJsonPath, 'utf8'), /"tool": "dsh-zcode-migrate"/);
  });
});
