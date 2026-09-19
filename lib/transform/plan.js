/**
 * The deterministic source → DSH event transform (FR-2…FR-5, the heart of the plugin).
 *
 * There is no model call anywhere in this file, and no randomness: the same
 * source session always yields the same events, byte for byte (FR-3.2, FR-6.1).
 *
 * ## Mapping
 *
 * ZCode and DSH share the same shape, which is why fidelity is possible at all:
 *
 * | ZCode                                | DSH                                        |
 * | ------------------------------------ | ------------------------------------------ |
 * | `message.anchor.turnId`              | one `turn/start` … `turn/end`              |
 * | one assistant message (`step-start`) | one `step/start` … `step/end`              |
 * | `part{type:'reasoning'}`             | `assistant/message` content `reasoning` block |
 * | `part{type:'text'}`                  | `assistant/message` content `text` block   |
 * | `part{type:'tool'}`                  | `content` tool-call block + `tool/call` + `tool/result` |
 * | user message parts                   | `user/message`                             |
 * | session title                        | `session/title` (log-only, pinned)         |
 *
 * Two properties of the target format drive the details:
 *
 * 1. **Tool calls must stay paired.** DSH's own history derivation feeds
 *    `assistant/message` content to the provider, so the tool-call blocks live
 *    *both* inside the assistant message (as blocks) *and* as `tool/call`
 *    events, exactly as a natively-recorded session does. Every `tool/call` is
 *    followed by exactly one `tool/result` (FR-4.2); a tool whose outcome the
 *    source never recorded gets a synthetic result under DSH's own
 *    `TOOL_OUTCOME_UNKNOWN` convention (`dsh-session/repair`), which is what a
 *    crash-recovered native session looks like too.
 *
 * 2. **The log must be structurally balanced** to be resumable: turns and steps
 *    nest strictly, `step/start` numbers restart at 1 in each turn, and no step
 *    stays open at `turn/end`. See `@deepseek-ai/dsh-session`'s invariant
 *    companion for the exact rules this file satisfies.
 *
 * Reasoning text is copied verbatim (FR-3.1): no trim, no truncation, no
 * re-escaping. The only reshaping anywhere is tool *arguments*, because ZCode
 * stores the parsed object rather than the model's original string — those are
 * re-serialized and counted in the report so the loss is visible rather than
 * silent (FR-2.2).
 *
 * @module dsh-zcode-migrate/transform/plan
 */

import { messageId, sha256, stableStringify, targetSessionId } from '../core/digest.js';
import { splitTurns } from './event-log.js';

/** Newest log format version this writer produces. */
export const DSH_SESSION_FORMAT_VERSION = 3;

/**
 * Older format, still produced when the host reads it.
 *
 * The two differ in ways this file has to respect: v3 declares `isSeeded`
 * instead of `seedLength`, and wants every `assistant/message` to carry the
 * stream it was assembled from — {@link synthesizeStream} supplies that for a
 * migrated message, which never had per-delta timing to begin with.
 */
export const LEGACY_SESSION_FORMAT_VERSION = 0;

/** Plugin id recorded on synthesized content, for later diagnosis. */
export const PLUGIN_TAG = 'dsh-zcode-migrate';

/**
 * Tool-call outcomes the source never recorded are synthesized under DSH's own
 * crash-recovery codes, so a migrated session is indistinguishable in shape
 * from a natively recovered one.
 */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED';
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';

/** Placeholder used when a tool result exists but carries no text at all. */
const EMPTY_TOOL_OUTPUT = '(源会话中该工具调用没有记录输出内容)';

/** Placeholder used when a message would otherwise carry no content at all. */
const EMPTY_MESSAGE = '(源会话中该消息没有可迁移的文本内容)';

/**
 * ZCode `finish` values → DSH `turn/end` reasons.
 *
 * `stream_recovery_discarded` maps to `completed`: that step's stream was
 * thrown away mid-turn but the turn itself ran to a normal end, and the
 * discarded step carries no content to preserve.
 */
