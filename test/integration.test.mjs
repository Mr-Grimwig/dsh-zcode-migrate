/**
 * End-to-end against the harness's own storage (AC-1, AC-3, FR-4.4/4.5).
 *
 * The unit tests prove the *decisions*; this file proves the *artifact*. It
 * writes through `@deepseek-ai/dsh-session-persistence-jsonl` — the real backend,
 * the real multi-frame zstd container, the real contiguity checks — and then
 * reads the result back twice: once with the plugin's own decoder, and once with
 * the backend's `load()`. A reasoning block that is not `===` after that trip is
 * a failure of the thing the requirement actually cares about.
 *
 * The byte-level assertion in the append case is the strongest statement
 * available about FR-6.2: the artifact is append-only, so the previously stored
 * bytes must remain a literal prefix of the file afterwards. Nothing was
 * rewritten — not even reformatted.
 *
 * Skips itself when no DSH install is reachable, so the suite stays honest on a
 * machine without one.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { WarningLog } from '../src/core/warnings.js';
import { normalizeConfig } from '../src/core/config.js';
import { importSession } from '../src/migrate.js';
import { planSession } from '../src/transform/plan.js';
import { openZcodeDatabase, readSession } from '../src/source/sqlite-source.js';
import { listArtifacts, readSessionArtifact, reasoningBlocksOf } from '../src/target/dsh-log-reader.js';
import { createMemorySink } from '../src/target/session-sink.js';
import { dshRuntimeAvailable, openJsonlBackend } from '../scripts/jsonl-backend.mjs';
import { createFixture, sampleTurns, TRICKY_REASONING } from './fixtures/zcode-fixture.mjs';

const available = dshRuntimeAvailable();

describe('real DSH backend (FR-4.4)', { skip: available ? false : '未找到 DSH 运行时（@deepseek-ai/*），跳过集成测试' }, () => {
  /** @type {{ dir: string, root: string, stateDir: string, sessionId: string, config: object, backend: object }} */
  let ctx;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-e2e-src-'));
    const root = mkdtempSync(join(tmpdir(), 'zcm-e2e-dsh-'));
    const fixture = createFixture({ dir });
    fixture.close();
    const backend = await openJsonlBackend({ root, warn: new WarningLog() });
    ctx = {
      dir,
      root,
      stateDir: join(dir, 'state'),
      sessionId: fixture.sessionId,
      config: normalizeConfig({ source: dir, stateDir: join(dir, 'state'), createMissingDirs: false }),
      backend,
    };
  });

  after(async () => {
    await ctx.backend?.close();
    rmSync(ctx.dir, { recursive: true, force: true });
    rmSync(ctx.root, { recursive: true, force: true });
  });

  /** The one artifact the backend wrote, as raw bytes plus its decoded form. */
  function artifact() {
    const found = listArtifacts(ctx.root);
    assert.equal(found.length, 1, `expected exactly one artifact, saw ${found.length}`);
    const bytes = readFileSync(found[0].path);
    return { ...found[0], bytes, path: found[0].path };
  }

  it('writes a session the harness can load, with reasoning byte-identical (AC-1)', async () => {
    const sink = ctx.backend.sink;
    const registry = { sessions: {} };
    const result = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink,
      registry,
      warn: new WarningLog(ctx.sessionId),
    });

    assert.equal(result.status, 'imported');
    assert.equal(result.fidelity.ok, true, JSON.stringify(result.fidelity));
    ctx.registry = registry;
    ctx.targetId = result.targetId;

    const written = artifact();
    // The file name embeds the format generation from v1 onward, so only the
    // encoding suffix is stable.
    assert.match(written.path, /session(\.v\d+)?\.jsonl\.zstd$/, 'the backend owns the artifact location');

    // 1. Read back with the plugin's own decoder.
    const decoded = readSessionArtifact(ctx.root, result.targetId);
    assert.ok(decoded, 'the artifact must be discoverable by session id');
    assert.equal(decoded.header.version, ctx.backend.sink.formatVersion, "写出的日志版本跟随宿主");
    assert.equal(decoded.header.cwd, 'D:\\code\\fixture');
    assert.equal(decoded.malformed, 0);

    const blocks = reasoningBlocksOf(decoded.events);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].text, TRICKY_REASONING, 'the 200k block survived the zstd trip unchanged');

    // 2. Read back through the harness's own service, which also enforces the
    //    format and repair contracts. The sink is the generation-agnostic door
    //    to it (v0 reads via inspect/load, v3 via an open handle).
    const loaded = await ctx.backend.sink.inspect(result.targetId);
    assert.ok(loaded, 'the harness must be able to read back what was written');
    assert.equal(loaded.events.length, decoded.events.length);
    const viaHarness = reasoningBlocksOf([...loaded.events]);
    assert.deepEqual(
      viaHarness.map((block) => block.text),
      blocks.map((block) => block.text),
    );

    // 3. Compare with the source, block by block.
    const warn = new WarningLog();
    const source = openZcodeDatabase(ctx.dir, { warn });
    const session = readSession(source, ctx.sessionId, { warn });
    source.close();
    const expected = session.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === 'reasoning' && part.text !== '')
      .map((part) => part.text);
    assert.equal(expected.length, viaHarness.length);
    for (let index = 0; index < expected.length; index += 1) {
      assert.equal(expected[index], viaHarness[index].text, `block ${index} differs`);
    }
  });

  it('refuses to duplicate on a second import and leaves the file byte-identical (FR-6.1, AC-3)', async () => {
    const before = artifact().bytes;
    const result = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink: ctx.backend.sink,
      registry: ctx.registry,
      warn: new WarningLog(ctx.sessionId),
    });
    assert.equal(result.status, 'skipped');

    const after = artifact();
    assert.equal(after.bytes.length, before.length, 'an idempotent import must not even touch the artifact');
    assert.equal(after.bytes.equals(before), true);
    assert.equal(listArtifacts(ctx.root).length, 1);
  });

  it('appends only the tail, leaving the stored bytes as a literal prefix (FR-6.2)', async () => {
    const before = artifact().bytes;

    const reopened = createFixture({ dir: ctx.dir, turns: sampleTurns() });
    reopened.appendTurn({
      turnId: 'turn-epsilon',
      messages: [
        { role: 'user', id: 'u7', at: 1_700_000_007_000, parts: [{ type: 'text', text: '继续' }] },
        {
          role: 'assistant',
          id: 'a7',
          at: 1_700_000_007_500,
          finish: 'stop',
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: '追加的思路：emoji 🧪 与代码 `x=1`' },
            { type: 'text', text: '好' },
            { type: 'step-finish', reason: 'stop' },
          ],
        },
      ],
    });
    reopened.close();

    const result = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink: ctx.backend.sink,
      registry: ctx.registry,
      warn: new WarningLog(ctx.sessionId),
    });
    assert.equal(result.status, 'appended');
    assert.equal(result.fidelity.ok, true);

    const after = artifact();
    assert.ok(after.bytes.length > before.length, 'the artifact grew');
    assert.equal(
      after.bytes.subarray(0, before.length).equals(before),
      true,
      'every previously written byte is still the prefix of the file — nothing was rewritten',
    );
    assert.equal(listArtifacts(ctx.root).length, 1, 'the append went to the same session, not a copy');

    const blocks = reasoningBlocksOf(readSessionArtifact(ctx.root, ctx.targetId).events);
    assert.equal(blocks.length, 4);
    assert.equal(blocks.at(-1).text, '追加的思路：emoji 🧪 与代码 `x=1`');
  });

  it('refuses a rewritten prefix, and --force then writes a separate session (FR-6.3)', async () => {
    const before = artifact().bytes;

    const tampered = createFixture({ dir: ctx.dir, turns: sampleTurns() });
    tampered.db.prepare("UPDATE part SET data = json_set(data, '$.text', '被改写的思路') WHERE id = 'a1-p1'").run();
    tampered.close();

    const refused = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink: ctx.backend.sink,
      registry: ctx.registry,
      warn: new WarningLog(ctx.sessionId),
    });
    assert.equal(refused.status, 'conflict');
    assert.equal(artifact().bytes.equals(before), true, 'a refusal must not modify the stored log');

    const forced = await importSession({
      config: ctx.config,
      sourceId: ctx.sessionId,
      sink: ctx.backend.sink,
      registry: ctx.registry,
      force: true,
      warn: new WarningLog(ctx.sessionId),
    });
    assert.equal(forced.status, 'imported');
    assert.notEqual(forced.targetId, ctx.targetId);
    assert.equal(listArtifacts(ctx.root).length, 2, 'the forced copy lands beside the original');

    const forcedBlocks = reasoningBlocksOf(readSessionArtifact(ctx.root, forced.targetId).events);
    assert.equal(forcedBlocks[0].text.startsWith('被改写的思路'), true);
    const originalBlocks = reasoningBlocksOf(readSessionArtifact(ctx.root, ctx.targetId).events);
    assert.equal(originalBlocks[0].text, TRICKY_REASONING, 'the original session kept its own history');
  });

  it('re-plans to exactly what is on disk: the log equals the plan (FR-3.2, NFR-3)', async () => {
    // Self-contained on purpose: the shared fixture above has, by now, been
    // appended to and tampered with, so "plan equals log" is only a meaningful
    // claim against a session imported exactly once from an unchanged source.
    const dir = mkdtempSync(join(tmpdir(), 'zcm-replan-src-'));
    const root = mkdtempSync(join(tmpdir(), 'zcm-replan-dsh-'));
    const backend = await openJsonlBackend({ root, warn: new WarningLog() });
    try {
      const fixture = createFixture({ dir });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: join(dir, 'state') });
      const imported = await importSession({
        config,
        sourceId: fixture.sessionId,
        sink: backend.sink,
        registry: { sessions: {} },
        warn: new WarningLog(fixture.sessionId),
      });
      assert.equal(imported.status, 'imported');

      const warn = new WarningLog();
      const source = openZcodeDatabase(dir, { warn });
      const session = readSession(source, fixture.sessionId, { warn });
      source.close();
      const plan = planSession(session, { warn });

      const stored = readSessionArtifact(root, imported.targetId).events;
      const { splitTurns } = await import('../src/migrate.js');
      const written = splitTurns(stored);
      assert.equal(stored.length, plan.events.length, 'the stored log has exactly the planned number of events');
      assert.equal(written.consumed, stored.length, 'every stored event belongs to a planned turn — no strays');

      const planParts = splitTurns(plan.events);
      assert.equal(written.turns.length, planParts.turns.length);
      for (const [index, turn] of written.turns.entries()) {
        assert.equal(turn.digest, planParts.turns[index].digest, `turn ${index + 1} differs between plan and disk`);
      }
      assert.equal(
        splitTurns(stored).prelude.filter((event) => event.type !== 'session/title').length,
        splitTurns(plan.events).prelude.filter((event) => event.type !== 'session/title').length,
      );
    } finally {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('memory sink parity', { skip: available ? false : '未找到 DSH 运行时，跳过' }, () => {
  it('produces the same event bodies as the real backend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-parity-'));
    const root = mkdtempSync(join(tmpdir(), 'zcm-parity-dsh-'));
    const backend = await openJsonlBackend({ root, warn: new WarningLog() });
    try {
      const fixture = createFixture({ dir });
      fixture.close();
      const config = normalizeConfig({ source: dir, stateDir: join(dir, 'state') });
      // Same target format as the backend, so the comparison is about the sink
      // abstraction and not about which log generation each one writes.
      const memory = createMemorySink({ formatVersion: backend.sink.formatVersion });
      const options = { config, sourceId: fixture.sessionId, warn: new WarningLog(fixture.sessionId) };

      const viaMemory = await importSession({ ...options, sink: memory, registry: { sessions: {} } });
      const viaBackend = await importSession({ ...options, sink: backend.sink, registry: { sessions: {} } });

      const fromMemory = memory.sessions.get(viaMemory.targetId).events;
      const fromDisk = readSessionArtifact(root, viaBackend.targetId).events;
      assert.equal(fromMemory.length, fromDisk.length);
      assert.equal(JSON.stringify(fromMemory), JSON.stringify(fromDisk), 'the sink abstraction hides nothing');
    } finally {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
