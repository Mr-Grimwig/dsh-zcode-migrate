/**
 * The source model every reader produces, plus the one place that knows how to
 * read a raw ZCode part/message record.
 *
 * FR/NFR-4 ("解析层需集中、字段回退链清晰") is the whole point of this module:
 * ZCode has no export contract, so field names drift between versions. Every
 * drift-sensitive read is a documented fallback chain here, and the readers
 * above this layer (sqlite / rollout / legacy) only supply raw JSON.
 *
 * @module dsh-zcode-migrate/source/model
 */

/**
 * @typedef {object} SourcePart
 * @property {'text'|'reasoning'|'tool'|'file'|'step-start'|'step-finish'|'timeline'|'compaction'|'unknown'} kind
 * @property {string} id - source part id (synthesized when the source has none).
 * @property {number} time - epoch ms.
 * @property {number|undefined} sequence - source ordering key.
 * @property {string} [text] - text/reasoning payload, verbatim.
 * @property {string} [callId] - tool call id.
 * @property {string} [toolName] - tool name.
 * @property {string} [status] - tool state status (`completed`/`error`/`running`/`pending`).
 * @property {unknown} [input] - tool arguments, as the source stored them (object or raw string).
 * @property {string} [output] - tool result text.
 * @property {string} [error] - tool failure text.
 * @property {number} [toolEndTime] - tool completion epoch ms, when the source recorded it.
 * @property {string} [mime] - file part mime type.
 * @property {string} [url] - file part url (e.g. `zcode-artifact://…`).
 * @property {object} [fileMeta] - file part metadata, kept verbatim for the record.
 * @property {string} [stepFinishReason] - step-finish reason.
 * @property {object} [tokens] - token accounting when the source recorded it.
 * @property {object} [raw] - the original parsed record (report/diagnostics only).
 */

/**
 * @typedef {object} SourceMessage
 * @property {string} id - source message id.
 * @property {'user'|'assistant'} role - provider-neutral role.
 * @property {number} time - epoch ms (creation).
 * @property {number|undefined} completedTime - epoch ms when the source recorded it.
 * @property {number|undefined} sequence - source ordering key.
 * @property {string|null} turnId - ZCode turn id (`anchor.turnId`), `null` when absent.
 * @property {SourcePart[]} parts - ordered parts.
 * @property {object} meta - flattened source facts used by the transform:
 *   `{ origin, semanticsKind, model, provider, mode, finish, tokens, cwd }`.
 */

/**
 * @typedef {object} SourceSession
 * @property {string} id
 * @property {string} title
 * @property {string} directory - the session's workspace path (may be empty).
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {'sqlite'|'rollout'|'legacy'} sourceKind
 * @property {object} meta - `{ projectId, zcodeVersion, taskType, model, provider }`.
 * @property {SourceMessage[]} messages - every message, in source order.
 */

/** Part kinds recognized by the transform; anything else becomes `unknown`. */
export const KNOWN_PART_KINDS = Object.freeze([
  'text',
  'reasoning',
  'tool',
  'file',
  'step-start',
  'step-finish',
  'timeline',
  'compaction',
]);

/**
 * Read the first present, non-null member of a record.
 *
 * The single primitive behind every fallback chain below: a renamed field only
 * ever costs one entry here.
 *
 * @param {object} record - raw record.
 * @param {string[]} keys - candidate keys, most specific first.
 * @returns {unknown} the first value that is neither `undefined` nor `null`.
 */
export function pick(record, keys) {
  if (record === null || typeof record !== 'object') return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Read a string field through a fallback chain.
 * @param {object} record - raw record.
 * @param {string[]} keys - candidate keys.
 * @returns {string|undefined} the value when it is a non-empty string.
 */
export function pickString(record, keys) {
  const value = pick(record, keys);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Epoch-ms from a `{ start, end }` style time object or a bare number.
 * @param {unknown} value - candidate.
 * @returns {number|undefined} epoch ms.
 */
export function pickTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value !== null && typeof value === 'object') {
    const start = /** @type {any} */ (value).start ?? /** @type {any} */ (value).created;
    if (typeof start === 'number' && Number.isFinite(start)) return start;
  }
  return undefined;
}

/**
 * Normalize ZCode token accounting into DSH's {@link TokenUsage} field names.
 *
 * ZCode: `{ total, input, output, reasoning, cache: { read, write } }`
 * DSH:   `{ inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens }`
 *
 * @param {unknown} tokens - source token record.
 * @returns {object|undefined} DSH-shaped usage, or `undefined` when absent.
 */