const TURN_END_BY_FINISH = new Map([
  ['stop', { kind: 'completed' }],
  ['tool-calls', { kind: 'completed' }],
  ['completed', { kind: 'completed' }],
  ['stream_recovery_discarded', { kind: 'completed' }],
  ['length', { kind: 'max-tokens' }],
]);

/**
 * Zeroed counters reported per session (FR-7.3, AC-5).
 * @returns {object} a fresh stats object.
 */
function createStats() {
  return {
    turns: 0,
    steps: 0,
    emptySteps: 0,
    userMessages: 0,
    injectedMessages: 0,
    assistantMessages: 0,
    reasoningBlocks: 0,
    reasoningChars: 0,
    emptyReasoning: 0,
    textBlocks: 0,
    emptyTextSkipped: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolResultsSynthesized: 0,
    toolArguments: { verbatim: 0, reserialized: 0, absent: 0, wrapped: 0 },
    files: 0,
    filePlaceholders: 0,
    emptyOutputs: 0,
    markersSkipped: 0,
    unknownParts: 0,
    nonContentMessages: 0,
    placeholderMessages: 0,
    events: 0,
  };
}

/**
 * Group messages into turn buckets.
 *
 * A message with an `anchor.turnId` opens or extends that turn. A message
 * without one (ZCode's injected reminders and compaction summaries carry no
 * anchor) belongs to whatever turn was in progress when it happened — source
 * order is chronological, so attachment follows the stream rather than a guess.
 * A leading run of unanchored messages forms one synthetic turn of its own.
 *
 * @param {import('../source/model.js').SourceMessage[]} messages - source messages in order.
 * @returns {Array<{ turnId: string|null, items: import('../source/model.js').SourceMessage[] }>} ordered turn buckets.
 */
export function groupIntoTurns(messages) {
  /** @type {Array<{ turnId: string|null, items: import('../source/model.js').SourceMessage[] }>} */
  const groups = [];
  /** @type {Map<string, { turnId: string|null, items: import('../source/model.js').SourceMessage[] }>} */
  const byTurn = new Map();
  /** @type {{ turnId: string|null, items: import('../source/model.js').SourceMessage[] }|null} */
  let current = null;

  for (const message of messages) {
    if (typeof message.turnId === 'string' && message.turnId !== '') {
      let group = byTurn.get(message.turnId);
      if (group === undefined) {
        group = { turnId: message.turnId, items: [] };
        byTurn.set(message.turnId, group);
        groups.push(group);
      }
      group.items.push(message);
      current = group;
      continue;
    }
    if (current === null) {
      current = { turnId: null, items: [] };
      groups.push(current);
    }
    current.items.push(message);
  }
  return groups;
}

/**
 * Whether an assistant message represents one model step.
 *
 * A step is a message that either opened one (`step-start`, which the SQLite
 * store always writes) or carries content of its own — the rollout and legacy
 * readers synthesize messages from provider records and have no `step-start` to
 * offer, and their content is exactly what must not be dropped.
 *
 * Only messages with neither are skipped: ZCode's 188 `timeline_event`
 * messages, which carry compaction separators and no model output at all. They
 * are counted (`nonContentMessages`) rather than silently ignored.
 *
 * @param {import('../source/model.js').SourceMessage} message - assistant message.
 * @returns {boolean} true when the message opens a step.
 */
function isStepMessage(message) {
  return message.parts.some(
    (part) =>
      part.kind === 'step-start' ||
      part.kind === 'reasoning' ||
      part.kind === 'text' ||
      part.kind === 'tool' ||
      part.kind === 'file',
  );
}

/**
 * Serialize one tool's arguments for the `tool/call` event and the content block.
 *
 * The source stores `state.input` as a parsed object (every observed row), so
 * the model's original whitespace is already gone at the source; re-serializing
 * is the closest available form and is counted. A raw string is kept verbatim
 * when it is valid JSON, which is the case for tools still running.
 *
 * @param {import('../source/model.js').SourcePart} part - tool part.
 * @param {object} stats - stats object to update.
 * @param {import('../core/warnings.js').WarningLog} warn - warning sink.
 * @param {string} sessionId - source session id.
 * @returns {string} a JSON string suitable for `ToolCallBlock.arguments`.
 */
