/**
 * Harness package resolution.
 *
 * The failure this guards against is invisible: a plugin installed as a pnpm
 * `file:` dependency is a symlink, Node resolves bare specifiers from the
 * module's real path, and the settings library then simply "is not found" — the
 * plugin keeps working and the settings page never appears. So the lookup is
 * tested against a synthetic install with the layouts the real packages
 * actually use (an `exports` map pointing at `.mjs`, and a plain `main`).
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  dshRuntimeAvailable,
  findHarnessEntry,
  importHarnessModule,
  moduleCandidates,
  packageCandidates,
} from '../src/core/harness-modules.js';

/**
 * Build a fake DSH install with the two entry layouts that matter.
 * @returns {{ home: string, cleanup: () => void, env: object }} fixture.
 */
function fakeInstall() {
  const home = mkdtempSync(join(tmpdir(), 'zcm-harness-'));
  const ai = join(home, 'profiles', 'node_modules', '@deepseek-ai');

  // Layout A: an exports map whose import entry is .mjs (schemastery's shape).
  mkdirSync(join(ai, 'schemastery', 'lib'), { recursive: true });
  writeFileSync(
    join(ai, 'schemastery', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', exports: { '.': { import: './lib/index.mjs', require: './lib/index.cjs' } } }),
    'utf8',
  );
  writeFileSync(join(ai, 'schemastery', 'lib', 'index.mjs'), 'export default { marker: "esm" };\n', 'utf8');
  writeFileSync(join(ai, 'schemastery', 'lib', 'index.cjs'), 'module.exports = { marker: "cjs" };\n', 'utf8');

  // Layout B: a plain lib/index.js (dsh-session's shape).
  mkdirSync(join(ai, 'dsh-session', 'lib'), { recursive: true });
  writeFileSync(join(ai, 'dsh-session', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', main: 'lib/index.js' }), 'utf8');
  writeFileSync(join(ai, 'dsh-session', 'lib', 'index.js'), 'export const marker = "cjs-style";\n', 'utf8');

  return { home, env: { DSH_MODULES: ai }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('harness package resolution', () => {
  it('finds a package through an exports map and through main', async () => {
    const fixture = fakeInstall();
    try {
      const esm = findHarnessEntry('schemastery', undefined, fixture.env);
      assert.match(esm, /lib[\\/]index\.mjs$/, 'the import condition wins, not a hard-coded lib/index.js');

      const cjs = findHarnessEntry('dsh-session', undefined, fixture.env);
      assert.match(cjs, /lib[\\/]index\.js$/);

      assert.equal(dshRuntimeAvailable(fixture.env), true);
      assert.equal(findHarnessEntry('dsh-definitely-not-installed', undefined, fixture.env), undefined);
    } finally {
      fixture.cleanup();
    }
  });

  it('imports the resolved module', async () => {
    const fixture = fakeInstall();
    try {
      const module = await importHarnessModule('schemastery', undefined, fixture.env);
      assert.equal((module.default ?? module).marker, 'esm');
    } finally {
      fixture.cleanup();
    }
  });

  it('reports every location it looked in when a package is missing', async () => {
    const fixture = fakeInstall();
    try {
      await assert.rejects(
        () => importHarnessModule('dsh-not-here', undefined, fixture.env),
        (error) => {
          assert.match(error.message, /找不到 DSH 运行时包 dsh-not-here/);
          assert.match(error.message, /@deepseek-ai[\\/]dsh-not-here/, 'the searched paths are listed');
          return true;
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts both the @deepseek-ai folder and its parent as a search root', () => {
    const aiFolder = join('D:', 'somewhere', 'node_modules', '@deepseek-ai');
    const candidates = packageCandidates('dsh-session', { DSH_MODULES: aiFolder });
    assert.ok(candidates.includes(join(aiFolder, 'dsh-session')));
    assert.ok(candidates.includes(join(aiFolder, '@deepseek-ai', 'dsh-session')));

    const parent = join('D:', 'somewhere', 'node_modules');
    const fromParent = packageCandidates('dsh-session', { DSH_MODULES: parent });
    assert.ok(fromParent.includes(join(parent, '@deepseek-ai', 'dsh-session')));
  });

  it('always includes the standard profile locations for a DSH home', () => {
    const candidates = moduleCandidates({ DSH_HOME: join('D:', 'dshhome') });
    assert.ok(candidates.some((candidate) => candidate.endsWith(join('profiles', 'node_modules'))));
    assert.ok(candidates.some((candidate) => candidate.includes(join('profiles', 'web', 'node_modules'))));
    assert.ok(candidates.some((candidate) => candidate.includes(join('profiles', 'headless', 'node_modules'))));
  });

  it('finds the real install on this machine, when there is one', (t) => {
    if (!dshRuntimeAvailable()) {
      t.skip('本机没有 DSH 安装');
      return;
    }
    for (const pkg of ['schemastery', 'dsh-session', 'cordis']) {
      assert.ok(findHarnessEntry(pkg) !== undefined, `${pkg} should resolve`);
    }
  });
});
