/**
 * Fallback and legacy sources (FR-1.3, FR-1.4).
 *
 * The rollout reader is exercised on a hand-built transcript whose windows slide
 * the way ZCode's do — each call's request window contains the previous call's
 * response, and the newest response is in no window at all. The assertions check
 * exactly the properties that make the fallback worth having: reasoning is
 * recovered verbatim, tool calls are paired with the results that arrive in the
 * next window, the final response is still emitted, and the reader says out loud
 * what it cannot know.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { WarningLog } from '../src/core/warnings.js';
import { listRolloutSessions, readRolloutSession } from '../src/source/rollout-source.js';
import { listLegacySessions, readLegacySession } from '../src/source/legacy-source.js';
import { planSession } from '../src/transform/plan.js';
import { validateEventLog } from '../src/transform/validate.js';

const SESSION_ID = 'sess_rollout-1111-2222-3333-444444444444';
const CWD = 'D:\\code\\rollout-fixture';

/** One rollout line: a request window plus the response it produced. */
function line({ turnId, startedAt, offset, messages, reasoningText, text, toolCalls = [], finishReason = 'stop' }) {
  return {
    type: 'model_io',
    turnId,
    startedAt,
    completedAt: startedAt,
    model: { modelId: 'deepseek-v4-flash', providerId: 'provider-9' },
    request: { messageOffset: offset, messagesKind: 'tail', messages },
    response: { finishReason, reasoningText, text, toolCalls, usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 2 } },
  };
}

