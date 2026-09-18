/**
 * Fallback source reader: ZCode's rollout model-I/O transcripts (FR-1.3).
 *
 * `cli/rollout/model-io-<sessionId>.jsonl` records what ZCode sent to and
 * received from the provider, one line per model call. It is used when the
 * SQLite store is missing or unreadable, and it reconstructs more than one
 * would expect:
 *
 * - every line carries its call's `response` — `reasoningText`, `text`,
 *   `toolCalls` — so reasoning survives verbatim;
 * - every line also carries the request **window** it was sent with
 *   (`request.messages` + `request.messageOffset`), which holds the user
 *   prompts, the earlier assistant turns, and the `role:"tool"` results;
 * - the windows slide forward, so merging them by global index yields the whole
 *   model-visible transcript exactly once. Each response appears in the *next*
 *   window, so only the final response needs to be replayed from its own line.
 *
 * Honest limits, reported as warnings rather than hidden: the rollout log has no
 * per-message timestamps (each message is stamped with the enclosing call's
 * start time), and history that had already scrolled out of the first window is
 * not recoverable.
 *
 * @module dsh-zcode-migrate/source/rollout-source
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SEVERITY } from '../core/warnings.js';

/** Directory holding the rollout transcripts inside a ZCode home. */
export const ROLLOUT_RELATIVE_PATH = join('cli', 'rollout');

/** Filename shape of one session's transcript. */
const FILE_PREFIX = 'model-io-';
const FILE_SUFFIX = '.jsonl';

/**
 * Absolute path of the rollout directory.
 * @param {string} zcodeHome - ZCode home.
 * @returns {string} path.
 */
export function rolloutDir(zcodeHome) {
  return join(zcodeHome, ROLLOUT_RELATIVE_PATH);
}

/**
 * Read a field through a small fallback chain.
 * @param {object} record - record.
 * @param {string[]} keys - candidate keys, most specific first.
 * @returns {string|undefined} the first non-empty string.
 */
function pickString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * List the rollout transcripts available in a ZCode home.
 *
 * @param {string} zcodeHome - ZCode home.
 * @param {object} [options] - `{ warn }`.
 * @returns {Array<object>} one summary per transcript, newest first.
 */
export function listRolloutSessions(zcodeHome, options = {}) {
  const warn = options.warn;
  const dir = rolloutDir(zcodeHome);
  if (!existsSync(dir)) {
    warn?.add('rollout-dir-missing', `rollout 目录不存在：${dir}（兜底源不可用）`, {
      severity: SEVERITY.warning,
      where: dir,
    });
    return [];
  }

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    warn?.add('rollout-dir-unreadable', `rollout 目录无法读取：${/** @type {Error} */ (error).message}`, {
      severity: SEVERITY.warning,
      where: dir,
    });
    return [];
  }

  /** @type {Array<object>} */
  const summaries = [];
  for (const entry of entries) {
    if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) continue;
    const id = entry.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
    if (id === '') continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    summaries.push({
      id,
      title: '',
      directory: '',
      createdAt: Math.floor(stats.birthtimeMs || stats.mtimeMs),
      updatedAt: Math.floor(stats.mtimeMs),
      projectId: null,
      zcodeVersion: null,
      messageCount: 0,
      reasoningCount: 0,
      toolCount: 0,
      bytes: stats.size,
      sourceKind: 'rollout',
      partial: true,
    });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Parse a transcript file into records, tolerating a crash-truncated tail.
 *
 * @param {string} path - file path.
 * @param {import('../core/warnings.js').WarningLog} [warn] - warning sink.
 * @returns {object[]} parsed records in file order.
 */
function readRecords(path, warn) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    warn?.add('rollout-read-failed', `rollout 转录读取失败：${/** @type {Error} */ (error).message}`, {
      severity: SEVERITY.error,
      where: path,
    });
    return [];
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
    warn?.add('rollout-malformed-lines', `rollout 转录中有 ${malformed} 行无法解析（可能被截断），已跳过`, {
      severity: SEVERITY.warning,
      where: path,
    });
  }
  return records;
}

/**
 * Split one window entry's content into reasoning and visible text.
 * @param {object} message - window entry.
 * @returns {{ reasoning: string, text: string }} split content.
 */
function windowContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return { reasoning: '', text: content };
  if (Array.isArray(content)) {
    let reasoning = '';
    let text = '';
    for (const block of content) {
      if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning += block.text;
      else if (typeof block?.text === 'string') text += block.text;
    }
    return { reasoning, text };
  }
  return { reasoning: '', text: '' };
}

/**
 * Merge every request window into one indexed transcript.
 *
 * A message is kept at the earliest global index that ever contained it, with
 * the start time of that window as its timestamp — the closest available
 * approximation of when it was appended.
 *
 * @param {object[]} records - rollout records in file order.
 * @returns {{ entries: Array<{index: number, message: object, at: number, terminal: boolean}>, firstAt: number, lastAt: number, gapDetected: boolean, model: object }}
 *   merged transcript and metadata.
 */
