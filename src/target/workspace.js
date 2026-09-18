/**
 * Workspace mounting (FR-4.5), with graceful degradation (FR-8.2).
 *
 * A migrated session shows up in the sidebar under the workspace whose path
 * equals the session header's `cwd` — DSH derives that membership from the
 * header, so the header must be right *and* the directory must exist. Two
 * official calls do the rest:
 *
 * 1. `workspaceRegistry.create(path)` — idempotent; creates the record when the
 *    directory is not owned yet (DSH titles it `basename(path)`, like every
 *    other auto-created workspace), and returns the existing one otherwise.
 * 2. `workspace.attachSession(sessionId)` — records membership after validating
 *    that the stored header's cwd resolves to that exact directory.
 *
 * Everything here is optional: when `workspaceRegistry` is unavailable, or the
 * directory is gone and `createMissingDirs` is off, the session still imports
 * and stays resumable — it just is not grouped in the sidebar, and the report
 * says why.
 *
 * @module dsh-zcode-migrate/target/workspace
 */

import { mkdirSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { SEVERITY } from '../core/warnings.js';

/**
 * @typedef {object} MountResult
 * @property {'attached'|'already'|'skipped'|'failed'} status
 * @property {string} [workspaceId]
 * @property {string} [path] - canonical directory the workspace owns.
 * @property {string} [reason]
 */

/**
 * Ensure `cwd` names a real directory, optionally creating it.
 * @param {string} cwd - the source session's workspace path.
 * @param {boolean} createMissingDirs - whether to create a missing directory.
 * @returns {{ ok: true, path: string, created: boolean } | { ok: false, reason: string, message: string }} outcome.
 */
function ensureDirectory(cwd, createMissingDirs) {
  try {
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      return { ok: false, reason: 'not-a-directory', message: `源会话的工作区路径不是目录：${cwd}` };
    }
    return { ok: true, path: realpathSync(cwd), created: false };
  } catch (error) {
    if (!createMissingDirs) {
      return {
        ok: false,
        reason: 'missing-directory',
        message: `源会话的工作区目录不存在：${cwd}（该会话仍可导入与续聊，但不会出现在侧边栏分组中；可开启 createMissingDirs 或在 DSH 中先打开该目录）`,
      };
    }
    try {
      mkdirSync(cwd, { recursive: true });
      return { ok: true, path: realpathSync(cwd), created: true };
    } catch (createError) {
      return {
        ok: false,
        reason: 'mkdir-failed',
        message: `无法创建工作区目录 ${cwd}：${/** @type {Error} */ (createError).message}`,
      };
    }
  }
}

/**
 * Attach a migrated session to its source workspace.
 *
 * @param {object} options - `{ registry, sessionId, cwd, createMissingDirs, warn }`.
 * @returns {Promise<MountResult>} what happened, for the report.
 */
export async function mountWorkspace(options) {
  const { registry, sessionId, cwd, createMissingDirs = false, warn } = options;

  if (typeof cwd !== 'string' || cwd === '') {
    warn?.add('workspace-no-cwd', '源会话没有工作区路径，无法挂载到侧边栏分组', {
      sessionId,
      severity: SEVERITY.info,
    });
    return { status: 'skipped', reason: 'no-cwd' };
  }

  if (registry === undefined || registry === null || typeof registry.create !== 'function') {
    // FR-8.2: the workspace service is optional; the import already succeeded.
    warn?.add('workspace-service-absent', '工作区服务不可用，已跳过挂载（会话本身已导入）', {
      sessionId,
      severity: SEVERITY.info,
    });
    return { status: 'skipped', reason: 'no-workspace-service' };
  }

  const dir = ensureDirectory(cwd, createMissingDirs);
  if (!dir.ok) {
    warn?.add('workspace-unresolved', dir.message, {
      sessionId,
      severity: SEVERITY.warning,
      detail: { reason: dir.reason, cwd },
    });
    return { status: 'skipped', reason: dir.reason };
  }

  try {
    // No title is passed on purpose: DSH defaults a new workspace's title to
    // `basename(path)`, which is what every other auto-created workspace is
    // called. Passing the session title here (as an earlier version did) names
    // the workspace after whichever session happened to be imported first:
    // `D:\projects\demo` would show up as a session title instead of "demo".
    const workspace = await registry.create(dir.path);
    const before = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0;
    const already = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
    if (!already) await workspace.attachSession(sessionId);
    if (dir.created) {
      warn?.add('workspace-created-directory', `已为源会话创建工作区目录：${dir.path}`, {
        sessionId,
        severity: SEVERITY.info,
      });
    }
    return {
      status: already ? 'already' : 'attached',
      workspaceId: String(workspace.id ?? ''),
      path: dir.path,
      ...(before === 0 ? {} : {}),
    };
  } catch (error) {
    warn?.add(
      'workspace-attach-failed',
      `挂载工作区失败（会话本身已导入并可续聊）：${/** @type {Error} */ (error).message}`,
      { sessionId, severity: SEVERITY.warning, detail: { cwd: dir.path } },
    );
    return { status: 'failed', reason: 'attach-failed', path: dir.path };
  }
}