/** A transcript whose windows slide by the messages each call appended. */
function transcript() {
  const system = { role: 'system', content: `You are ZCode. {"cwd":"D:\\\\code\\\\rollout-fixture"}` };
  return [
    line({
      turnId: 'turn-1',
      startedAt: '2026-09-18T10:00:00.000Z',
      offset: 0,
      messages: [system, { role: 'user', content: '<system-reminder>注入的上下文</system-reminder>' }, { role: 'user', content: '第一个问题' }],
      reasoningText: '第一轮思路，逐字保留。',
      text: '第一轮回答',
      toolCalls: [{ id: 'call_a', name: 'Bash', input: { command: 'ls' } }],
      finishReason: 'tool-calls',
    }),
    line({
      turnId: 'turn-1',
      startedAt: '2026-09-18T10:00:05.000Z',
      offset: 3,
      messages: [
        // The previous response, now visible as history, plus the tool result it asked for.
        { role: 'assistant', content: [{ type: 'reasoning', text: '第一轮思路，逐字保留。' }], toolCalls: [{ id: 'call_a', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'tool', toolCallId: 'call_a', toolName: 'Bash', content: 'file-a\nfile-b', isError: false },
      ],
      reasoningText: '第二轮思路：看到结果了。',
      text: '第二轮回答',
      finishReason: 'stop',
    }),
    line({
      turnId: 'turn-2',
      startedAt: '2026-09-18T10:01:00.000Z',
      offset: 5,
      messages: [
        { role: 'assistant', content: [{ type: 'reasoning', text: '第二轮思路：看到结果了。' }] },
        { role: 'user', content: '第二个问题：换个话题' },
      ],
      reasoningText: '第三轮思路（只存在于最后一行）。',
      text: '第三轮回答',
      toolCalls: [{ id: 'call_b', name: 'Read', input: { file_path: 'x.txt' } }],
      finishReason: 'tool-calls',
    }),
  ];
}

/** Write a transcript to a scratch ZCode home. */
function writeTranscript(home) {
  mkdirSync(join(home, 'cli', 'rollout'), { recursive: true });
  const path = join(home, 'cli', 'rollout', `model-io-${SESSION_ID}.jsonl`);
  writeFileSync(path, `${transcript().map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return path;
}

describe('rollout fallback source (FR-1.3)', () => {
  /** @type {string} */
  let home;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'zcm-rollout-'));
    writeTranscript(home);
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('lists transcripts by session id', () => {
    const sessions = listRolloutSessions(home, { warn: new WarningLog() });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, SESSION_ID);
    assert.equal(sessions[0].sourceKind, 'rollout');
  });

  it('merges the request windows into one transcript, without duplicating a response', () => {
    const session = readRolloutSession(home, SESSION_ID, { warn: new WarningLog() });
    assert.ok(session);
    const assistantMessages = session.messages.filter((message) => message.role === 'assistant');
    // Three calls produced three responses; each earlier response is visible in
    // the next window, and must be emitted exactly once.
    assert.equal(assistantMessages.length, 3, 'each response appears exactly once');
    const reasoningTexts = session.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === 'reasoning')
      .map((part) => part.text);
    assert.deepEqual(reasoningTexts, [
      '第一轮思路，逐字保留。',
      '第二轮思路：看到结果了。',
      '第三轮思路（只存在于最后一行）。',
    ]);
  });

  it('pairs a tool call with the result that arrives in the next window', () => {
    const session = readRolloutSession(home, SESSION_ID, { warn: new WarningLog() });
    const tools = session.messages.flatMap((message) => message.parts).filter((part) => part.kind === 'tool');
    const callA = tools.find((part) => part.callId === 'call_a');
    assert.equal(callA.status, 'completed');
    assert.equal(callA.output, 'file-a\nfile-b');
    assert.deepEqual(callA.input, { command: 'ls' });
    const callB = tools.find((part) => part.callId === 'call_b');
    assert.equal(callB.status, 'running', 'the final call never came back, so it stays unresolved for the planner');
  });

  it('recovers the working directory from the request window', () => {
    const session = readRolloutSession(home, SESSION_ID, { warn: new WarningLog() });
    assert.equal(session.directory, CWD);
  });

  it('says what it cannot know instead of guessing', () => {
    const warn = new WarningLog();
    const session = readRolloutSession(home, SESSION_ID, { warn });
    const codes = warn.items.map((item) => item.code);
    assert.ok(codes.includes('rollout-fallback'), 'the fallback must announce itself');
    assert.match(warn.items.find((item) => item.code === 'rollout-fallback').message, /时间由所属调用时间近似/);

    // The window's final user message is the prompt that call answered; the
    // earlier injected context is marked undetermined rather than attributed.
    const userMessages = session.messages.filter((message) => message.role === 'user');
    const origins = userMessages.map((message) => message.meta.origin);
    assert.ok(origins.includes('real_user'));
    assert.ok(origins.includes('rollout_undetermined'));
  });

  it('plans into a valid, resumable log, with the unresolved call answered synthetically', () => {
    const warn = new WarningLog();
    const session = readRolloutSession(home, SESSION_ID, { warn });
    const plan = planSession(session, { warn });
    assert.equal(validateEventLog(plan.events).ok, true);
    assert.equal(plan.stats.reasoningBlocks, 3);
    assert.equal(plan.stats.toolResultsSynthesized, 1);
    assert.equal(
      plan.events.filter((event) => event.type === 'turn/start').length,
      2,
      'a prompt after the model has spoken opens a new turn',
    );
    // Reasoning is byte-identical to what the transcript recorded.
    const blocks = plan.events
      .filter((event) => event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'reasoning')
      .map((block) => block.text);
    assert.equal(blocks.join('|'), transcript().map((record) => record.response.reasoningText).join('|'));
  });

  it('falls back with a warning when the rollout directory is absent', () => {
    const warn = new WarningLog();
    const sessions = listRolloutSessions(join(home, 'nope'), { warn });
    assert.deepEqual(sessions, []);
    assert.ok(warn.items.some((item) => item.code === 'rollout-dir-missing'));
  });

  it('tolerates a truncated transcript line', () => {
    const truncatedHome = mkdtempSync(join(tmpdir(), 'zcm-rollout2-'));
    try {
      mkdirSync(join(truncatedHome, 'cli', 'rollout'), { recursive: true });
      writeFileSync(
        join(truncatedHome, 'cli', 'rollout', `model-io-${SESSION_ID}.jsonl`),
        `${JSON.stringify(transcript()[0])}\n{"type":"model_io","turnId":"turn-1","req`,
        'utf8',
      );
      const warn = new WarningLog();
      const session = readRolloutSession(truncatedHome, SESSION_ID, { warn });
      assert.ok(session, 'a torn tail must not lose the complete records');
      assert.ok(warn.items.some((item) => item.code === 'rollout-malformed-lines'));
      assert.equal(planSession(session, { warn }).stats.reasoningBlocks, 1);
    } finally {
      rmSync(truncatedHome, { recursive: true, force: true });
    }
  });
});

