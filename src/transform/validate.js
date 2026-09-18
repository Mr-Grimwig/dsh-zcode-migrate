/**
 * Structural validation of a planned event log (AC-2).
 *
 * This mirrors the relational invariants that `@deepseek-ai/dsh-session`'s
 * companion enforces at runtime, so the plugin can prove — standalone, offline,
 * and in tests — that what it is about to write is a log DSH will accept and be
 * able to resume:
 *
 * - `seq` starts at 0 and strictly increases by one;
 * - turns open at 1 and increase by one, never nest, and always close;
 * - steps open at 1 inside their turn, never nest, and close before `turn/end`;
 * - every `step/start`…`step/end` bracket contains at most one
 *   `assistant/message`, and all step-scoped events name the open step;
 * - every `tool/call` is answered by exactly one `tool/result` in the same step,
 *   and no `tool/result` names a call that was never made;
 * - message-producing events carry a surface operation, log-only events do not;
 * - only the core event vocabulary appears (FR-4.3).
 *
 * It is deliberately independent of DSH's own implementation: the point is to
 * catch a regression in *our* transform, not to re-run the harness's checks.
 *
 * @module dsh-zcode-migrate/transform/validate
 */

/** The core DSH event vocabulary this plugin is allowed to write (FR-4.3). */
export const CORE_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'request/header',
  'request/context',
  'session/end-seed',
  'session/title',
]);

/** Event types that must carry `surfaceOp`. */
export const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/**
 * Whether a value survives a `JSON.parse(JSON.stringify(value))` round trip
 * unchanged — DSH's `isJsonValue` contract, which it enforces when a batch is
 * appended.
 *
 * Checked here so a mistake surfaces during planning, with the offending event
 * named, instead of as a backend rejection of the whole batch. An explicit
 * `undefined` member is the easy one to write by accident and the hardest to
 * see: it disappears on write, so the stored log would differ from the plan.
 *
 * @param {unknown} value - candidate value.
 * @returns {boolean} true when the value is losslessly JSON-serializable.
 */
export function isLosslessJson(value) {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false; // undefined, function, symbol, bigint
  }
  if (Array.isArray(value)) {
    for (const item of value) if (!isLosslessJson(item)) return false;
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Object.keys(value)) {
    if (!isLosslessJson(value[key])) return false;
  }
  return true;
}

/**
 * Find the first non-JSON-serializable event, if any.
 *
 * @param {object[]} events - events in log order.
 * @returns {string|undefined} a description of the offender.
 */
function findNonSerializable(events) {
  for (const event of events) {
    if (isLosslessJson(event.data)) continue;
    const describe = (value) => {
      if (value === undefined) return 'undefined';
      if (typeof value === 'number') return String(value);
      return typeof value;
    };
    let offender = 'unknown member';
    if (event.data !== null && typeof event.data === 'object') {
      for (const [key, value] of Object.entries(event.data)) {
        if (!isLosslessJson(value)) {
          offender = `${key}: ${describe(value)}`;
          break;
        }
      }
    }
    return `seq=${event.seq} ${event.type} 的 data 不是无损 JSON（${offender}）——DSH 会拒绝整批写入`;
  }
  return undefined;
}

/**
 * Validate a planned event log.
 *
 * @param {Array<object>} events - events in log order, as produced by `planSession`.
 * @param {object} [options] - `{ requireAllEvents: boolean }`.
 * @returns {{ ok: boolean, errors: string[], stats: object }} verdict plus derived counts.
 */
