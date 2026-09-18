/**
 * Legacy source reader: the pre-3.0 `projects/**\/*.jsonl` layout (FR-1.4).
 *
 * Before ZCode 3.0 the runtime was an embedded Claude-compatible one, and
 * sessions were stored the way that runtime stored them: one JSONL file per
 * session under `projects/<project>/`, each line a message record with
 * `type`, `uuid`, `parentUuid`, `timestamp`, `cwd`, and a `message.content`
 * that is either a string or a block array (`text`, `thinking`, `tool_use`,
 * `tool_result`).
 *
 * This reader is **best-effort by design**, which is why it is off by default
 * and marked `partial` wherever it appears:
 *
 * - the format is not documented and no sample of it exists on the machines
 *   this plugin was built against, so every field is read through a fallback
 *   chain and a missing field degrades to a warning;
 * - `cwd` comes from the records themselves rather than from the directory
 *   name, because the directory name is a lossy encoding of the path
 *   (separators and real dashes both become `-`);
 * - reasoning is taken from `thinking` blocks (`thinking` field) with
 *   `reasoning`/`text`/`value` as fallbacks.
 *
 * Everything it cannot recover is counted, never invented.
 *
 * @module dsh-zcode-migrate/source/legacy-source
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SEVERITY } from '../core/warnings.js';

/** Directory holding the legacy project trees inside a ZCode home. */
export const LEGACY_RELATIVE_PATH = 'projects';

/**
 * Read a field through a fallback chain.
 * @param {object} record - record.
 * @param {string[]} keys - candidate keys.
 * @returns {string|undefined} first non-empty string.
 */
function pickString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Walk a directory tree collecting files with a given extension.
 * @param {string} root - directory.
 * @param {string} extension - file extension including the dot.
 * @param {number} [depth] - remaining recursion depth.
 * @returns {string[]} absolute file paths.
 */
function walk(root, extension, depth = 4) {
  if (depth < 0) return [];
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, extension, depth - 1));
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(path);
  }
  return out;
}

/**
 * List legacy session files.
 *
 * @param {string} zcodeHome - ZCode home.
 * @param {object} [options] - `{ warn }`.
 * @returns {Array<object>} one summary per file.
 */