export function normalizeUsage(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined;
  const t = /** @type {any} */ (tokens);
  const cache = t.cache ?? {};
  const usage = {};
  if (typeof t.input === 'number') usage.inputTokens = t.input;
  if (typeof t.output === 'number') usage.outputTokens = t.output;
  if (typeof t.reasoning === 'number') usage.reasoningTokens = t.reasoning;
  if (typeof cache.read === 'number') usage.cacheReadTokens = cache.read;
  if (typeof cache.write === 'number') usage.cacheWriteTokens = cache.write;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Read one raw part record into a {@link SourcePart}.
 *
 * Fallback chains (most specific first):
 * - reasoning text: `text` → `thinking` → `reasoning` → `value`
 * - tool call id:   `callID` → `callId` → `toolCallId` → `id`
 * - tool name:      `tool`   → `name`   → `toolName`
 * - tool input:     `state.input` → `state.args` → `input`
 * - tool output:    `state.output` → `output`
 * - tool failure:   `state.error` → `error`
 *
 * @param {object} raw - parsed part `data` object.
 * @param {string} id - source part id (used when the record carries none).
 * @param {number} time - epoch ms.
 * @param {number|undefined} sequence - source ordering key.
 * @returns {SourcePart} normalized part.
 */
export function normalizePart(raw, id, time, sequence) {
  const data = raw !== null && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const type = typeof data.type === 'string' ? data.type : 'unknown';
  /** @type {SourcePart} */
  const base = { kind: /** @type {any} */ (type), id, time, sequence, raw: data };

  switch (type) {
    case 'text': {
      base.text = pickString(data, ['text']) ?? '';
      return base;
    }
    case 'reasoning':
    case 'thinking': {
      // FR-2.1/FR-3.1: the reasoning payload is copied, never reshaped.
      base.kind = 'reasoning';
      base.text = pickString(data, ['text', 'thinking', 'reasoning', 'value']) ?? '';
      return base;
    }
    case 'tool':
    case 'tool-call':
    case 'tool_call': {
      const state = data.state !== null && typeof data.state === 'object' ? data.state : {};
      base.kind = 'tool';
      base.callId = pickString(data, ['callID', 'callId', 'toolCallId', 'id']);
      base.toolName = pickString(data, ['tool', 'name', 'toolName']) ?? 'unknown-tool';
      base.status = pickString(state, ['status']) ?? 'completed';
      base.input = pick(state, ['input', 'args']) ?? pick(data, ['input', 'args']);
      base.output = pickString(state, ['output']) ?? pickString(data, ['output']);
      base.error = pickString(state, ['error']) ?? pickString(data, ['error']);
      base.toolEndTime = pickTime(state.time);
      return base;
    }
    case 'file':
    case 'attachment': {
      base.kind = 'file';
      base.mime = pickString(data, ['mime', 'mimeType', 'mediaType']);
      base.url = pickString(data, ['url', 'uri']);
      const meta = pick(data, ['metadata', 'meta']);
      if (meta !== undefined && typeof meta === 'object') base.fileMeta = /** @type {object} */ (meta);
      return base;
    }
    case 'step-start': {
      base.kind = 'step-start';
      return base;
    }
    case 'step-finish': {
      base.kind = 'step-finish';
      base.stepFinishReason = pickString(data, ['reason', 'finishReason']);
      const tokens = pick(data, ['tokens']);
      if (tokens !== undefined) base.tokens = /** @type {object} */ (tokens);
      return base;
    }
    default:
      return base;
  }
}

/**
 * Read one raw message record into a {@link SourceMessage}.
 *
 * Message-level fallback chains:
 * - turn id:   `anchor.turnId` → `anchor.turnID` → `turnId`
 * - model:     `modelID` → `model.modelID` → `model.id`
 * - provider:  `providerID` → `model.providerID` → `model.provider`
 * - cwd:       `path.cwd` → `contextSnapshot.envInfo.cwd`
 * - tokens:    `tokens` → `usage`
 *
 * @param {object} raw - parsed message `data` object.
 * @param {object} row - storage row facts `{ id, time, sequence }`.
 * @param {import('./model.js').SourcePart[]} parts - already-normalized parts.
 * @returns {SourceMessage} normalized message.
 */
export function normalizeMessage(raw, row, parts) {
  const data = raw !== null && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const anchor = data.anchor ?? {};
  const semantics = data.semantics ?? {};
  const model = data.model ?? {};
  const path = data.path ?? {};
  const contextSnapshot = data.contextSnapshot ?? {};
  const envInfo = contextSnapshot.envInfo ?? {};

  return {
    id: /** @type {string} */ (row.id),
    role: data.role === 'assistant' ? 'assistant' : 'user',
    time: /** @type {number} */ (row.time),
    completedTime: pickTime(data.time),
    sequence: /** @type {number|undefined} */ (row.sequence),
    turnId: pickString(anchor, ['turnId', 'turnID', 'turn']) ?? pickString(data, ['turnId']) ?? null,
    parts,
    meta: {
      origin: pickString(semantics, ['origin']),
      semanticsKind: pickString(semantics, ['kind']),
      visibility: pickString(semantics, ['uiVisibility']),
      model: pickString(data, ['modelID']) ?? pickString(model, ['modelID', 'id']),
      provider: pickString(data, ['providerID']) ?? pickString(model, ['providerID', 'provider']),
      mode: pickString(data, ['mode']),
      agent: pickString(data, ['agent']),
      finish: pickString(data, ['finish']),
      tokens: pick(data, ['tokens', 'usage']),
      cwd: pickString(path, ['cwd']) ?? pickString(envInfo, ['cwd']),
      title: pickString(data.summary ?? {}, ['title']),
      body: pickString(data.summary ?? {}, ['body']),
    },
  };
}
