/**
 * The plugin entry: command surface (FR-7.1), settings wiring (FR-7.2), and
 * graceful degradation when optional services are missing (FR-8.2).
 *
 * The harness itself is faked here — a command runtime that records what was
 * registered, a settings provider that hands back a live scope — because what is
 * being tested is the plugin's wiring, not cordis. The persistence service is the
 * real seam (`create`/`append`/`inspect`), backed by the in-memory sink, so the
 * command path is exercised end to end.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createMemorySink } from '../src/target/session-sink.js';
import { createFixture } from './fixtures/zcode-fixture.mjs';
import { parseInvocation, runCommand, COMMAND_NAME } from '../src/commands.js';
import { normalizeConfig } from '../src/core/config.js';
import { WarningLog } from '../src/core/warnings.js';

/** A command runtime that records registrations and can be invoked. */
function fakeCommands() {
  /** @type {Map<string, object>} */
  const registered = new Map();
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };
}

/** A settings provider that returns a live scope the test can mutate. */
function fakeSettings() {
  /** @type {object|undefined} */
  let value;
  const calls = [];
  return {
    calls,
    set(next) {
      value = next;
    },
    register(namespace, schema, options) {
      calls.push({ namespace, schema, options });
      return { get: () => value };
    },
  };
}

/**
 * Minimal cordis-context stand-in.
 *
 * `sessionPersistence` is wired to the in-memory sink so the plugin entry's
 * boot-time auto-import has somewhere to write — the default configuration
 * means `apply()` really does migrate on load, and the test asserts that.
 */
function fakeContext(services) {
  const debug = [];
  const info = [];
  return {
    debug,
    info,
    get: (name) => services[name],
    logger: {
      debug: (message) => debug.push(message),
      info: (message) => info.push(message),
      warn: () => {},
    },
    effect: (factory) => factory(),
  };
}

/** @type {{ dir: string, stateDir: string, sessionId: string, home: string }} */
let fixtureInfo;

before(() => {
  const home = mkdtempSync(join(tmpdir(), 'zcm-plugin-'));
  const dir = join(home, 'zcode');
  const created = createFixture({ dir });
  created.close();
  fixtureInfo = { home, dir, stateDir: join(home, 'state'), sessionId: created.sessionId };
});

after(() => {
  rmSync(fixtureInfo.home, { recursive: true, force: true });
});

describe('command parsing', () => {
  it('splits a verb, positional arguments, and flags', () => {
    const parsed = parseInvocation(' import sess_1 sess_2 --force --source=D:/z --dry-run ');
    assert.equal(parsed.verb, 'import');
    assert.deepEqual(parsed.args, ['sess_1', 'sess_2']);
    assert.deepEqual(parsed.flags, { force: true, source: 'D:/z', 'dry-run': true });
  });

  it('is total on empty and flag-only input, and finds the verb after flags', () => {
    assert.deepEqual(parseInvocation(''), { verb: '', args: [], flags: {} });
    assert.deepEqual(parseInvocation(undefined), { verb: '', args: [], flags: {} });
    assert.deepEqual(parseInvocation('--force'), { verb: '', args: [], flags: { force: true } });
    assert.deepEqual(parseInvocation('--force all'), { verb: 'all', args: [], flags: { force: true } });
  });
});