export function listLegacySessions(zcodeHome, options = {}) {
  const warn = options.warn;
  const root = join(zcodeHome, LEGACY_RELATIVE_PATH);
  if (!existsSync(root)) {
    warn?.add('legacy-dir-missing', `旧版 projects 目录不存在：${root}（FR-1.4 未启用任何数据）`, {
      severity: SEVERITY.info,
      where: root,
    });
    return [];
  }

  /** @type {Array<object>} */
  const summaries = [];
  for (const path of walk(root, '.jsonl')) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    summaries.push({
      id: `legacy:${path}`,
      path,
      title: basename(path, '.jsonl'),
      directory: '',
      createdAt: Math.floor(stats.birthtimeMs || stats.mtimeMs),
      updatedAt: Math.floor(stats.mtimeMs),
      projectId: null,
      zcodeVersion: 'legacy',
      messageCount: 0,
      reasoningCount: 0,
      toolCount: 0,
      bytes: stats.size,
      sourceKind: 'legacy',
      partial: true,
    });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Read one legacy session file into the source model.
 *
 * @param {string} zcodeHome - ZCode home.
 * @param {string} id - the summary's `id` (`legacy:<path>`).
 * @param {object} [options] - `{ warn }`.
 * @returns {import('./model.js').SourceSession|undefined} normalized session.
 */
export function readLegacySession(zcodeHome, id, options = {}) {
  const warn = options.warn;
  const path = id.startsWith('legacy:') ? id.slice('legacy:'.length) : id;
  if (!existsSync(path)) return undefined;

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    warn?.add('legacy-read-failed', `旧版会话文件读取失败：${/** @type {Error} */ (error).message}`, {
      sessionId: id,
      severity: SEVERITY.error,
      where: path,
    });
    return undefined;
  }

  /** @type {object[]} */
  const records = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) {
    warn?.add('legacy-malformed-lines', `旧版会话有 ${malformed} 行无法解析，已跳过`, {
      sessionId: id,
      severity: SEVERITY.warning,
      where: path,
    });
  }

  /** @type {import('./model.js').SourceMessage[]} */
  const messages = [];
  /** @type {Map<string, import('./model.js').SourcePart>} */
  const partsByCallId = new Map();
  let turnCounter = 0;
  let currentTurn = 'legacy-turn-1';
  let sawAssistant = false;
  let directory = '';
  let title = '';
  let createdAt = 0;
  let updatedAt = 0;
  let time = 0;

  for (const [index, record] of records.entries()) {
    const recordType = pickString(record, ['type']);
    const timestamp = Date.parse(String(record.timestamp ?? '')) || 0;
    time = timestamp || time;
    if (createdAt === 0) createdAt = time;
    updatedAt = Math.max(updatedAt, time);
    if (directory === '' && typeof record.cwd === 'string') directory = record.cwd;

    if (recordType === 'summary') {
      const summary = pickString(record, ['summary']);
      if (summary !== undefined && title === '') title = summary.split('\n')[0].slice(0, 80);
      continue;
    }
    if (record.isSidechain === true) continue; // subagent sidechains are not this session's history

    const role = pickString(record.message ?? {}, ['role']) ?? (recordType === 'assistant' ? 'assistant' : recordType === 'user' ? 'user' : undefined);
    if (role !== 'user' && role !== 'assistant') continue;

    const content = record.message?.content;
    /** @type {import('./model.js').SourcePart[]} */
    const parts = [];
    let hasToolResult = false;

    if (typeof content === 'string') {
      if (content !== '') {
        parts.push({ kind: 'text', id: `legacy-${index}-t`, time, text: content });
      }
    } else if (Array.isArray(content)) {
      content.forEach((block, blockIndex) => {
        const blockId = `legacy-${index}-b${blockIndex}`;
        switch (block?.type) {
          case 'text': {
            const value = pickString(block, ['text']);
            if (value !== undefined) parts.push({ kind: 'text', id: blockId, time, text: value });
            break;
          }
          case 'thinking':
          case 'reasoning': {
            const value = pickString(block, ['thinking', 'text', 'reasoning', 'value']);
            if (value !== undefined) parts.push({ kind: 'reasoning', id: blockId, time, text: value });
            break;
          }
          case 'tool_use': {
            const callId = pickString(block, ['id', 'tool_use_id', 'toolUseId']) ?? `legacy-call-${index}-${blockIndex}`;
            /** @type {import('./model.js').SourcePart} */
            const part = {
              kind: 'tool',
              id: blockId,
              time,
              callId,
              toolName: pickString(block, ['name', 'tool']) ?? 'unknown-tool',
              status: 'running',
              input: block.input,
            };
            parts.push(part);
            partsByCallId.set(callId, part);
            break;
          }
          case 'tool_result': {
            hasToolResult = true;
            const callId = pickString(block, ['tool_use_id', 'toolUseId', 'id']);
            const part = callId === undefined ? undefined : partsByCallId.get(callId);
            if (part === undefined) break;
            const raw = block.content;
            const textValue =
              typeof raw === 'string'
                ? raw
                : Array.isArray(raw)
                  ? raw.map((inner) => (typeof inner?.text === 'string' ? inner.text : '')).join('')
                  : '';
            const isError = block.is_error === true;
            part.status = isError ? 'error' : 'completed';
            part.output = isError ? undefined : textValue;
            part.error = isError ? textValue : undefined;
            part.toolEndTime = time;
            break;
          }
          default:
            break;
        }
      });
    }

    // A user record whose only content is tool results answers the previous
    // step; it is not new user input.
    if (role === 'user' && hasToolResult && parts.length === 0) continue;

    if (role === 'user') {
      if (sawAssistant) {
        turnCounter += 1;
        currentTurn = `legacy-turn-${turnCounter}`;
        sawAssistant = false;
      }
      if (title === '' && parts.length > 0 && parts[0].kind === 'text') {
        title = parts[0].text.split('\n')[0].slice(0, 80);
      }
    } else {
      sawAssistant = true;
    }
    if (parts.length === 0) continue;

    messages.push({
      id: pickString(record, ['uuid']) ?? `legacy-${index}`,
      role,
      time,
      completedTime: time,
      sequence: messages.length,
      turnId: currentTurn,
      parts,
      meta: {
        // Claude-compatible logs mark injected content with `isMeta`, so the
        // human/injection distinction survives where the source recorded it.
        origin: role === 'user' ? (record.isMeta === true ? 'legacy_meta' : 'real_user') : undefined,
        model: pickString(record.message ?? {}, ['model']) ?? pickString(record, ['model']),
        provider: pickString(record, ['provider']),
      },
    });
  }

  if (messages.length === 0) {
    warn?.add('legacy-no-messages', '旧版会话文件没有可迁移的消息', {
      sessionId: id,
      severity: SEVERITY.error,
      where: path,
    });
    return undefined;
  }

  warn?.add(
    'legacy-best-effort',
    '本次迁移使用旧版 projects/**/*.jsonl 数据源（FR-1.4，尽力兼容）：字段按回退链解析，无法恢复的内容按占位或跳过处理',
    { sessionId: id, severity: SEVERITY.warning, detail: { records: records.length } },
  );

  return {
    id,
    title,
    directory,
    createdAt: createdAt || updatedAt,
    updatedAt: updatedAt || createdAt,
    sourceKind: 'legacy',
    meta: { projectId: null, zcodeVersion: 'legacy', taskType: null, model: null, provider: null },
    messages,
  };
}
