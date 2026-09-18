/**
 * Boot the harness's own session storage in a plain Node process.
 *
 * The CLI and the integration tests need to write sessions exactly the way the
 * harness does, without starting a UI. That turns out to need only two plugins,
 * loaded in dependency order:
 *
 * 1. `@deepseek-ai/dsh-session` — provides the `sessions` store;
 * 2. `@deepseek-ai/dsh-session-persistence-jsonl` — provides
 *    `sessionPersistence` and owns the on-disk format (multi-frame zstd,
 *    header validation, contiguous-seq enforcement, crash repair).
 *
 * Because this drives the *real* backend, an artifact produced here is byte-for-
 * byte the kind of artifact the harness produces, which is what makes the
 * fidelity claims in the tests meaningful.
 *
 * Resolution of `@deepseek-ai/*` is delegated to
 * `src/core/harness-modules.js`, which knows the symlinked-profile case.
 *
 * @module dsh-zcode-migrate/scripts/jsonl-backend
 */

import { join } from 'node:path';
import { importHarnessModule } from '../src/core/harness-modules.js';
import { resolveDshHome } from '../src/core/config.js';
import { createPersistenceSink } from '../src/target/session-sink.js';

/**
 * Boot a DSH session store backed by the real JSONL persistence plugin.
 *
 * @param {object} options - `{ root, warn, packChunks }`.
 * @returns {Promise<{ sink: object, persistence: object, close: () => Promise<void>, root: string }>} backend handle.
 */
export async function openJsonlBackend(options) {
  const { root, warn } = options;
  const [sessionModule, jsonlModule, cordisModule] = await Promise.all([
    importHarnessModule('dsh-session'),
    importHarnessModule('dsh-session-persistence-jsonl'),
    importHarnessModule('cordis'),
  ]);

  const ctx = new cordisModule.Context();
  // Dependency order matters: the JSONL backend injects `sessions`.
  await ctx.plugin(sessionModule.default ?? sessionModule.SessionStore);
  await ctx.plugin(jsonlModule.default ?? jsonlModule.JsonlSessionPersistence, {
    root,
    packChunks: options.packChunks ?? false,
  });

  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) throw new Error('sessionPersistence 未注册：JSONL 后端加载失败');

  return {
    root,
    persistence,
    sink: createPersistenceSink(persistence, { warn }),
    close: async () => {
      try {
        await ctx.stop?.();
      } catch {
        /* nothing useful to do while tearing a scratch harness down */
      }
    },
  };
}

/** Whether a DSH install is reachable. Re-exported from the shared resolver. */
export { dshRuntimeAvailable } from '../src/core/harness-modules.js';

/** Default sessions root for a DSH home, for callers that do not pass one. */
export function defaultSessionsRoot() {
  return join(resolveDshHome(undefined, process.env), 'sessions');
}

/** Default DSH home, re-exported for diagnostics. */
export const dshHome = resolveDshHome(undefined, process.env);
