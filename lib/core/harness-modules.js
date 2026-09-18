/**
 * Locate the harness's own packages from inside this plugin.
 *
 * Needed because a plugin installed as a pnpm `file:` dependency is a **symlink**
 * into the profile's `node_modules`, and Node resolves bare specifiers from a
 * module's *real* path — so `import '@deepseek-ai/schemastery'` inside this
 * package looks beside the plugin's source directory, not beside the profile
 * that loaded it, and fails.
 *
 * That failure is silent by design (the plugin treats the schema library as
 * optional so it keeps working outside a harness), which makes it exactly the
 * kind of thing that would go unnoticed: the settings page would simply never
 * appear. So the lookup is explicit and ordered:
 *
 * 1. an ordinary resolution — correct when the plugin is installed normally or
 *    hoisted beside the harness packages;
 * 2. `$DSH_MODULES`, an escape hatch for unusual deployments;
 * 3. the standard profile locations under the resolved DSH home.
 *
 * @module dsh-zcode-migrate/core/harness-modules
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshHome } from './config.js';

/**
 * Directories that may hold `@deepseek-ai/*`, in resolution order.
 *
 * Each entry is either the `@deepseek-ai` folder itself or a `node_modules`
 * directory containing it; {@link packageCandidates} accepts both.
 *
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {string[]} candidate directories.
 */
export function moduleCandidates(env = process.env) {
  /** @type {string[]} */
  const candidates = [];
  if (typeof env.DSH_MODULES === 'string' && env.DSH_MODULES.trim() !== '') {
    candidates.push(env.DSH_MODULES.trim());
  }
  try {
    const require = createRequire(import.meta.url);
    candidates.push(dirname(require.resolve('@deepseek-ai/dsh-session/package.json')));
  } catch {
    /* not resolvable from here; the profile locations below are next */
  }
  const dshHome = resolveDshHome(undefined, env);
  const profiles = join(dshHome, 'profiles');
  candidates.push(join(profiles, 'node_modules'));
  for (const profile of ['web', 'headless']) {
    candidates.push(join(profiles, profile, 'node_modules'));
  }
  return candidates;
}

/**
 * Every filesystem location a single package could occupy, most specific first.
 *
 * @param {string} packageName - e.g. `dsh-session`.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {string[]} candidate package directories.
 */
export function packageCandidates(packageName, env = process.env) {
  /** @type {string[]} */
  const out = [];
  for (const base of moduleCandidates(env)) {
    // `base` may be the @deepseek-ai folder (the npx profile layout) or a
    // node_modules directory that contains it.
    out.push(join(base, '@deepseek-ai', packageName));
    out.push(join(base, packageName));
  }
  return [...new Set(out)];
}

/**
 * Resolve a package's entry points into real files.
 *
 * Reads `exports['.']`, then `main`, then falls back to the default file. The
 * order matters: these packages are not consistent — `dsh-session` uses
 * `lib/index.js` while `schemastery` declares `lib/index.cjs` for `require` and
 * `lib/index.mjs` for `import` — and guessing one layout would silently make a
 * package "not found" (which, for this plugin, means the settings page quietly
 * never appears).
 *
 * @param {string} packageDir - package root.
 * @returns {string[]} candidate entry files, most preferred first.
 */
function entryCandidates(packageDir) {
  /** @type {string[]} */
  const out = [];
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const root = manifest.exports?.['.'];
    const fromExports = [
      typeof root === 'string' ? root : undefined,
      root?.import,
      root?.default,
      root?.require,
    ];
    for (const candidate of fromExports) {
      if (typeof candidate === 'string') out.push(join(packageDir, candidate));
    }
    if (typeof manifest.module === 'string') out.push(join(packageDir, manifest.module));
    if (typeof manifest.main === 'string') out.push(join(packageDir, manifest.main));
  } catch {
    /* no readable manifest: the defaults below still cover the common layout */
  }
  out.push(join(packageDir, 'lib', 'index.js'), join(packageDir, 'index.js'));
  return [...new Set(out)];
}

/**
 * Resolve a package's entry file, without loading it.
 *
 * @param {string} packageName - package name (e.g. `dsh-session`).
 * @param {string} [entry] - explicit entry file, overriding manifest resolution.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {string|undefined} the first existing entry path.
 */
export function findHarnessEntry(packageName, entry, env = process.env) {
  for (const candidate of packageCandidates(packageName, env)) {
    const files = entry === undefined ? entryCandidates(candidate) : [join(candidate, entry)];
    for (const file of files) {
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

/**
 * Import one harness package, from wherever it lives.
 *
 * @param {string} packageName - package name.
 * @param {string} [entry] - explicit entry file.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {Promise<any>} the loaded module namespace.
 * @throws when the package cannot be found anywhere.
 */
export async function importHarnessModule(packageName, entry, env = process.env) {
  const file = findHarnessEntry(packageName, entry, env);
  if (file === undefined) {
    throw new Error(
      `找不到 DSH 运行时包 ${packageName}；已查找：\n${packageCandidates(packageName, env).join('\n')}`,
    );
  }
  return import(pathToFileURL(file).href);
}

/**
 * Whether a usable DSH install is reachable.
 * @param {Record<string, string|undefined>} [env] - environment.
 * @returns {boolean} true when the core session package resolves.
 */
export function dshRuntimeAvailable(env = process.env) {
  return findHarnessEntry('dsh-session', undefined, env) !== undefined;
}
