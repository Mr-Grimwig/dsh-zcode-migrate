/**
 * The transform: fidelity (FR-3), coverage (FR-2), pairing (FR-4.2), and the
 * rules that keep the log resumable (FR-4.1/4.3).
 *
 * The fidelity assertions are `===` on whole strings, including a 200 000-char
 * block and emoji/ZWJ sequences, because that is the requirement's own bar
 * (AC-1, FR-3.1) — not similarity, and not a hash.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { WarningLog } from '../src/core/warnings.js';
import { openZcodeDatabase, listSessions, readSession } from '../src/source/sqlite-source.js';
import { groupIntoTurns, planSession } from '../src/transform/plan.js';
import { validateEventLog } from '../src/transform/validate.js';
import { createFixture, TRICKY_REASONING } from './fixtures/zcode-fixture.mjs';

/** @type {{ dir: string, fixture: ReturnType<typeof createFixture>, warn: WarningLog, session: object, plan: object }} */
let context;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'zcm-plan-'));
  const fixture = createFixture({ dir });
  fixture.close();
  const warn = new WarningLog();
  const source = openZcodeDatabase(dir, { warn });
  assert.equal(source.ok, true, 'the fixture store must open read-only');
  const session = readSession(source, fixture.sessionId, { warn });
  source.close();
  assert.ok(session, 'the fixture session must be readable');
  context = { dir, fixture, warn, session, plan: planSession(session, { warn }) };
});

after(() => {
  rmSync(context.dir, { recursive: true, force: true });
});

describe('source reading (FR-1.2, FR-2)', () => {
  it('lists the session with per-session counts', () => {
    const warn = new WarningLog();
    const source = openZcodeDatabase(context.dir, { warn });
    const summaries = listSessions(source, { warn });
    source.close();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, context.fixture.sessionId);
    assert.equal(summaries[0].title, '仿真会话');
    assert.equal(summaries[0].reasoningCount, 4, 'three content blocks plus the empty one');
    assert.equal(summaries[0].toolCount, 3);
  });

  it('normalizes parts through the documented fallback chains', () => {
    const parts = context.session.messages.flatMap((message) => message.parts);
    const reasoning = parts.filter((part) => part.kind === 'reasoning');
    assert.equal(reasoning[0].text, TRICKY_REASONING);
    const tools = parts.filter((part) => part.kind === 'tool');
    assert.equal(tools[0].toolName, 'Bash');
    assert.equal(tools[0].status, 'completed');
    assert.equal(tools[0].output, 'file-a\nfile-b\n');
    assert.equal(tools[1].status, 'error');
    assert.equal(tools[1].error, 'permission denied');
    assert.equal(tools[2].status, 'running');
  });

  it('keeps the source order it read', () => {
    const sequences = context.session.messages.map((message) => message.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  });
});

describe('turn and step grouping', () => {
  it('groups anchored messages by turnId, in first-appearance order', () => {
    const groups = groupIntoTurns(context.session.messages);
    assert.deepEqual(groups.map((group) => group.turnId), ['turn-alpha', 'turn-beta', 'turn-gamma']);
  });

  it('attaches unanchored messages to the turn in progress', () => {
    const groups = groupIntoTurns(context.session.messages);
    const last = groups.at(-1);
    assert.equal(last.turnId, 'turn-gamma', 'unanchored messages join the open turn instead of inventing one');
    assert.ok(
      last.items.some((item) => item.id === 'u4'),
      'the unanchored compaction summary follows its turn chronologically',
    );
    assert.ok(
      last.items.some((item) => item.id === 'a5'),
      'the marker-only assistant message travels with it',
    );
  });
});

