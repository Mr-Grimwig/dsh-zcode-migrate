/**
 * `dsh-zcode-migrate` — the cordis plugin entry point.
 *
 * Load it from a dsh profile patch (see `cordis.patch.yml`) or as a `--patch`
 * overlay, then run `/zcode-import scan` in the UI.
 *
 * ## Load-time behaviour
 *
 * Nothing is read or written when the plugin loads: the source home is resolved
 * and logged, the command surface is registered, and the settings namespace is
 * declared so the knobs show up in a configuration UI. Migration itself only
 * ever runs from an explicit user action (FR-7.1), which keeps a plugin load
 * free of surprises — no scan, no writes, no network.
 *
 * ## Optional services (FR-8.2)
 *
 * Every service is resolved at use time through `ctx.get(...)` rather than
 * declared as a hard `inject`. A harness build without `commands` loses the
 * slash command; one without `settings` loses the settings page; one without
 * `workspaceRegistry` loses sidebar grouping. None of them can stop the import
 * itself, which needs only `sessionPersistence`.
 *
 * @module dsh-zcode-migrate
 */

import { DEFAULT_CONFIG, normalizeConfig } from './core/config.js';
import { importHarnessModule } from './core/harness-modules.js';
import { scheduleAutoImport } from './auto-import.js';
import { registerSurfaces } from './commands.js';

/** Cordis plugin name. */
export const name = 'zcode-migrate';

/**
 * No hard dependencies on purpose: the import must keep working in a build that
 * lacks the optional services (FR-8.2).
 */
export const inject = [];

/**
 * Loader schema, when the harness's schema library is importable.
 *
 * The import is resolved through {@link importHarnessModule} rather than as a
 * bare specifier, because a profile installs this package as a symlink and Node
 * would then look for the schema library beside the plugin's *real* directory
 * instead of beside the profile that loaded it (see `core/harness-modules`).
 *
 * It stays optional either way: this module is also loaded outside a harness (by
 * the standalone CLI and by tests), and config normalization in {@link apply} is
 * total, so an absent schema changes validation, never behaviour.
 */
export const Config = await (async () => {
  try {
    const schemaModule = await importHarnessModule('schemastery');
    const z = schemaModule.default ?? schemaModule;
    return z.object({
      source: z.string(),
      sourceMode: z.union(['auto', 'db', 'rollout']),
      legacy: z.boolean(),
      createMissingDirs: z.boolean(),
      autoImport: z.union(['off', 'pending']),
      stateDir: z.string(),
      maxSessions: z.natural(),
      report: z.boolean(),
    });
  } catch {
    return undefined;
  }
})();

/**
 * Whether the settings provider is available and usable.
 * @param {object} ctx - cordis context.
 * @returns {object|undefined} the settings service.
 */
function settingsService(ctx) {
  const settings = ctx.get?.('settings');
  return settings !== undefined && typeof settings.register === 'function' ? settings : undefined;
}

/**
 * Install the command surface, the settings namespace, and the config resolver.
 *
 * Separated from {@link apply} so the wiring can be tested with explicit
 * dependencies — a fake command runtime and settings provider — instead of a
 * whole harness. `apply` supplies exactly the same things after probing the real
 * context.
 *
 * @param {object} ctx - cordis context (only `get`, `logger`, and `effect` are used).
 * @param {object} deps - `{ initial, schema, logger }`.
 * @returns {{ getConfig: () => object, dispose: () => void, registered: string[], settingsRegistered: boolean }} installed state.
 */
export function installSurfaces(ctx, deps) {
  const { initial, schema, logger } = deps;

  /**
   * Live settings scope, when the settings provider accepted the namespace.
   * @type {{ get?: () => object }|undefined}
   */
  let scope;

  const settings = settingsService(ctx);
  if (settings !== undefined && schema !== undefined) {
    try {
      scope = settings.register('zcode-migrate', schema, {
        base: initial,
        applies: 'live',
      });
    } catch (error) {
      logger?.debug?.(`[zcode-migrate] settings 注册失败，已改用 patch 配置：${/** @type {Error} */ (error).message}`);
      scope = undefined;
    }
  }

  /**
   * Effective configuration: patch config overlaid with live settings, so a
   * change in the settings UI takes effect on the next command without a
   * harness restart (FR-7.2).
   * @returns {object} normalized config.
   */
  const getConfig = () => {
    let live;
    try {
      live = scope?.get?.();
    } catch {
      live = undefined;
    }
    return normalizeConfig(live === undefined ? initial : { ...initial, ...live });
  };

  const surfaces = registerSurfaces(ctx, { getConfig, log: logger });
  return {
    getConfig,
    registered: surfaces.registered,
    settingsRegistered: scope !== undefined,
    dispose: () => surfaces.dispose(),
  };
}

/**
 * Install the plugin.
 *
 * @param {object} ctx - cordis context.
 * @param {Partial<typeof DEFAULT_CONFIG>} [rawConfig] - loader configuration.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const initial = normalizeConfig(rawConfig);
  const logger = ctx.logger ?? ctx.get?.('logger');
  const installed = installSurfaces(ctx, { initial, schema: Config, logger });

  // Boot-time top-up (`autoImport: 'pending'` by default). It is scheduled
  // rather than awaited: a migration must never delay the harness coming up,
  // and its outcome is reported through the logger and the run report.
  const auto = scheduleAutoImport(ctx, { getConfig: installed.getConfig, logger });

  logger?.info?.(
    `[zcode-migrate] 已就绪：ZCode 数据源 ${installed.getConfig().zcodeHome}（来自 ${initial.zcodeHomeOrigin}）` +
      `${installed.registered.length > 0 ? `，命令 ${installed.registered.join('、')}` : ''}` +
      `${installed.settingsRegistered ? '，设置项 /zcode-migrate' : ''}` +
      `${auto.scheduled ? '，启动时自动补齐已开启' : ''}`,
  );

  ctx.effect?.(() => () => installed.dispose(), 'zcode-migrate.dispose');
}

export default { name, inject, apply, Config };
