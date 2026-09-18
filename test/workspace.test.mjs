/**
 * Workspace mounting (FR-4.5) and its interaction with the harness's own
 * workspace registry.
 *
 * The naming contract is the point of this file: a migrated session must land in
 * a workspace called `basename(directory)` — the name DSH gives every other
 * auto-created workspace — and not the title of whichever session happened to be
 * imported first. Getting that wrong is invisible in a log and obvious only in
 * the sidebar, which is exactly the kind of bug a unit test should be holding
 * down.
 *
 * The registry is faked with the two calls the mount actually makes (`create`
 * with an optional title, and `attachSession`), plus enough of the entity to
 * read membership back.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';

import { WarningLog } from '../src/core/warnings.js';
import { mountWorkspace } from '../src/target/workspace.js';

/**
 * A workspace registry stand-in that mirrors DSH's own defaults.
 *
 * `create(path, title?)` titles a new record `title ?? basename(path)`, and
 * `attachSession` records membership — the two behaviours the mount relies on.
 */
function fakeRegistry(options = {}) {
  /** @type {Map<string, object>} */
  const workspaces = new Map();
  const calls = [];
  return {
    workspaces,
    calls,
    async create(path, title) {
      calls.push({ path, title });
      const existing = workspaces.get(path);
      if (existing !== undefined) return existing;
      if (options.failCreate === true) throw new Error('registry unavailable');
      const entity = {
        id: `ws-${workspaces.size + 1}`,
        path,
        title: title ?? basename(path),
        sessionIds: [],
        async attachSession(sessionId) {
          if (options.failAttach === true) throw new Error('cwd does not resolve');
          if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId);
        },
      };
      workspaces.set(path, entity);
      return entity;
    },
  };
}

describe('workspace mounting (FR-4.5)', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let cwd;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'zcm-ws-'));
    cwd = join(root, 'proj');
    mkdirSync(cwd, { recursive: true });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names a new workspace after the directory, not after the session', async () => {
    const registry = fakeRegistry();
    const warn = new WarningLog();
    const result = await mountWorkspace({
      registry,
      sessionId: 'session-1111',
      cwd,
      title: '编写 dsh-zcode-migrate 需求说明书',
      warn,
    });

    assert.equal(result.status, 'attached');
    assert.equal(registry.calls.length, 1);
    assert.equal(registry.calls[0].title, undefined, 'no title may be passed: the harness defaults to basename(path)');
    const workspace = [...registry.workspaces.values()][0];
    assert.equal(workspace.title, basename(cwd));
    assert.deepEqual(workspace.sessionIds, ['session-1111']);
  });

  it('is idempotent: an already-attached session is not re-attached', async () => {
    const registry = fakeRegistry();
    const warn = new WarningLog();
    const first = await mountWorkspace({ registry, sessionId: 'session-2222', cwd, warn });
    const second = await mountWorkspace({ registry, sessionId: 'session-2222', cwd, warn });
    assert.equal(first.status, 'attached');
    assert.equal(second.status, 'already');
    assert.deepEqual([...registry.workspaces.values()][0].sessionIds, ['session-2222']);
  });

  it('skips a session whose directory is gone, and says why', async () => {
    const registry = fakeRegistry();
    const warn = new WarningLog();
    const missing = join(root, 'gone');
    const result = await mountWorkspace({ registry, sessionId: 'session-3333', cwd: missing, warn });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'missing-directory');
    assert.equal(registry.calls.length, 0, 'no workspace is created for a path that does not exist');
    const warning = warn.items.find((item) => item.code === 'workspace-unresolved');
    assert.ok(warning, 'the skip must be reported');
    assert.match(warning.message, /仍可导入与续聊/, 'the message must say the session itself is fine');
  });

  it('creates the directory when asked to', async () => {
    const registry = fakeRegistry();
    const warn = new WarningLog();
    const missing = join(root, 'created-on-demand');
    const result = await mountWorkspace({
      registry,
      sessionId: 'session-4444',
      cwd: missing,
      createMissingDirs: true,
      warn,
    });
    assert.equal(result.status, 'attached');
    assert.equal(result.path, missing);
    assert.equal(registry.workspaces.get(missing).title, 'created-on-demand');
    assert.ok(warn.items.some((item) => item.code === 'workspace-created-directory'));
  });

  it('skips silently-but-reportedly when the harness has no workspace service (FR-8.2)', async () => {
    const warn = new WarningLog();
    const result = await mountWorkspace({ registry: undefined, sessionId: 'session-5555', cwd, warn });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-workspace-service');
    assert.ok(warn.items.some((item) => item.code === 'workspace-service-absent'));
  });

  it('degrades to a warning when the registry rejects the attach', async () => {
    const registry = fakeRegistry({ failAttach: true });
    const warn = new WarningLog();
    const result = await mountWorkspace({ registry, sessionId: 'session-6666', cwd, warn });
    assert.equal(result.status, 'failed');
    const warning = warn.items.find((item) => item.code === 'workspace-attach-failed');
    assert.ok(warning);
    assert.match(warning.message, /会话本身已导入/, 'the import is not blamed for an optional-service failure');
  });

  it('reports a session with no cwd instead of inventing a workspace', async () => {
    const registry = fakeRegistry();
    const warn = new WarningLog();
    const result = await mountWorkspace({ registry, sessionId: 'session-7777', cwd: '', warn });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-cwd');
    assert.ok(warn.items.some((item) => item.code === 'workspace-no-cwd'));
  });

  it('uses the canonical directory so a second spelling of the same path joins it', async () => {
    const registry = fakeRegistry();
    const warn = new WarningLog();
    mkdirSync(join(root, 'canon'), { recursive: true });
    writeFileSync(join(root, 'canon', '.keep'), '');
    await mountWorkspace({ registry, sessionId: 'session-8888', cwd: join(root, 'canon'), warn });
    await mountWorkspace({ registry, sessionId: 'session-9999', cwd: join(root, 'canon', '.', ''), warn });
    assert.equal(registry.workspaces.size, 1);
    assert.deepEqual(
      [...registry.workspaces.values()][0].sessionIds.sort(),
      ['session-8888', 'session-9999'],
    );
  });
});
