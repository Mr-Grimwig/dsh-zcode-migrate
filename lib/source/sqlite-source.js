/**
 * Primary source reader: ZCode's SQLite store (FR-1.2).
 *
 * `cli/db/db.sqlite` is opened **read-only**, with a busy timeout, so an import
 * runs safely while ZCode itself is running (FR-8.1). Nothing in this module
 * writes to the source, and every failure is reported through the shared warning
 * log instead of throwing (FR-1.5).
 *
 * Schema drift is handled at the SQL level: the available columns of `message`
 * and `part` are probed once, and the ordering/selection clauses are built from
 * what actually exists (NFR-4). A renamed column degrades to a warning, not to a
 * crash.
 *
 * @module dsh-zcode-migrate/source/sqlite-source
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMessage, normalizePart } from './model.js';

/** Default location of the SQLite store inside a ZCode home. */
export const DB_RELATIVE_PATH = join('cli', 'db', 'db.sqlite');

/** Tables this reader needs, with the columns it can live without. */
const REQUIRED_TABLES = ['session', 'message', 'part'];

/**
 * Absolute path of the SQLite store for a ZCode home.
 * @param {string} zcodeHome - resolved ZCode home.
 * @returns {string} candidate database path.
 */
export function databasePath(zcodeHome) {
  return join(zcodeHome, DB_RELATIVE_PATH);
}

/**
 * Whether a usable SQLite store exists at this ZCode home.
 * @param {string} zcodeHome - resolved ZCode home.
 * @returns {{ present: boolean, path: string, size: number }} presence facts.
 */
export function databasePresence(zcodeHome) {
  const path = databasePath(zcodeHome);
  if (!existsSync(path)) return { present: false, path, size: 0 };
  try {
    return { present: true, path, size: statSync(path).size };
  } catch {
    return { present: false, path, size: 0 };
  }
}

/**
 * Read a table's column names.
 * @param {DatabaseSync} db - open database.
 * @param {string} table - table name (from {@link REQUIRED_TABLES} only).
 * @returns {Set<string>} column names.
 */
function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * Build an ORDER BY clause from the columns a table actually has.
 *
 * `sequence` is the authoritative order when present (per-session for messages,
 * per-message for parts); `time_created` and the primary key are tie-breakers
 * that keep the order total even on a partially-written row.
 *
 * @param {Set<string>} columns - available columns.
 * @returns {string} SQL ORDER BY clause body.
 */
function orderClause(columns) {
  const terms = [];
  if (columns.has('sequence')) terms.push('COALESCE(sequence, 0)');
  if (columns.has('time_created')) terms.push('COALESCE(time_created, 0)');
  terms.push('id');
  return terms.join(', ');
}

/**
 * Open the ZCode SQLite store read-only.
 *
 * @param {string} zcodeHome - resolved ZCode home.
 * @param {object} [options] - `{ warn, busyTimeoutMs }`.
 * @returns {{ ok: true, db: DatabaseSync, columns: { message: Set<string>, part: Set<string> }, path: string, close: () => void }
 *   | { ok: false, reason: string, path: string }} reader handle, or why it failed.
 */
export function openZcodeDatabase(zcodeHome, options = {}) {
  const warn = options.warn;
  const path = databasePath(zcodeHome);
  const presence = databasePresence(zcodeHome);
  if (!presence.present) return { ok: false, reason: 'database-missing', path };

  /** @type {DatabaseSync|undefined} */
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    warn?.add('db-open-failed', `无法只读打开 ZCode 数据库：${/** @type {Error} */ (error).message}`, {
      where: path,
      severity: 'error',
    });
    return { ok: false, reason: 'database-open-failed', path };
  }

  try {
    // Never block a running ZCode UI behind our reads, and refuse writes at the
    // engine level as a second line of defence behind `readOnly`.
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`);
    try {
      db.exec('PRAGMA query_only = ON');
    } catch {
      /* older SQLite builds may not accept it; readOnly already prevents writes */
    }
  } catch (error) {
    warn?.add('db-pragma-failed', `数据库只读设置未完全生效：${/** @type {Error} */ (error).message}`, {
      where: path,
      severity: 'warning',
    });
  }

  /** @type {Record<string, Set<string>>} */
  const columns = {};
  try {
    for (const table of REQUIRED_TABLES) columns[table] = tableColumns(db, table);
  } catch (error) {
    warn?.add('db-schema-unreadable', `读取表结构失败：${/** @type {Error} */ (error).message}`, {
      where: path,
      severity: 'error',
    });
    try {
      db.close();
    } catch {
      /* nothing useful to add */
    }
    return { ok: false, reason: 'schema-unreadable', path };
  }

  return {
    ok: true,
    db,
    columns: { message: columns.message, part: columns.part },
    path,
    close: () => {
      try {
        db?.close();
      } catch {
        /* a failed close must not fail an otherwise complete import */
      }
    },
  };
}

/**
 * Cheap per-session inventory used by `scan` (no message bodies read).
 *
 * @param {object} source - handle from {@link openZcodeDatabase}.
 * @param {object} [options] - `{ warn }`.
 * @returns {Array<object>} one summary per source session, newest update first.
 */
export function listSessions(source, options = {}) {
  const { db } = source;
  const warn = options.warn;
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id,
                s.title AS title,
                s.directory AS directory,
                s.time_created AS created_at,
                s.time_updated AS updated_at,
                s.project_id AS project_id,
                s.version AS version,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count,
                (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id
                   AND json_extract(p.data, '$.type') IN ('reasoning','thinking')) AS reasoning_count,
                (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id
                   AND json_extract(p.data, '$.type') IN ('tool','tool-call')) AS tool_count
         FROM session s
         ORDER BY s.time_updated DESC, s.id`,
      )
      .all();
    return rows.map((r) => ({
      id: String(r.id),
      title: typeof r.title === 'string' ? r.title : '',
      directory: typeof r.directory === 'string' ? r.directory : '',
      createdAt: Number(r.created_at) || 0,
      updatedAt: Number(r.updated_at) || 0,
      projectId: r.project_id ?? null,
      zcodeVersion: r.version ?? null,
      messageCount: Number(r.message_count) || 0,
      reasoningCount: Number(r.reasoning_count) || 0,
      toolCount: Number(r.tool_count) || 0,
      sourceKind: 'sqlite',
    }));
  } catch (error) {
    warn?.add('db-list-failed', `会话列表读取失败：${/** @type {Error} */ (error).message}`, {
      severity: 'error',
      where: source.path,
    });
    return [];
  }
}