export function validateEventLog(events, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const fail = (message) => errors.push(message);

  const nonSerializable = findNonSerializable(events);
  if (nonSerializable !== undefined) fail(nonSerializable);

  const requireAll = options.requireAllEvents !== false;
  /** @type {number|null} */
  let openTurn = null;
  /** @type {number|null} */
  let openStep = null;
  let nextTurn = 1;
  let nextStep = 1;
  let lastSeq = -1;
  /** @type {Set<string>} */
  let pendingCalls = new Set();
  let inStepAssistantMessage = false;
  let currentStepCallIds = new Set();
  const stats = {
    turns: 0,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    surfaceEvents: 0,
  };

  for (const [index, event] of events.entries()) {
    if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number') {
      fail(`#${index}: 事件缺少 type/seq/time`);
      continue;
    }
    if (requireAll && !CORE_EVENT_TYPES.has(event.type)) {
      fail(`#${index} seq=${event.seq}: 非 DSH 内置事件类型 ${event.type}（FR-4.3）`);
    }
    if (event.seq !== lastSeq + 1) {
      fail(`#${index}: seq 不连续，期望 ${lastSeq + 1}，实际 ${event.seq}`);
    }
    lastSeq = event.seq;

    const isSurface = SURFACE_EVENT_TYPES.has(event.type);
    if (isSurface) {
      stats.surfaceEvents += 1;
      if (event.surfaceOp === undefined) fail(`seq=${event.seq} ${event.type}: 缺少 surfaceOp`);
    } else if (event.surfaceOp !== undefined) {
      fail(`seq=${event.seq} ${event.type}: 非 surface 事件不应携带 surfaceOp`);
    }

    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start': {
        if (openTurn !== null) fail(`seq=${event.seq}: turn/start ${data.turn} 时 turn ${openTurn} 尚未关闭`);
        if (data.turn !== nextTurn) fail(`seq=${event.seq}: turn/start 期望 turn ${nextTurn}，实际 ${data.turn}`);
        openTurn = data.turn;
        nextStep = 1;
        stats.turns += 1;
        break;
      }
      case 'turn/end': {
        if (openTurn !== data.turn) fail(`seq=${event.seq}: turn/end ${data.turn} 与打开的 turn ${openTurn} 不符`);
        if (openStep !== null) fail(`seq=${event.seq}: turn/end ${data.turn} 时 step ${openStep} 尚未关闭`);
        if (data.reason === undefined || typeof data.reason.kind !== 'string') {
          fail(`seq=${event.seq}: turn/end 缺少 reason.kind`);
        }
        openTurn = null;
        nextTurn += 1;
        break;
      }
      case 'step/start': {
        if (openTurn !== data.turn) fail(`seq=${event.seq}: step/start 的 turn ${data.turn} 不是打开的 turn ${openTurn}`);
        if (openStep !== null) fail(`seq=${event.seq}: step/start ${data.step} 时 step ${openStep} 尚未关闭`);
        if (data.step !== nextStep) fail(`seq=${event.seq}: step/start 期望 step ${nextStep}，实际 ${data.step}`);
        openStep = data.step;
        inStepAssistantMessage = false;
        currentStepCallIds = new Set();
        pendingCalls = new Set();
        stats.steps += 1;
        break;
      }
      case 'step/end': {
        if (openTurn !== data.turn || openStep !== data.step) {
          fail(`seq=${event.seq}: step/end 命名 turn ${data.turn}/step ${data.step}，但打开的是 turn ${openTurn}/step ${openStep}`);
        }
        if (pendingCalls.size > 0) fail(`seq=${event.seq}: step/end 时仍有未配对的工具调用 ${[...pendingCalls].join(', ')}`);
        openStep = null;
        nextStep += 1;
        pendingCalls = new Set();
        currentStepCallIds = new Set();
        break;
      }
      case 'user/message': {
        if (openTurn === null) fail(`seq=${event.seq}: user/message 出现在任何 turn 之外`);
        if (!Array.isArray(data.content) || data.content.length === 0) fail(`seq=${event.seq}: user/message 内容为空`);
        if (data.role !== 'user') fail(`seq=${event.seq}: user/message 的 role 必须是 user`);
        stats.userMessages += 1;
        break;
      }
      case 'assistant/message': {
        if (openTurn !== data.turn || openStep !== data.step) {
          fail(`seq=${event.seq}: assistant/message 不在其命名的 turn/step 内`);
        }
        if (inStepAssistantMessage) fail(`seq=${event.seq}: 同一 step 内出现第二条 assistant/message`);
        inStepAssistantMessage = true;
        const content = data.message?.content;
        if (!Array.isArray(content) || content.length === 0) fail(`seq=${event.seq}: assistant/message 内容为空`);
        if (data.message?.source?.kind !== 'model') fail(`seq=${event.seq}: assistant/message 缺少 model source`);
        if (data.message?.source?.provider === undefined || data.message?.source?.model === undefined) {
          fail(`seq=${event.seq}: assistant/message 缺少 provider/model`);
        }
        // A tool-call block must have a following tool/call event with the same id.
        for (const block of content ?? []) {
          if (block.type === 'tool-call') currentStepCallIds.add(block.id);
          if (block.type === 'reasoning' || block.type === 'text') {
            if (typeof block.text !== 'string') fail(`seq=${event.seq}: ${block.type} 块的 text 不是字符串`);
          }
        }
        stats.assistantMessages += 1;
        break;
      }
      case 'tool/call': {
        if (openTurn !== data.turn || openStep !== data.step) {
          fail(`seq=${event.seq}: tool/call 不在其命名的 turn/step 内`);
        }
        if (typeof data.arguments !== 'string') fail(`seq=${event.seq}: tool/call.arguments 必须是字符串`);
        pendingCalls.add(data.callId);
        stats.toolCalls += 1;
        break;
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId;
        const synthetic = data.message?.content?.[0]?.isError === true && data.error?.code === 'TOOL_NOT_STARTED';
        if (pendingCalls.has(callId)) {
          pendingCalls.delete(callId);
        } else if (!synthetic && event.surfaceOp === 'append') {
          fail(`seq=${event.seq}: tool/result 对应的工具调用 ${callId} 没有先行的 tool/call`);
        }
        if (data.message?.source?.kind !== 'tool') fail(`seq=${event.seq}: tool/result 的 source.kind 必须是 tool`);
        const block = data.message?.content?.[0];
        if (block?.type !== 'tool-result') fail(`seq=${event.seq}: tool/result 的首个块必须是 tool-result`);
        if (block?.toolCallId !== callId) fail(`seq=${event.seq}: tool-result 的 callId 与 source 不一致`);
        stats.toolResults += 1;
        break;
      }
      case 'session/title': {
        if (typeof data.title !== 'string' || data.title === '') fail(`seq=${event.seq}: session/title 的标题为空`);
        break;
      }
      default:
        break;
    }
  }

  if (openTurn !== null) fail(`日志结束时 turn ${openTurn} 仍未关闭`);
  if (openStep !== null) fail(`日志结束时 step ${openStep} 仍未关闭`);
  if (pendingCalls.size > 0) fail(`日志结束时有未配对的工具调用：${[...pendingCalls].join(', ')}`);

  return { ok: errors.length === 0, errors, stats };
}