function serializeArguments(part, stats, warn, sessionId) {
  const input = part.input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed !== '') {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
          stats.toolArguments.verbatim += 1;
          return input;
        }
      } catch {
        /* fall through to the wrapped form below */
      }
    }
    stats.toolArguments.wrapped += 1;
    warn?.add(
      'tool-arguments-not-json',
      '工具入参不是合法 JSON 对象，已按原样包装为 {"_raw": …}，以保证 tool/call 事件合法',
      { sessionId, where: part.id, detail: { tool: part.toolName, status: part.status } },
    );
    return JSON.stringify({ _raw: input });
  }
  if (input === undefined || input === null) {
    stats.toolArguments.absent += 1;
    return '{}';
  }
  stats.toolArguments.reserialized += 1;
  return JSON.stringify(input);
}

/**
 * Build the DSH result text and error flag for one source tool part.
 *
 * @param {import('../source/model.js').SourcePart} part - tool part.
 * @param {object} stats - stats object to update.
 * @returns {{ text: string, isError: boolean, synthetic: 'none'|'outcome-unknown'|'not-started' }} result facts.
 */
function toolOutcome(part, stats) {
  const status = part.status ?? 'completed';
  if (status === 'error') {
    stats.toolErrors += 1;
    const text = part.error ?? part.output ?? '';
    return {
      text: text === '' ? EMPTY_TOOL_OUTPUT : text,
      isError: true,
      synthetic: 'none',
    };
  }
  if (status === 'running' || status === 'pending') {
    // The source never recorded an outcome. DSH marks exactly this state with
    // TOOL_OUTCOME_UNKNOWN when it recovers a crashed turn.
    stats.toolResultsSynthesized += 1;
    return {
      text:
        '该工具调用在 ZCode 源会话中没有记录结果（源侧状态：' +
        status +
        '）。它的真实结果未知。按工具语义决定是否重试：只读或幂等的操作可以重试；可能有副作用的操作应先确认外部状态。',
      isError: true,
      synthetic: 'outcome-unknown',
    };
  }
  const output = typeof part.output === 'string' ? part.output : '';
  if (output === '') {
    stats.emptyOutputs += 1;
    return { text: EMPTY_TOOL_OUTPUT, isError: false, synthetic: 'none' };
  }
  return { text: output, isError: false, synthetic: 'none' };
}

/**
 * Build the placeholder text for a file/attachment part (FR-2.3).
 *
 * The bytes live in ZCode's artifact store and are deliberately not copied; the
 * reference and its metadata are preserved in text so the history still shows
 * that an attachment existed and what it was.
 *
 * @param {import('../source/model.js').SourcePart} part - file part.
 * @returns {string} placeholder text.
 */
function filePlaceholder(part) {
  const kind = part.mime ?? '未知类型';
  const ref = part.url !== undefined ? ` ${part.url}` : '';
  const size = part.fileMeta?.sizeBytes;
  const sizeNote = typeof size === 'number' ? `, ${size} B` : '';
  return `[附件：${kind}${sizeNote}]${ref}（附件二进制未随会话迁移，仅保留引用与元信息）`;
}

/**
 * Resolve the provider/model identity recorded on an assistant message.
 *
 * @param {import('../source/model.js').SourceMessage} message - assistant message.
 * @param {import('../source/model.js').SourceSession} session - owning session.
 * @param {object} stats - stats object (unused today, kept for symmetry).
 * @param {import('../core/warnings.js').WarningLog} warn - warning sink.
 * @param {Set<string>} reported - dedupes the warning per session.
 * @returns {{ provider: string, model: string }} identity for `ModelMessageSource`.
 */
function resolveProvenance(message, session, stats, warn, reported) {
  const provider = message.meta.provider ?? session.meta.provider ?? null;
  const model = message.meta.model ?? session.meta.model ?? null;
  if (typeof provider === 'string' && typeof model === 'string' && provider !== '' && model !== '') {
    return { provider, model };
  }
  if (!reported.has('provenance')) {
    reported.add('provenance');
    warn?.add(
      'assistant-provenance-missing',
      '源会话未记录 assistant 消息的 provider/model，已使用占位身份；历史内容不受影响',
      { sessionId: session.id, detail: { messageId: message.id } },
    );
  }
  return { provider: provider ?? PLUGIN_TAG, model: model ?? 'unknown' };
}