describe('planned event log', () => {
  it('is structurally valid (AC-2)', () => {
    const verdict = validateEventLog(context.plan.events);
    assert.equal(verdict.ok, true, verdict.errors.join('\n'));
  });

  it('opens with a pinned title so DSH never regenerates it', () => {
    const title = context.plan.events[0];
    assert.equal(title.type, 'session/title');
    assert.equal(title.data.title, '仿真会话');
    assert.deepEqual(title.data.messageSeqs, []);
    assert.deepEqual(title.data.source, { kind: 'user' });
  });

  it('numbers turns from 1 and steps from 1 within each turn', () => {
    const turns = context.plan.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
    assert.deepEqual(turns, [1, 2, 3]);
    const steps = context.plan.events.filter((event) => event.type === 'step/start').map((event) => [event.data.turn, event.data.step]);
    assert.deepEqual(steps, [
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]);
    assert.ok(
      context.plan.events.some((event) => event.type === 'user/message') && turns.length >= 3,
      'a turn may hold injected context without any model step',
    );
  });

  it('writes reasoning verbatim, in source order, and counts the empty one honestly', () => {
    const blocks = context.plan.events
      .filter((event) => event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'reasoning')
      .map((block) => block.text);

    assert.equal(blocks.length, 3, 'the empty source block is skipped, not invented');
    assert.equal(blocks[0], TRICKY_REASONING, 'AC-1: byte-for-byte, including the 200k line and the emoji');
    assert.equal(blocks[1], '  空白保留测试：\n\n\t尾部空格 ->  \n', 'leading/trailing whitespace survives');
    assert.equal(blocks[2], '最后一段。');
    assert.equal(context.plan.stats.emptyReasoning, 1, 'AC-5: the source-side gap is counted');
  });

  it('keeps each assistant message s content in source part order with tool calls included', () => {
    const first = context.plan.events.find((event) => event.type === 'assistant/message' && event.data.step === 1);
    assert.deepEqual(
      first.data.message.content.map((block) => block.type),
      ['reasoning', 'text', 'tool-call', 'tool-call'],
    );
    assert.equal(first.data.message.source.kind, 'model');
    assert.equal(first.data.message.source.model, 'deepseek-v4-flash');
    assert.deepEqual(first.data.usage, {
      inputTokens: 5,
      outputTokens: 4,
      reasoningTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    });
  });

  it('pairs every tool call with exactly one result, and marks errors as errors (FR-4.2)', () => {
    const calls = context.plan.events.filter((event) => event.type === 'tool/call');
    const results = context.plan.events.filter((event) => event.type === 'tool/result');
    assert.equal(calls.length, 3);
    assert.equal(results.length, calls.length);
    for (const [index, call] of calls.entries()) {
      assert.equal(results[index].data.message.source.callId, call.data.callId);
      assert.equal(results[index].data.message.content[0].toolCallId, call.data.callId);
      assert.equal(typeof call.data.arguments, 'string');
    }
  });

  it('passes tool arguments through as JSON text, re-serializing stored objects', () => {
    const first = context.plan.events.find((event) => event.type === 'tool/call');
    assert.deepEqual(JSON.parse(first.data.arguments), { command: 'ls -la' });
    assert.equal(context.plan.stats.toolArguments.reserialized, 3, 'once per tool, not once per emission site');
    const block = context.plan.events
      .find((event) => event.type === 'assistant/message')
      .data.message.content.find((candidate) => candidate.type === 'tool-call');
    assert.equal(block.arguments, first.data.arguments, 'the content block and the event must agree byte for byte');
  });

  it('marks a tool error result as an error, carrying the source failure text', () => {
    const errored = context.plan.events.find(
      (event) => event.type === 'tool/result' && event.data.message.content[0].isError === true,
    );
    assert.equal(errored.data.message.content[0].content[0].text, 'permission denied');
  });

  it('synthesizes an outcome-unknown result for a tool the source never resolved (FR-4.2)', () => {
    const synthetic = context.plan.events.find(
      (event) => event.type === 'tool/result' && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN',
    );
    assert.ok(synthetic, 'a running tool must still be answered, or the log cannot be resumed');
    assert.equal(synthetic.data.error.name, 'ToolOutcomeUnknownError');
    assert.equal(synthetic.data.message.content[0].isError, true);
    assert.ok(Array.isArray(synthetic.sourceEventSeqs) && synthetic.sourceEventSeqs.length === 1, 'it cites the call it closes');
    assert.equal(context.plan.stats.toolResultsSynthesized, 1);
  });

  it('distinguishes a human prompt from injected runtime context', () => {
    const userMessages = context.plan.events.filter((event) => event.type === 'user/message');
    const human = userMessages.filter((event) => event.data.source.kind === 'user');
    const injected = userMessages.filter((event) => event.data.source.kind === 'plugin');
    assert.equal(human.length, 2);
    assert.equal(injected.length, 2);
    assert.equal(injected[0].data.source.plugin, 'dsh-zcode-migrate');
    assert.equal(context.plan.stats.injectedMessages, 2);
  });

  it('turns an attachment into placeholder text that keeps the reference (FR-2.3)', () => {
    const imagePrompt = context.plan.events.find(
      (event) => event.type === 'user/message' && event.data.content[0].text.includes('[附件'),
    );
    assert.ok(imagePrompt, 'an image-only prompt must still carry content, or the request would be invalid');
    assert.match(imagePrompt.data.content[0].text, /image\/png/);
    assert.match(imagePrompt.data.content[0].text, /zcode-artifact:\/\/sess_demo\/x/);
    assert.equal(context.plan.stats.filePlaceholders, 1);
  });

  it('keeps a content-less message from reaching the provider as an empty one', () => {
    for (const event of context.plan.events) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
      const content = event.type === 'user/message' ? event.data.content : event.data.message.content;
      assert.ok(content.length > 0, `seq=${event.seq} carries no content`);
    }
  });

  it('uses only the core DSH event vocabulary (FR-4.3)', () => {
    const types = new Set(context.plan.events.map((event) => event.type));
    assert.deepEqual(
      [...types].sort(),
      ['assistant/message', 'session/title', 'step/end', 'step/start', 'tool/call', 'tool/result', 'turn/end', 'turn/start', 'user/message'].sort(),
    );
  });

  it('keeps turn/end reasons honest', () => {
    const reasons = context.plan.events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason.kind);
    assert.deepEqual(reasons, ['completed', 'completed', 'completed']);
  });
});