describe('legacy projects source (FR-1.4)', () => {
  /** @type {string} */
  let home;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'zcm-legacy-'));
    const projectDir = join(home, 'projects', '-D-code-legacy');
    mkdirSync(projectDir, { recursive: true });
    const records = [
      { type: 'summary', summary: '旧版会话标题' },
      {
        type: 'user',
        uuid: 'l-u1',
        timestamp: '2026-01-02T03:00:00.000Z',
        cwd: CWD,
        message: { role: 'user', content: '旧版提问' },
      },
      {
        type: 'assistant',
        uuid: 'l-a1',
        timestamp: '2026-01-02T03:00:05.000Z',
        cwd: CWD,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [
            { type: 'thinking', thinking: '旧版思路，含 emoji 🧵 与代码 `a=1`。' },
            { type: 'text', text: '旧版回答' },
            { type: 'tool_use', id: 'legacy_call', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'l-u2',
        timestamp: '2026-01-02T03:00:06.000Z',
        cwd: CWD,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'legacy_call', content: 'hi\n', is_error: false }] },
      },
      {
        type: 'user',
        uuid: 'l-u3',
        timestamp: '2026-01-02T03:00:07.000Z',
        cwd: CWD,
        isMeta: true,
        message: { role: 'user', content: '注入的上下文' },
      },
      {
        type: 'assistant',
        uuid: 'l-a2',
        timestamp: '2026-01-02T03:00:08.000Z',
        cwd: CWD,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '第二段旧思路' }, { type: 'text', text: '收尾' }] },
      },
      { type: 'user', uuid: 'l-side', isSidechain: true, timestamp: '2026-01-02T03:00:09.000Z', message: { role: 'user', content: '子代理内容' } },
    ];
    writeFileSync(join(projectDir, 'legacy-session.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('lists legacy session files with a partial marker', () => {
    const sessions = listLegacySessions(home, { warn: new WarningLog() });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sourceKind, 'legacy');
    assert.equal(sessions[0].partial, true, 'best-effort must be labelled as such');
  });

  it('reads the Claude-compatible shape, including thinking blocks and tool results', () => {
    const warn = new WarningLog();
    const sessions = listLegacySessions(home, { warn });
    const session = readLegacySession(home, sessions[0].id, { warn });
    assert.ok(session);
    assert.equal(session.title, '旧版会话标题');
    assert.equal(session.directory, CWD, 'the cwd comes from the records, not the lossy directory name');

    const parts = session.messages.flatMap((message) => message.parts);
    const reasoning = parts.filter((part) => part.kind === 'reasoning').map((part) => part.text);
    assert.deepEqual(reasoning, ['旧版思路，含 emoji 🧵 与代码 `a=1`。', '第二段旧思路']);

    const tool = parts.find((part) => part.kind === 'tool');
    assert.equal(tool.callId, 'legacy_call');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.output, 'hi\n');

    assert.ok(
      !session.messages.some((message) => message.parts.some((part) => part.text === '子代理内容')),
      'sidechain records are not this session history',
    );
    assert.ok(
      session.messages.some((message) => message.meta.origin === 'legacy_meta'),
      'isMeta records are marked as injected rather than attributed to the human',
    );
    assert.ok(warn.items.some((item) => item.code === 'legacy-best-effort'));
  });

  it('plans into a valid log covering both thinking blocks', () => {
    const warn = new WarningLog();
    const sessions = listLegacySessions(home, { warn });
    const session = readLegacySession(home, sessions[0].id, { warn });
    const plan = planSession(session, { warn });
    assert.equal(validateEventLog(plan.events).ok, true);
    assert.equal(plan.stats.reasoningBlocks, 2);
    assert.equal(plan.stats.reasoningChars, '旧版思路，含 emoji 🧵 与代码 `a=1`。'.length + '第二段旧思路'.length);
  });

  it('warns rather than throws when the directory is absent', () => {
    const warn = new WarningLog();
    assert.deepEqual(listLegacySessions(join(home, 'missing'), { warn }), []);
    assert.ok(warn.items.some((item) => item.code === 'legacy-dir-missing'));
  });
});