/**
 * Synthesize the `stream` records a v3 `assistant/message` carries.
 *
 * v3 stores a message's timed deltas inline instead of as separate
 * `assistant/chunk` events. A migrated message never had that timing — the
 * source kept whole blocks — so each content block becomes one run with a single
 * member and an empty gap list. That states the truth ("this text arrived in one
 * piece") instead of inventing a delta shape, and it is what the runtime looks
 * for when it replays or reformats the record.
 *
 * @param {object[]} blocks - the assistant message's content blocks.
 * @param {number} time - epoch ms stamped on the message.
 * @returns {object[]} stream records, one per block that a stream can describe.
 */
export function synthesizeStream(blocks, time) {
  /** @type {object[]} */
  const stream = [];
  blocks.forEach((block, index) => {
    if (block.type === 'reasoning' || block.type === 'text') {
      stream.push({ type: `${block.type}-chunks`, time0: time, index, dt: [], texts: [block.text] });
      return;
    }
    if (block.type === 'tool-call') {
      stream.push({
        type: 'tool-call-chunks',
        time0: time,
        index,
        dt: [],
        id: block.id,
        ...(typeof block.name === 'string' ? { name: block.name } : {}),
        args: [block.arguments],
      });
    }
    // Any other block carries no model deltas, so it has no stream member.
  });
  return stream;
}

/**
 * Plan one source session's DSH events.
 *
 * @param {import('../source/model.js').SourceSession} session - normalized source session.
 * @param {object} [options] - `{ warn, variant, formatVersion }`.
 * @returns {object} plan: header, events, per-turn digests, stats.
 */