describe('determinism (FR-3.2, FR-6.1)', () => {
  it('produces an identical plan from an identical source, twice', () => {
    const first = planSession(context.session, { warn: new WarningLog() });
    const second = planSession(context.session, { warn: new WarningLog() });
    assert.equal(first.digests.content, second.digests.content);
    assert.deepEqual(first.digests.turns, second.digests.turns);
    assert.equal(JSON.stringify(first.events), JSON.stringify(second.events));
  });

  it('is usable with no warning collector at all', () => {
    // Regression: an optional collector must stay optional on every degradation
    // path — the audit command plans a whole corpus without one.
    const plan = planSession(context.session);
    assert.equal(validateEventLog(plan.events).ok, true);
    assert.equal(plan.digests.content, context.plan.digests.content);
  });

  it('has no model in the pipeline: the plan is a pure function of the source', () => {
    // No network, no clock, no randomness: two runs with different wall clocks
    // and different warning sinks still agree, because every id and digest is
    // derived from source facts.
    const plan = planSession(context.session, { warn: new WarningLog(), now: () => 0 });
    assert.equal(plan.digests.content, context.plan.digests.content);
  });
});

describe('maximum-tokens and empty-step handling', () => {
  it('maps a length finish to max-tokens and keeps a content-less step as a step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcm-plan2-'));
    try {
      const fixture = createFixture({
        dir,
        turns: [
          {
            turnId: 'turn-x',
            messages: [
              { role: 'user', id: 'u1', at: 1, parts: [{ type: 'text', text: 'hi' }] },
              {
                role: 'assistant',
                id: 'a1',
                at: 2,
                finish: 'length',
                parts: [{ type: 'step-start' }, { type: 'reasoning', text: 'r' }, { type: 'step-finish', reason: 'length' }],
              },
              {
                role: 'assistant',
                id: 'a2',
                at: 3,
                finish: 'stream_recovery_discarded',
                parts: [{ type: 'step-start' }],
              },
            ],
          },
        ],
        unanchored: [],
      });
      fixture.close();
      const warn = new WarningLog();
      const source = openZcodeDatabase(dir, { warn });
      const session = readSession(source, fixture.sessionId, { warn });
      source.close();
      const plan = planSession(session, { warn });
      const reasons = plan.events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason.kind);
      assert.deepEqual(
        reasons,
        ['max-tokens'],
        'the discarded trailing step must not overwrite the outcome of the last content-producing step',
      );
      assert.equal(plan.stats.emptySteps, 1, 'the discarded step keeps its bracket but no message');
      assert.equal(validateEventLog(plan.events).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
