/**
 * The structural validator must actually reject what it claims to reject.
 *
 * Every case here is a corruption a plausible refactor could introduce, so the
 * assertions are about the *diagnosis* as much as the rejection: a validator
 * that only says "invalid" would leave the next person guessing.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { validateEventLog, isLosslessJson } from '../src/transform/validate.js';

/** A minimal, valid log to mutate in each case. */
function baseLog() {
  return [
    { type: 'session/title', seq: 0, time: 1, data: { title: 't', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 3,
      time: 1,
      data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a',
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'r' }, { type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      surfaceOp: 'append',
    },
    { type: 'tool/call', seq: 5, time: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 6,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tr',
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [5],
    },
    { type: 'step/end', seq: 7, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

describe('structured event log validation (AC-2)', () => {
  it('accepts a well-formed log', () => {
    const verdict = validateEventLog(baseLog());
    assert.equal(verdict.ok, true, verdict.errors.join('\n'));
    assert.deepEqual(verdict.stats, {
      turns: 1,
      steps: 1,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      surfaceEvents: 3,
    });
  });

  it('rejects a seq gap', () => {
    const log = baseLog();
    log[4].seq = 99;
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /seq 不连续/);
  });

  it('rejects a turn that never closes', () => {
    const verdict = validateEventLog(baseLog().slice(0, 8));
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /turn 1 仍未关闭/);
  });

  it('rejects a step closed after its turn', () => {
    const log = baseLog();
    [log[7], log[8]] = [log[8], log[7]];
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /step/);
  });

  it('rejects a turn/end while a step is still open', () => {
    const log = baseLog().filter((event) => !(event.type === 'step/end'));
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /尚未关闭/);
  });

  it('rejects a step whose number skips ahead', () => {
    const log = baseLog();
    log[2].data.step = 2;
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /step\/start 期望 step 1/);
  });

  it('rejects a tool/result with no preceding tool/call', () => {
    const log = baseLog().filter((event) => event.type !== 'tool/call');
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /没有先行的 tool\/call/);
  });

  it('rejects a tool/call left unanswered (FR-4.2)', () => {
    const log = baseLog().filter((event) => event.type !== 'tool/result');
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /未配对的工具调用/);
  });

  it('allows an outcome-unknown result to close a call, matching DSH crash recovery', () => {
    // Drop the call and its result, then renumber: the surviving synthetic result
    // is the only legal way to answer a call that has no `tool/call` behind it.
    const log = baseLog()
      .filter((event) => event.type !== 'tool/call' && event.type !== 'tool/result')
      .map((event, index) => ({ ...event, seq: index }));
    const assistant = log.find((event) => event.type === 'assistant/message');
    const insertAt = log.indexOf(assistant) + 1;
    log.splice(insertAt, 0, {
      type: 'tool/result',
      seq: insertAt,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tr',
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'unknown' }], isError: true }],
          source: { kind: 'tool', callId: 'c1' },
        },
        error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
      },
      surfaceOp: 'append',
    });
    const renumbered = log.map((event, index) => ({ ...event, seq: index }));

    const verdict = validateEventLog(renumbered);
    assert.equal(verdict.ok, true, verdict.errors.join('\n'));

    // The same shape *without* the recovery code must be refused.
    const plain = renumbered.map((event) =>
      event.type === 'tool/result' ? { ...event, data: { ...event.data, error: undefined } } : event,
    );
    assert.equal(validateEventLog(plain).ok, false);
  });

  it('rejects a surface event without a surface operation', () => {
    const log = baseLog();
    delete log[4].surfaceOp;
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /缺少 surfaceOp/);
  });

  it('rejects a surface operation on a log-only event', () => {
    const log = baseLog();
    log[5].surfaceOp = 'append';
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /非 surface 事件不应携带 surfaceOp/);
  });

  it('rejects an event outside the core vocabulary (FR-4.3)', () => {
    const log = baseLog();
    log.push({ type: 'zcode/something', seq: 9, time: 1, data: {} });
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /非 DSH 内置事件类型/);
  });

  it('rejects an empty message, which no provider would accept', () => {
    const log = baseLog();
    log[3].data.content = [];
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /内容为空/);
  });

  it('rejects data that DSH would refuse to persist', () => {
    const log = baseLog();
    log[3].data.source = { kind: 'plugin', plugin: 'x', form: undefined };
    const verdict = validateEventLog(log);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.join('\n'), /不是无损 JSON/);
  });
});

describe('lossless JSON check', () => {
  it('accepts the JSON value space', () => {
    assert.equal(isLosslessJson(null), true);
    assert.equal(isLosslessJson('x'), true);
    assert.equal(isLosslessJson(0), true);
    assert.equal(isLosslessJson([1, 'a', { b: null }]), true);
  });

  it('rejects everything JSON would change or drop', () => {
    assert.equal(isLosslessJson(undefined), false);
    assert.equal(isLosslessJson(Number.NaN), false);
    assert.equal(isLosslessJson(Number.POSITIVE_INFINITY), false);
    assert.equal(isLosslessJson({ a: undefined }), false);
    assert.equal(isLosslessJson({ a: () => {} }), false);
    assert.equal(isLosslessJson({ a: 1n }), false);
    assert.equal(isLosslessJson(new Date()), false, 'a non-plain object never round-trips');
  });
});