function mergeWindows(records) {
  /** @type {Map<number, {index: number, message: object, at: number, terminal: boolean}>} */
  const merged = new Map();
  let firstAt = 0;
  let lastAt = 0;
  let gapDetected = false;
  let previousEnd = 0;
  /** @type {object} */
  let model = {};

  records.forEach((record, index) => {
    const startedAt = Date.parse(String(record.startedAt ?? '')) || 0;
    const completedAt = Date.parse(String(record.completedAt ?? '')) || startedAt;
    if (index === 0) firstAt = startedAt;
    lastAt = Math.max(lastAt, completedAt);
    if (record.model !== null && typeof record.model === 'object') model = record.model;

    const request = record.request ?? {};
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const offset = typeof request.messageOffset === 'number' ? request.messageOffset : 0;
    if (index > 0 && previousEnd < offset) gapDetected = true;

    messages.forEach((message, position) => {
      const globalIndex = offset + position;
      // The window's last message is the input this call answered, which is how
      // a human prompt is told apart from older injected context (see the user
      // branch below). OR-folded across windows, since a message can be terminal
      // in one window and history in the next.
      const terminal = position === messages.length - 1;
      const seen = merged.get(globalIndex);
      if (seen === undefined) merged.set(globalIndex, { index: globalIndex, message, at: startedAt, terminal });
      else if (terminal) seen.terminal = true;
    });
    previousEnd = offset + messages.length;
  });

  return {
    entries: [...merged.values()].sort((a, b) => a.index - b.index),
    firstAt,
    lastAt,
    gapDetected,
    model,
  };
}

/**
 * Read one rollout transcript into the source model.
 *
 * @param {string} zcodeHome - ZCode home.
 * @param {string} sessionId - session id (the transcript's file stem).
 * @param {object} [options] - `{ warn }`.
 * @returns {import('./model.js').SourceSession|undefined} normalized session.
 */