/**
 * Read every message and part of one session, normalized (FR-2).
 *
 * @param {object} source - handle from {@link openZcodeDatabase}.
 * @param {string} sessionId - source session id.
 * @param {object} [options] - `{ warn }`.
 * @returns {import('./model.js').SourceSession|undefined} normalized session.
 */
export function readSession(source, sessionId, options = {}) {
  const { db } = source;
  const warn = options.warn;

  let sessionRow;
  try {
    sessionRow = db
      .prepare(
        `SELECT id, title, directory, path, time_created, time_updated, project_id, version, task_type
         FROM session WHERE id = ?`,
      )
      .get(sessionId);
  } catch (error) {
    warn?.add('db-session-read-failed', `会话行读取失败：${/** @type {Error} */ (error).message}`, {
      severity: 'error',
      where: sessionId,
      sessionId,
    });
    return undefined;
  }
  if (sessionRow === undefined) return undefined;

  const messageOrder = orderClause(source.columns.message);
  const partOrder = orderClause(source.columns.part);

  /** @type {Array<object>} */
  let messageRows;
  try {
    messageRows = db
      .prepare(
        `SELECT id, data, time_created, ${source.columns.message.has('sequence') ? 'sequence' : 'NULL AS sequence'}
         FROM message WHERE session_id = ? ORDER BY ${messageOrder}`,
      )
      .all(sessionId);
  } catch (error) {
    warn?.add('db-messages-read-failed', `消息读取失败：${/** @type {Error} */ (error).message}`, {
      severity: 'error',
      where: sessionId,
      sessionId,
    });
    return undefined;
  }

  /** @type {Array<object>} */
  let partRows;
  try {
    partRows = db
      .prepare(
        `SELECT id, message_id, data, time_created, ${source.columns.part.has('sequence') ? 'sequence' : 'NULL AS sequence'}
         FROM part WHERE session_id = ? ORDER BY message_id, ${partOrder}`,
      )
      .all(sessionId);
  } catch (error) {
    warn?.add('db-parts-read-failed', `part 读取失败：${/** @type {Error} */ (error).message}`, {
      severity: 'error',
      where: sessionId,
      sessionId,
    });
    return undefined;
  }

  /** @type {Map<string, object[]>} */
  const partsByMessage = new Map();
  for (const row of partRows) {
    const bucket = partsByMessage.get(String(row.message_id));
    if (bucket === undefined) partsByMessage.set(String(row.message_id), [row]);
    else bucket.push(row);
  }

  /** @type {import('./model.js').SourceMessage[]} */
  const messages = [];
  for (const row of messageRows) {
    const id = String(row.id);
    /** @type {object} */
    let raw;
    try {
      raw = JSON.parse(String(row.data));
    } catch (error) {
      warn?.add('message-json-invalid', `消息 JSON 解析失败，已跳过该消息：${/** @type {Error} */ (error).message}`, {
        severity: 'error',
        sessionId,
        where: id,
      });
      continue;
    }

    /** @type {import('./model.js').SourcePart[]} */
    const parts = [];
    for (const partRow of partsByMessage.get(id) ?? []) {
      const partId = String(partRow.id);
      let rawPart;
      try {
        rawPart = JSON.parse(String(partRow.data));
      } catch (error) {
        warn?.add('part-json-invalid', `part JSON 解析失败，已跳过该 part：${/** @type {Error} */ (error).message}`, {
          severity: 'error',
          sessionId,
          where: partId,
        });
        continue;
      }
      parts.push(
        normalizePart(
          rawPart,
          partId,
          Number(partRow.time_created) || Number(row.time_created) || 0,
          partRow.sequence === null || partRow.sequence === undefined ? undefined : Number(partRow.sequence),
        ),
      );
    }

    messages.push(
      normalizeMessage(
        raw,
        {
          id,
          time: Number(row.time_created) || 0,
          sequence: row.sequence === null || row.sequence === undefined ? undefined : Number(row.sequence),
        },
        parts,
      ),
    );
  }

  const firstWithModel = messages.find((m) => m.meta.model !== undefined || m.meta.provider !== undefined);
  return {
    id: String(sessionRow.id),
    title: typeof sessionRow.title === 'string' ? sessionRow.title : '',
    directory: typeof sessionRow.directory === 'string' && sessionRow.directory !== ''
      ? sessionRow.directory
      : typeof sessionRow.path === 'string'
        ? sessionRow.path
        : '',
    createdAt: Number(sessionRow.time_created) || 0,
    updatedAt: Number(sessionRow.time_updated) || 0,
    sourceKind: 'sqlite',
    meta: {
      projectId: sessionRow.project_id ?? null,
      zcodeVersion: sessionRow.version ?? null,
      taskType: sessionRow.task_type ?? null,
      model: firstWithModel?.meta.model ?? null,
      provider: firstWithModel?.meta.provider ?? null,
    },
    messages,
  };
}