describe('plugin entry (FR-7.1, FR-7.2, FR-8.2)', () => {
  it('registers the slash command and the settings namespace', async () => {
    const { installSurfaces } = await import('../src/index.js');
    const commands = fakeCommands();
    const settings = fakeSettings();
    const ctx = fakeContext({ commands, settings });

    const installed = installSurfaces(ctx, {
      initial: normalizeConfig({ source: fixtureInfo.dir, stateDir: fixtureInfo.stateDir }),
      schema: { toJSON: () => ({ type: 'object' }) },
      logger: ctx.logger,
    });

    assert.deepEqual(installed.registered, [`/${COMMAND_NAME}`]);
    assert.equal(installed.settingsRegistered, true);
    assert.equal(settings.calls.length, 1);
    assert.equal(settings.calls[0].namespace, 'zcode-migrate');
    assert.equal(settings.calls[0].options.applies, 'live');
    assert.equal(settings.calls[0].options.base.source, fixtureInfo.dir);

    const definition = commands.registered.get(COMMAND_NAME);
    assert.match(definition.description, /ZCode/);
    assert.ok(definition.input.hint.includes('scan'));
    assert.equal(typeof definition.handler, 'function');

    installed.dispose();
    assert.equal(commands.registered.size, 0, 'disposal unregisters the command');
  });

  it('keeps working with no optional service at all', async () => {
    const { apply } = await import('../src/index.js');
    const ctx = fakeContext({});
    assert.doesNotThrow(() => apply(ctx, { source: fixtureInfo.dir, autoImport: 'off' }));
    assert.ok(
      ctx.debug.some((message) => message.includes('commands 服务不可用')),
      'the absence is reported, not hidden',
    );
  });

  it('migrates by itself on load, with no command typed (default config)', async () => {
    const { apply } = await import('../src/index.js');
    const sink = createMemorySink();
    const ctx = fakeContext({ sessionPersistence: sink });
    const stateDir = join(fixtureInfo.home, `state-auto-${Date.now()}`);

    apply(ctx, { source: fixtureInfo.dir, stateDir, report: false });
    assert.ok(ctx.info.some((line) => line.includes('启动时自动补齐已开启')), 'load reports the default');

    // The pass is scheduled, not awaited: wait for the observable effect.
    const deadline = Date.now() + 15_000;
    while (sink.sessions.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(sink.sessions.size, 1, 'the boot-time pass imported the pending session');
    assert.ok(ctx.info.some((line) => line.includes('自动迁移完成')), 'and said so');
  });

  it('does not migrate on load when autoImport is off', async () => {
    const { apply } = await import('../src/index.js');
    const sink = createMemorySink();
    const ctx = fakeContext({ sessionPersistence: sink });
    apply(ctx, { source: fixtureInfo.dir, stateDir: join(fixtureInfo.home, `state-off-${Date.now()}`), autoImport: 'off', report: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sink.sessions.size, 0);
    assert.ok(!ctx.info.some((line) => line.includes('自动补齐已开启')));
  });

  it('lets live settings override the patch config (FR-7.2)', async () => {
    const { installSurfaces } = await import('../src/index.js');
    const settings = fakeSettings();
    const commands = fakeCommands();
    const ctx = fakeContext({ commands, settings });

    const installed = installSurfaces(ctx, {
      initial: normalizeConfig({ source: join(fixtureInfo.home, 'wrong'), stateDir: fixtureInfo.stateDir }),
      schema: { toJSON: () => ({}) },
      logger: ctx.logger,
    });
    assert.equal(installed.getConfig().zcodeHome, join(fixtureInfo.home, 'wrong'));

    settings.set({ source: fixtureInfo.dir });
    assert.equal(installed.getConfig().zcodeHome, fixtureInfo.dir, 'the settings value wins over the patch');
  });
});

describe('/zcode-import handler (FR-7.1)', () => {
  /** Invoke the command directly, with a memory-backed persistence service. */
  async function invoke(rawInput, extra = {}) {
    const sink = createMemorySink();
    const result = await runCommand({
      config: normalizeConfig({
        source: fixtureInfo.dir,
        stateDir: `::tmp::${fixtureInfo.stateDir}`.replace('::tmp::', ''),
        report: false,
      }),
      rawInput,
      deps: { persistence: sink, workspaceRegistry: extra.workspaceRegistry },
    });
    return { result, sink };
  }

  it('prints usage only when asked, and treats a bare command as "sync now"', async () => {
    const help = await invoke('help');
    assert.equal(help.result.kind, 'success');
    assert.match(help.result.text, /用法：\/zcode-import/);
    assert.match(help.result.text, /不带参数 = 直接同步/);

    const unknown = await invoke('frobnicate');
    assert.equal(unknown.result.kind, 'error');
    assert.match(unknown.result.text, /未知子命令/);

    // The whole point of the bare form: one command with no vocabulary.
    const bare = await invoke('');
    assert.equal(bare.result.kind, 'success');
    assert.match(bare.result.text, /迁移完成：新建 1/);
    assert.equal(bare.sink.sessions.size, 1);
  });

  it('accepts the sync aliases', async () => {
    for (const verb of ['all', 'sync', 'update', 'run']) {
      const { result, sink } = await invoke(verb);
      assert.equal(result.kind, 'success', `${verb} should sync`);
      assert.equal(sink.sessions.size, 1, `${verb} should import the pending session`);
    }
  });

  it('says when there is nothing to do, and mentions auto-sync', async () => {
    const sink = createMemorySink();
    const config = normalizeConfig({ source: fixtureInfo.dir, stateDir: fixtureInfo.stateDir, report: false });
    await runCommand({ config, rawInput: '', deps: { persistence: sink } });
    const again = await runCommand({ config, rawInput: '', deps: { persistence: sink } });
    assert.equal(again.kind, 'success');
    assert.match(again.text, /已是最新/);
    assert.match(again.text, /自动同步已开启/);
  });

  it('scans and lists the source sessions', async () => {
    // Its own state directory: "not imported yet" is a property of a fresh
    // state, and the other tests in this file share theirs.
    const fresh = join(fixtureInfo.home, `state-scan-${Date.now()}`);
    const result = await runCommand({
      config: normalizeConfig({ source: fixtureInfo.dir, stateDir: fresh, report: false }),
      rawInput: 'scan',
      deps: {},
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /ZCode 数据源：sqlite/);
    assert.ok(result.text.includes(fixtureInfo.sessionId));
    assert.match(result.text, /未导入/);
    assert.match(result.text, /直接同步全部/, 'the hint teaches the one-command form');
  });

  it('imports every pending session and reports what it did', async () => {
    const { result, sink } = await invoke('all');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /新建 1/);
    assert.match(result.text, /思路：3 段/);
    assert.equal(sink.sessions.size, 1);
  });

  it('imports a single session by id fragment', async () => {
    const fragment = fixtureInfo.sessionId.slice(-12);
    const { result, sink } = await invoke(`import ${fragment}`);
    assert.equal(result.kind, 'success');
    assert.equal(sink.sessions.size, 1);
  });

  it('explains an unknown id instead of failing silently', async () => {
    const { result } = await invoke('import sess_does-not-exist');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /找不到源会话/);
    assert.match(result.text, /scan/);
  });

  it('recognises an already-imported session even with an empty registry, because the log is the authority', async () => {
    const first = await invoke('all');
    assert.equal(first.result.kind, 'success');
    assert.match(first.result.text, /新建 1/);

    // A different state directory means an empty registry, but the session is
    // already in persistence: it must be recognised as current rather than
    // duplicated (FR-6.1).
    const again = await runCommand({
      config: normalizeConfig({ source: fixtureInfo.dir, stateDir: join(fixtureInfo.home, 'state2'), report: false }),
      rawInput: 'all',
      deps: { persistence: first.sink },
    });
    assert.equal(again.kind, 'success');
    assert.match(again.text, /跳过 1/);
    assert.match(again.text, /新建 0/);
    assert.equal(first.sink.sessions.size, 1, 'no duplicate session was created');
  });

  it('reports the persistence service as missing rather than writing nowhere', async () => {
    const result = await runCommand({
      config: normalizeConfig({ source: fixtureInfo.dir, stateDir: fixtureInfo.stateDir, report: false }),
      rawInput: 'all',
      deps: {},
    });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /sessionPersistence 服务不可用/);
  });

  it('summarizes registry state for status', async () => {
    const { result } = await invoke('status');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /已迁移会话：/);
    assert.match(result.text, /源侧会话：1 个/);
  });
});