export function planSession(session, options = {}) {
  /** @type {import('../core/warnings.js').WarningLog|undefined} */
  const warn = options.warn;
  const variant = typeof options.variant === 'string' ? options.variant : '';
  // The host decides the format: a service-generation backend reads v0, a
  // handle-generation one reads v3. Defaulting to the older value keeps every
  // caller that does not care (unit tests, dry runs) on the historical shape.
  const formatVersion = Number.isFinite(options.formatVersion)
    ? Number(options.formatVersion)
    : LEGACY_SESSION_FORMAT_VERSION;
  const stats = createStats();
  const reported = new Set();

  const targetId = targetSessionId(session.id, variant);
  const fallbackTime = session.updatedAt || session.createdAt || Date.now();

  /** @type {Array<object>} */
  const events = [];
  let seq = 0;

  /**
   * Append one event, stamping the monotonic seq.
   * @param {string} type - DSH event type (core vocabulary only, FR-4.3).
   * @param {object} data - event data.
   * @param {number} time - epoch ms.
   * @param {object} [extra] - `surfaceOp` / `sourceEventSeqs` for surface events.
   * @returns {object} the appended event.
   */
  const push = (type, data, time, extra) => {
    const event = {
      type,
      seq: seq++,
      time: Number.isFinite(time) ? Math.max(0, Math.floor(time)) : fallbackTime,
      data,
      ...(extra ?? {}),
    };
    events.push(event);
    return event;
  };

  // ---------------------------------------------------------------- title
  // Log-only and pinned (`source.kind: 'user'`), so DSH never regenerates it:
  // the whole point is to keep the source session's own title.
  if (typeof session.title === 'string' && session.title.trim() !== '') {
    push('session/title', { title: session.title, messageSeqs: [], source: { kind: 'user' } }, session.createdAt || fallbackTime);
  } else {
    warn?.add('title-missing', '源会话没有标题，已交由 DSH 依据首条消息自动生成', { sessionId: session.id });
  }

  // ---------------------------------------------------------------- turns
  const groups = groupIntoTurns(session.messages);
  /** @type {Array<{ turn: number, digest: string, eventStart: number, eventCount: number }>} */
  const turns = [];

  for (const group of groups) {
    const turn = stats.turns + 1;
    /** @type {import('../source/model.js').SourceMessage[]} */
    const pendingUsers = [];
    const turnStartIndex = events.length;
    const firstItem = group.items[0];
    const turnTime = firstItem?.time ?? fallbackTime;
    push('turn/start', { turn }, turnTime);
    stats.turns += 1;

    let step = 0;
    /** @type {string|undefined} */
    let lastFinish = undefined;

    for (const item of group.items) {
      if (item.role === 'user') {
        pendingUsers.push(item);
        continue;
      }

      if (!isStepMessage(item)) {
        stats.nonContentMessages += 1;
        continue;
      }

      step += 1;
      stats.steps += 1;
      const stepTime = pendingUsers[0]?.time ?? item.time ?? turnTime;
      push('step/start', { turn, step }, stepTime);

      // The prompt (or injected context) that produced this step is emitted
      // inside it, matching how a natively-recorded turn logs its input.
      for (const userMessage of pendingUsers) {
        emitUserMessage(userMessage, push, stats, warn, session, reported);
      }
      pendingUsers.length = 0;

      // Only a step that actually produced content speaks for the turn's outcome:
      // a discarded or marker-only step must not overwrite the finish recorded by
      // the last real model output.
      const producedContent = emitAssistantStep(item, turn, step, push, stats, warn, session, reported);
      if (typeof item.meta.finish === 'string' && producedContent) lastFinish = item.meta.finish;

      const stepEndTime = item.completedTime ?? item.parts.at(-1)?.time ?? item.time ?? stepTime;
      push('step/end', { turn, step }, stepEndTime);
    }

    // Messages the model never answered stay at the end of their turn: they are
    // real history, and dropping them would be a silent loss.
    for (const userMessage of pendingUsers) {
      emitUserMessage(userMessage, push, stats, warn, session, reported);
    }

    const endTime = group.items.at(-1)?.completedTime ?? group.items.at(-1)?.time ?? turnTime;
    push('turn/end', { turn, reason: turnEndReason(lastFinish, stats, warn, session) }, endTime);

    const turnEvents = events.slice(turnStartIndex);
    turns.push({
      turn,
      // Filled in below from the shared turn splitter, so the digest recorded
      // here and the one reconciliation computes from a stored log can never
      // drift apart (see `transform/event-log`).
      digest: '',
      eventStart: turnStartIndex,
      eventCount: turnEvents.length,
    });
  }

  // One owner for "what content is in this log": `splitTurns` slices the log and
  // digests each turn's content, and reconciliation runs the same function on
  // the stored side.
  const logParts = splitTurns(events);
  if (logParts.turns.length !== turns.length) {
    // Should be unreachable (every planned turn is bracketed). A silently wrong
    // digest would surface as a perpetual conflict, so fail loudly instead.
    throw new Error(
      `planner invariant broken: ${logParts.turns.length} turn slices for ${turns.length} planned turns`,
    );
  }
  for (const [index, slice] of logParts.turns.entries()) turns[index].digest = slice.digest;

  stats.events = events.length;
  reportDegradations(stats, warn, session);
  return {
    sourceId: session.id,
    targetId,
    variant,
    title: session.title,
    titleTime: session.updatedAt || session.createdAt || fallbackTime,
    cwd: session.directory,
    header: {
      version: formatVersion,
      id: targetId,
      createdAt: Number.isFinite(session.createdAt) && session.createdAt > 0 ? Math.floor(session.createdAt) : fallbackTime,
      ...(typeof session.directory === 'string' && session.directory !== '' ? { cwd: session.directory } : {}),
      delegationDepth: 0,
      // v3 replaced `seedLength` with a boolean: a migrated session is a
      // complete standalone log, not one inherited through a seed.
      ...(formatVersion >= 3 ? { isSeeded: false } : {}),
    },
    events,
    turns,
    stats,
    digests: {
      content: sha256(stableStringify(events)),
      turns: turns.map((t) => t.digest),
    },
  };

  // ------------------------------------------------------------------ inner

  /**
   * Emit one `user/message` (FR-2).
   *
   * The source distinguishes human prompts from runtime-injected context
   * (`semantics.origin`); the distinction is carried into DSH's `source` so the
   * UI never attributes machine text to the human, while both remain ordinary
   * user-role history for the model (FR-5.1).
   *
   * @param {import('../source/model.js').SourceMessage} message - source message.
   * @param {Function} emit - event emitter.
   * @param {object} counters - stats.
   * @param {import('../core/warnings.js').WarningLog} log - warning sink.
   * @param {import('../source/model.js').SourceSession} owner - owning session.
   * @param {Set<string>} seen - per-session warning dedupe.
   */
  function emitUserMessage(message, emit, counters, log, owner, seen) {
    /** @type {object[]} */
    const content = [];
    for (const part of message.parts) {
      switch (part.kind) {
        case 'text': {
          if (part.text === '') {
            counters.emptyTextSkipped += 1;
            break;
          }
          content.push({ type: 'text', text: part.text });
          counters.textBlocks += 1;
          break;
        }
        case 'file': {
          counters.files += 1;
          counters.filePlaceholders += 1;
          content.push({ type: 'text', text: filePlaceholder(part) });
          counters.textBlocks += 1;
          break;
        }
        case 'timeline':
        case 'compaction': {
          counters.markersSkipped += 1;
          break;
        }
        case 'text_placeholder':
        default: {
          if (part.kind === 'unknown') {
            counters.unknownParts += 1;
            if (!seen.has(`unknown:${part.raw?.type}`)) {
              seen.add(`unknown:${part.raw?.type}`);
              log?.add('unknown-part-type', `遇到未知 part 类型，已跳过（内容不迁移）：${String(part.raw?.type)}`, {
                sessionId: owner.id,
                where: part.id,
              });
            }
          } else if (part.kind !== 'step-start' && part.kind !== 'step-finish' && part.kind !== 'tool' && part.kind !== 'reasoning') {
            counters.markersSkipped += 1;
          }
          break;
        }
      }
    }

    if (content.length === 0) {
      counters.placeholderMessages += 1;
      content.push({ type: 'text', text: EMPTY_MESSAGE });
      log?.add('empty-user-message', '该用户消息在源侧没有可迁移内容，已写入占位文本（保证续聊时请求合法）', {
        sessionId: owner.id,
        where: message.id,
        severity: 'info',
      });
    }

    const injected = message.meta.origin !== undefined && message.meta.origin !== 'real_user';
    counters.userMessages += 1;
    if (injected) counters.injectedMessages += 1;

    // Built conditionally rather than with `form: undefined`: DSH rejects a batch
    // whose data is not *losslessly* JSON-serializable, and an explicit undefined
    // member is not (it would silently vanish on write).
    const source = injected
      ? {
          kind: 'plugin',
          plugin: PLUGIN_TAG,
          ...(message.meta.semanticsKind === 'compact_summary' ? { form: 'recall' } : {}),
        }
      : { kind: 'user' };

    emit(
      'user/message',
      {
        id: messageId(owner.id, injected ? 'injected' : 'user', message.id),
        role: 'user',
        content,
        source,
      },
      message.time ?? fallbackTime,
      { surfaceOp: 'append' },
    );
  }

  /**
   * Emit one assistant step's message, tool calls, and tool results (FR-2.1/2.2).
   *
   * @param {import('../source/model.js').SourceMessage} message - assistant message.
   * @param {number} turnNo - enclosing turn number.
   * @param {number} stepNo - step number within the turn.
   * @param {Function} emit - event emitter.
   * @param {object} counters - stats.
   * @param {import('../core/warnings.js').WarningLog} log - warning sink.
   * @param {import('../source/model.js').SourceSession} owner - owning session.
   * @param {Set<string>} seen - per-session warning dedupe.
   * @returns {boolean} whether the step produced an assistant message.
   */
  function emitAssistantStep(message, turnNo, stepNo, emit, counters, log, owner, seen) {
    /** @type {object[]} */
    const blocks = [];
    /**
     * Tool parts with their call identity and already-serialized arguments.
     * Serializing once here is what keeps the content block and the `tool/call`
     * event byte-identical, and keeps the report's counters about the source
     * (one per tool) rather than about the two places the value is emitted.
     * @type {Array<{part: import('../source/model.js').SourcePart, callId: string, args: string}>}
     */
    const tools = [];

    for (const part of message.parts) {
      switch (part.kind) {
        case 'reasoning': {
          if (part.text === '') {
            // FR-3.4: the source itself dropped it (third-party provider
            // filtering). Counted, never invented.
            counters.emptyReasoning += 1;
            break;
          }
          blocks.push({ type: 'reasoning', text: part.text });
          counters.reasoningBlocks += 1;
          counters.reasoningChars += part.text.length;
          break;
        }
        case 'text': {
          if (part.text === '') {
            counters.emptyTextSkipped += 1;
            break;
          }
          blocks.push({ type: 'text', text: part.text });
          counters.textBlocks += 1;
          break;
        }
        case 'tool': {
          const callId = part.callId ?? `zcode-call-${part.id}`;
          const args = serializeArguments(part, counters, log, owner.id);
          const toolName = part.toolName ?? 'unknown-tool';
          tools.push({ part, callId, args });
          counters.toolCalls += 1;
          blocks.push({ type: 'tool-call', id: callId, name: toolName, arguments: args });
          break;
        }
        case 'file': {
          // An assistant-side attachment: preserved as a reference, counted like
          // a user-side one.
          counters.files += 1;
          counters.filePlaceholders += 1;
          blocks.push({ type: 'text', text: filePlaceholder(part) });
          counters.textBlocks += 1;
          break;
        }
        case 'step-start':
        case 'step-finish': {
          break; // structural: already represented by step/start … step/end
        }
        case 'timeline':
        case 'compaction': {
          counters.markersSkipped += 1;
          break;
        }
        default: {
          counters.unknownParts += 1;
          if (!seen.has(`unknown:${part.raw?.type}`)) {
            seen.add(`unknown:${part.raw?.type}`);
            log?.add('unknown-part-type', `遇到未知 part 类型，已跳过（内容不迁移）：${String(part.raw?.type)}`, {
              sessionId: owner.id,
              where: part.id,
            });
          }
          break;
        }
      }
    }

    const provenance = resolveProvenance(message, owner, counters, log, seen);
    const usage = normalizeUsageLocal(message.meta.tokens);

    if (blocks.length === 0) {
      // A step whose stream was discarded, or that only ever carried markers.
      // The step boundary is kept so the source's step count survives; there is
      // no assistant message to emit.
      counters.emptySteps += 1;
      return false;
    }

    const messageTime = message.completedTime ?? message.time ?? fallbackTime;
    emit(
      'assistant/message',
      {
        turn: turnNo,
        step: stepNo,
        message: {
          id: messageId(owner.id, 'assistant', message.id),
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: provenance.provider, model: provenance.model },
        },
        // v3 keeps the message's stream inline rather than as separate chunk
        // events, so a v0-shaped event would be rejected for the missing field.
        ...(formatVersion >= 3 ? { stream: synthesizeStream(blocks, messageTime) } : {}),
        ...(usage !== undefined ? { usage } : {}),
      },
      messageTime,
      { surfaceOp: 'append' },
    );
    counters.assistantMessages += 1;

    for (const { part, callId, args } of tools) {
      const callTime = part.time ?? message.time ?? fallbackTime;
      const callEvent = emit(
        'tool/call',
        {
          turn: turnNo,
          step: stepNo,
          callId,
          name: part.toolName ?? 'unknown-tool',
          arguments: args,
        },
        callTime,
      );

      const outcome = toolOutcome(part, counters);
      emit(
        'tool/result',
        {
          turn: turnNo,
          step: stepNo,
          message: {
            id: messageId(owner.id, 'tool-result', part.id),
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: callId,
                content: [{ type: 'text', text: outcome.text }],
                isError: outcome.isError,
              },
            ],
            source: { kind: 'tool', callId },
          },
          ...(outcome.synthetic === 'outcome-unknown'
            ? { error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN } }
            : outcome.synthetic === 'not-started'
              ? { error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED } }
              : {}),
        },
        part.toolEndTime ?? callTime,
        { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] },
      );
    }
    return true;
  }
}