export function readRolloutSession(zcodeHome, sessionId, options = {}) {
  const warn = options.warn;
  const path = join(rolloutDir(zcodeHome), `${FILE_PREFIX}${sessionId}${FILE_SUFFIX}`);
  if (!existsSync(path)) return undefined;

  const records = readRecords(path, warn);
  if (records.length === 0) {
    warn?.add('rollout-empty', 'rollout 转录为空，无法作为数据源', {
      sessionId,
      severity: SEVERITY.error,
      where: path,
    });
    return undefined;
  }

  const { entries, firstAt, lastAt, gapDetected, model } = mergeWindows(records);
  const provenance = {
    model: typeof model.modelId === 'string' ? model.modelId : undefined,
    provider: typeof model.providerId === 'string' ? model.providerId : undefined,
  };

  /** @type {import('./model.js').SourceMessage[]} */
  const messages = [];
  /** @type {Map<string, import('./model.js').SourcePart>} */
  const partsByCallId = new Map();
  let turnCounter = 1;
  let currentTurn = `rollout-turn-1`;
  let sawAssistant = false;
  let time = firstAt;

  /**
   * Append one message to the transcript.
   * @param {'user'|'assistant'} role - message role.
   * @param {string} id - synthesized id.
   * @param {import('./model.js').SourcePart[]} parts - parts.
   * @param {object} meta - flattened source facts.
   * @returns {import('./model.js').SourceMessage} the appended message.
   */
  const append = (role, id, parts, meta) => {
    const message = {
      id,
      role,
      time,
      completedTime: time,
      sequence: messages.length,
      turnId: currentTurn,
      parts,
      meta,
    };
    messages.push(message);
    return message;
  };

  for (const entry of entries) {
    time = entry.at || time;
    const message = entry.message ?? {};

    if (message.role === 'user') {
      // A prompt issued after the model has spoken opens the next turn; a run of
      // consecutive user messages stays in the turn it was injected into.
      if (sawAssistant) {
        turnCounter += 1;
        currentTurn = `rollout-turn-${turnCounter}`;
        sawAssistant = false;
      }
      const content = windowContent(message);
      if (content.text === '') continue;
      append('user', `rollout-window-${entry.index}`, [
        { kind: 'text', id: `rollout-window-${entry.index}-t`, time, text: content.text },
      ], {
        // Only a window's final message is the input that call answered, so it is
        // the one user message that can be called a human prompt; anything else in
        // a window is history whose provenance this source cannot settle. Marking
        // the rest as undetermined keeps the model-visible history byte-identical
        // while stopping the UI from attributing machine text to the human.
        origin: entry.terminal ? 'real_user' : 'rollout_undetermined',
        semanticsKind: 'user_prompt',
      });
      continue;
    }

    if (message.role === 'assistant') {
      sawAssistant = true;
      const content = windowContent(message);
      /** @type {import('./model.js').SourcePart[]} */
      const parts = [];
      if (content.reasoning !== '') {
        parts.push({ kind: 'reasoning', id: `rollout-window-${entry.index}-r`, time, text: content.reasoning });
      }
      if (content.text !== '') {
        parts.push({ kind: 'text', id: `rollout-window-${entry.index}-t`, time, text: content.text });
      }
      for (const [callIndex, call] of (message.toolCalls ?? []).entries()) {
        const callId = typeof call?.id === 'string' ? call.id : `rollout-call-${entry.index}-${callIndex}`;
        /** @type {import('./model.js').SourcePart} */
        const part = {
          kind: 'tool',
          id: `rollout-window-${entry.index}-c${callIndex}`,
          time,
          callId,
          toolName: typeof call?.name === 'string' ? call.name : 'unknown-tool',
          status: 'running', // resolved below when the matching tool result appears
          input: call?.input,
        };
        parts.push(part);
        partsByCallId.set(callId, part);
      }
      if (parts.length === 0) continue; // an empty assistant frame adds nothing
      append('assistant', `rollout-window-${entry.index}`, parts, provenance);
      continue;
    }

    if (message.role === 'tool') {
      const callId = pickString(message, ['toolCallId', 'tool_call_id', 'id']);
      const part = callId === undefined ? undefined : partsByCallId.get(callId);
      if (part === undefined) continue;
      const text = typeof message.content === 'string' ? message.content : '';
      const isError = message.isError === true;
      part.status = isError ? 'error' : 'completed';
      part.output = isError ? undefined : text;
      part.error = isError ? text : undefined;
      part.toolEndTime = time;
      continue;
    }
  }

  // The final call's response was never sent back to the provider, so no window
  // contains it: replay it from its own record.
  const last = records[records.length - 1] ?? {};
  const lastResponse = last.response ?? {};
  const finalAt = Date.parse(String(last.completedAt ?? '')) || lastAt;
  const hasPayload =
    (typeof lastResponse.reasoningText === 'string' && lastResponse.reasoningText !== '') ||
    (typeof lastResponse.text === 'string' && lastResponse.text !== '') ||
    (Array.isArray(lastResponse.toolCalls) && lastResponse.toolCalls.length > 0);

  if (hasPayload) {
    time = finalAt || time;
    /** @type {import('./model.js').SourcePart[]} */
    const parts = [];
    if (typeof lastResponse.reasoningText === 'string' && lastResponse.reasoningText !== '') {
      parts.push({ kind: 'reasoning', id: 'rollout-final-r', time, text: lastResponse.reasoningText });
    }
    if (typeof lastResponse.text === 'string' && lastResponse.text !== '') {
      parts.push({ kind: 'text', id: 'rollout-final-t', time, text: lastResponse.text });
    }
    for (const [callIndex, call] of (lastResponse.toolCalls ?? []).entries()) {
      const callId = typeof call?.id === 'string' ? call.id : `rollout-final-call-${callIndex}`;
      const part = {
        kind: 'tool',
        id: `rollout-final-c${callIndex}`,
        time,
        callId,
        toolName: typeof call?.name === 'string' ? call.name : 'unknown-tool',
        status: 'running',
        input: call?.input,
      };
      parts.push(part);
      partsByCallId.set(callId, part);
    }
    if (parts.length > 0) {
      append('assistant', 'rollout-final', parts, {
        ...provenance,
        finish: typeof lastResponse.finishReason === 'string' ? lastResponse.finishReason : undefined,
        tokens: lastResponse.usage,
      });
    }
  }

  warn?.add(
    'rollout-fallback',
    '本次使用 rollout 兜底源：思路与工具内容来自模型 I/O 记录（逐字），消息时间由所属调用时间近似；早于首个请求窗口的历史无法恢复，且该源无法区分人工输入与运行时注入的上下文',
    { sessionId, severity: SEVERITY.warning, detail: { lines: records.length, gapDetected } },
  );
  if (gapDetected) {
    warn?.add('rollout-window-gap', 'rollout 请求窗口之间存在缺口，部分历史消息可能未被覆盖', {
      sessionId,
      severity: SEVERITY.warning,
    });
  }

  return {
    id: sessionId,
    title: '',
    directory: inferDirectory(records),
    createdAt: firstAt || lastAt,
    updatedAt: lastAt || firstAt,
    sourceKind: 'rollout',
    meta: {
      projectId: null,
      zcodeVersion: null,
      taskType: null,
      model: provenance.model ?? null,
      provider: provenance.provider ?? null,
    },
    messages,
  };
}

/**
 * Infer the session's working directory from the request windows.
 *
 * The rollout log records no session row, so the environment block embedded in
 * the request's system/user content is the only place the cwd appears.
 *
 * @param {object[]} records - rollout records.
 * @returns {string} directory, or `''` when it cannot be determined.
 */
function inferDirectory(records) {
  for (const record of records.slice(0, 8)) {
    for (const message of record.request?.messages ?? []) {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (match !== null) {
        try {
          return JSON.parse(`"${match[1]}"`);
        } catch {
          return match[1];
        }
      }
    }
  }
  return '';
}