describe('sink construction', () => {
  it('warns when the backend cannot write, since nothing else can substitute', async () => {
    const warn = new WarningLog();
    const { createPersistenceSink } = await import('../src/target/session-sink.js');
    const sink = createPersistenceSink({ create: async () => {} }, { warn });
    assert.equal(sink.kind, 'sessionPersistence');
    assert.equal(warn.items[0].code, 'persistence-incomplete');
    assert.equal(warn.items[0].severity, 'error');
  });

  it('tolerates a backend without inspect by falling back to load', async () => {
    const warn = new WarningLog();
    const { createPersistenceSink } = await import('../src/target/session-sink.js');
    const events = [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }];
    const sink = createPersistenceSink(
      {
        create: async () => {},
        append: async () => {},
        load: async () => ({ meta: { id: 'session-x' }, events }),
      },
      { warn },
    );
    const view = await sink.inspect('session-x');
    assert.deepEqual(view.events, events);
    assert.equal(warn.length, 0, 'a missing inspect is a compatibility case, not a warning');
  });

  it('treats a missing session as absent, not as a failure', async () => {
    const warn = new WarningLog();
    const { createPersistenceSink } = await import('../src/target/session-sink.js');
    const sink = createPersistenceSink(
      {
        create: async () => {},
        append: async () => {},
        inspect: async () => {
          throw new Error('no session with that id');
        },
      },
      { warn },
    );
    assert.equal(await sink.inspect('session-x'), undefined);
    assert.equal(warn.items.filter((item) => item.code === 'persistence-inspect-failed').length, 0);
  });

  it('surfaces a real read fault as a warning', async () => {
    const warn = new WarningLog();
    const { createPersistenceSink } = await import('../src/target/session-sink.js');
    const sink = createPersistenceSink(
      {
        create: async () => {},
        append: async () => {},
        inspect: async () => {
          throw new Error('disk on fire');
        },
      },
      { warn },
    );
    assert.equal(await sink.inspect('session-x'), undefined);
    assert.equal(warn.items.filter((item) => item.code === 'persistence-inspect-failed').length, 1);
  });
});