/**
 * Local token-usage normalizer (kept beside the transform so this module has no
 * source-layer import beyond the model typedefs).
 *
 * Accepts both shapes the sources use: ZCode's SQLite store records
 * `{ input, output, reasoning, cache: { read, write } }`, while the rollout
 * model-I/O log records already-DSH-shaped `{ inputTokens, outputTokens,
 * reasoningTokens, cacheReadTokens }`.
 *
 * @param {unknown} tokens - raw token record.
 * @returns {object|undefined} DSH-shaped usage.
 */
function normalizeUsageLocal(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined;
  const t = /** @type {any} */ (tokens);
  const cache = t.cache ?? {};
  const num = (...candidates) => {
    for (const candidate of candidates) if (typeof candidate === 'number') return candidate;
    return undefined;
  };
  const usage = {};
  const input = num(t.input, t.inputTokens);
  const output = num(t.output, t.outputTokens);
  const reasoning = num(t.reasoning, t.reasoningTokens);
  const cacheRead = num(cache.read, t.cacheReadTokens);
  const cacheWrite = num(cache.write, t.cacheWriteTokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Emit the aggregate "something degraded" warnings a session deserves.
 *
 * These are per-session summaries rather than per-item entries: 141 attachment
 * placeholders in one session must be visible in the report (FR-2.3) without
 * burying every other warning under them.
 *
 * @param {object} stats - completed stats object.
 * @param {import('../core/warnings.js').WarningLog} warn - warning sink.
 * @param {import('../source/model.js').SourceSession} session - owning session.
 * @returns {void}
 */
function reportDegradations(stats, warn, session) {
  if (stats.filePlaceholders > 0) {
    warn?.add(
      'attachment-placeholder',
      `${stats.filePlaceholders} 个附件未能迁移二进制内容，已按占位文本保留引用与元信息（FR-2.3）`,
      { sessionId: session.id, severity: 'info', detail: { count: stats.filePlaceholders } },
    );
  }
  if (stats.toolResultsSynthesized > 0) {
    warn?.add(
      'tool-result-synthesized',
      `${stats.toolResultsSynthesized} 个工具调用在源会话中没有结果，已按 DSH 的 TOOL_OUTCOME_UNKNOWN 约定合成占位结果（FR-4.2）`,
      { sessionId: session.id, severity: 'warning', detail: { count: stats.toolResultsSynthesized } },
    );
  }
  if (stats.emptyOutputs > 0) {
    warn?.add(
      'tool-output-empty',
      `${stats.emptyOutputs} 个工具调用在源会话中结果为空串，已写入占位文本以保证续聊时请求合法`,
      { sessionId: session.id, severity: 'info', detail: { count: stats.emptyOutputs } },
    );
  }
}

/**
 * Decide a turn's `turn/end` reason from the last recorded finish value.
 *
 * @param {string|undefined} finish - last assistant `finish` in the turn.
 * @param {object} stats - stats object.
 * @param {import('../core/warnings.js').WarningLog} warn - warning sink.
 * @param {import('../source/model.js').SourceSession} session - owning session.
 * @returns {object} a `TurnEndReason`.
 */
function turnEndReason(finish, stats, warn, session) {
  if (finish === undefined) return { kind: 'completed' };
  const mapped = TURN_END_BY_FINISH.get(finish);
  if (mapped !== undefined) return mapped;
  if (finish === 'failed') {
    warn?.add('turn-failed', '源会话中该回合以失败结束，已迁移为 DSH 的 error 结束原因（原始错误文本源侧未保留）', {
      sessionId: session.id,
      severity: 'info',
    });
    return { kind: 'error', error: { message: 'ZCode 源会话记录该回合 finish=failed', code: 'UNKNOWN' } };
  }
  warn?.add('turn-end-unmapped', `未知的源侧 finish 值「${finish}」，已按 completed 迁移`, {
    sessionId: session.id,
    severity: 'info',
  });
  return { kind: 'completed' };
}
