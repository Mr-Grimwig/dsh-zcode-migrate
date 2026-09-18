/**
 * Synthetic ZCode stores for tests, including the awkward shapes.
 *
 * AC-1 asks for a *simulated* ZCode database, and the interesting cases are the
 * ones real data only shows occasionally: a tool whose outcome never came back,
 * an empty reasoning block, an image-only prompt, an injected reminder with no
 * turn anchor, a step whose stream was discarded, very long reasoning, emoji and
 * mixed scripts. Building one here keeps those cases deterministic instead of
 * hoping a fixture machine happens to contain them.
 *
 * @module dsh-zcode-migrate/test/fixtures/zcode-fixture
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The real store's DDL, reduced to the columns the reader touches. */
const SCHEMA = `
CREATE TABLE session (
  id text primary key, project_id text not null, workspace_id text, parent_id text, slug text not null,
  directory text not null, path text, title text not null, version text not null, share_url text,
  summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, revert text,
  permission text, time_created integer not null, time_updated integer not null, time_compacting integer,
  time_archived integer, task_type text not null default 'interactive',
  title_source text not null default 'first_input' check(title_source in ('default','first_input','generated','custom')),
  title_message_id text, time_title_updated integer, trace_id text
);
CREATE TABLE message (
  id text primary key, session_id text not null references session(id) on delete cascade,
  time_created integer not null, time_updated integer not null, data text not null, sequence integer
);
CREATE TABLE part (
  id text primary key, message_id text not null references message(id) on delete cascade,
  session_id text not null, time_created integer not null, time_updated integer not null,
  data text not null, sequence integer
);
CREATE TABLE session_entry (
  id text primary key, session_id text not null, type text not null,
  time_created integer not null, time_updated integer not null, data text not null
);
`;

/** Text chosen to exercise multi-byte, emoji, code fences, and long input. */
export const TRICKY_REASONING = [
  '第一段思路：让我看看 `D:\\work\\demo` 里的东西。',
  'Emoji 边界：👨‍👩‍👧‍👦 🇨🇳 🏳️‍🌈 ✨ — 变体选择符与 ZWJ 都要原样保留。',
  '```js\nconst x = "\\u0000 tab\\t newline\\n";\n```',
  'Mixed 中英排 version 0.16.5 with trailing spaces   \n',
  'Long: ' + 'x'.repeat(200_000),
].join('\n\n');

/**
 * A synthetic session's script: turns of messages and parts.
 * @returns {Array<object>} turn descriptors.
 */
export function sampleTurns() {
  return [
    {
      turnId: 'turn-alpha',
      messages: [
        {
          role: 'user',
          id: 'u1',
          at: 1_700_000_000_000,
          parts: [{ type: 'text', text: '帮我看看这个程序' }],
        },
        {
          role: 'assistant',
          id: 'a1',
          at: 1_700_000_000_500,
          finish: 'tool-calls',
          model: 'deepseek-v4-flash',
          provider: 'provider-1',
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: TRICKY_REASONING },
            { type: 'text', text: '我先看一下目录。' },
            {
              type: 'tool',
              callID: 'call_ok',
              tool: 'Bash',
              state: { status: 'completed', input: { command: 'ls -la' }, output: 'file-a\nfile-b\n' },
            },
            {
              type: 'tool',
              callID: 'call_err',
              tool: 'Bash',
              state: { status: 'error', input: { command: 'rm -rf /' }, error: 'permission denied' },
            },
            { type: 'step-finish', reason: 'tool-calls' },
          ],
        },
        {
          role: 'assistant',
          id: 'a2',
          at: 1_700_000_001_000,
          finish: 'stop',
          model: 'deepseek-v4-flash',
          provider: 'provider-1',
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: '  空白保留测试：\n\n\t尾部空格 ->  \n' },
            { type: 'reasoning', text: '' },
            { type: 'text', text: '看完了。' },
            { type: 'step-finish', reason: 'stop' },
          ],
        },
      ],
    },
    {
      turnId: 'turn-beta',
      messages: [
        {
          role: 'user',
          id: 'u2',
          at: 1_700_000_002_000,
          origin: 'real_user',
          parts: [
            { type: 'text', text: '' },
            { type: 'file', mime: 'image/png', url: 'zcode-artifact://sess_demo/x', metadata: { sizeBytes: 1234 } },
          ],
        },
        {
          role: 'assistant',
          id: 'a3',
          at: 1_700_000_002_500,
          finish: 'tool-calls',
          parts: [
            { type: 'step-start' },
            {
              type: 'tool',
              callID: 'call_running',
              tool: 'Bash',
              state: { status: 'running', input: { command: 'sleep 999' } },
            },
            { type: 'step-finish', reason: 'tool-calls' },
          ],
        },
        {
          role: 'assistant',
          id: 'a4',
          at: 1_700_000_003_000,
          finish: 'stop',
          parts: [{ type: 'step-start' }, { type: 'reasoning', text: '最后一段。' }, { type: 'step-finish', reason: 'stop' }],
        },
      ],
    },
    {
      // A turn made only of injected context: no assistant step follows.
      turnId: 'turn-gamma',
      messages: [
        {
          role: 'user',
          id: 'u3',
          at: 1_700_000_004_000,
          origin: 'agent_runtime',
          semanticsKind: 'todo_reminder',
          parts: [{ type: 'text', text: '<system-reminder>待办提醒</system-reminder>' }],
        },
      ],
    },
  ];
}

/**
 * An unanchored (no turnId) injected message plus a content-less assistant
 * message, appended after the scripted turns.
 * @returns {Array<object>} extra messages.
 */
export function sampleUnanchored() {
  return [
    {
      role: 'user',
      id: 'u4',
      at: 1_700_000_005_000,
      origin: 'agent_runtime',
      semanticsKind: 'compact_summary',
      summary: { title: 'Compact summary', body: '摘要正文' },
      parts: [{ type: 'text', text: 'Summary: 压缩摘要正文' }],
    },
    {
      role: 'assistant',
      id: 'a5',
      at: 1_700_000_005_500,
      parts: [{ type: 'timeline', timelineType: 'context_compaction' }],
    },
  ];
}

/**
 * Create a synthetic ZCode store on disk.
 *
 * @param {object} [options] - `{ dir, sessionId, title, directory, turns, unanchored, versionHints }`.
 * @returns {{ path: string, db: DatabaseSync, sessionId: string, close: () => void, appendTurn: (turn: object) => void }} fixture handle.
 */
export function createFixture(options = {}) {
  const dir = options.dir ?? join(process.cwd(), '.tmp-fixture');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'cli', 'db'), { recursive: true });
  const path = join(dir, 'cli', 'db', 'db.sqlite');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const sessionId = options.sessionId ?? 'sess_fixture-0000-1111-2222-333333333333';
  const directory = options.directory ?? 'D:\\code\\fixture';
  const createdAt = options.createdAt ?? 1_700_000_000_000;
  const updatedAt = options.updatedAt ?? 1_700_000_006_000;

  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, path, title, version, time_created, time_updated, task_type, title_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'interactive', 'generated')`,
  ).run(sessionId, 'proj_fixture', sessionId, directory, directory, options.title ?? '仿真会话', '0.16.5', createdAt, updatedAt);

  let messageSequence = 0;
  const insertMessage = (message, turnId) => {
    const data = {
      role: message.role,
      time: { created: message.at, ...(message.role === 'assistant' ? { completed: message.at + 100 } : {}) },
      ...(turnId === null ? {} : { anchor: { turnId } }),
      ...(message.role === 'assistant'
        ? {
            modelID: message.model ?? 'deepseek-v4-flash',
            providerID: message.provider ?? 'provider-1',
            finish: message.finish,
            tokens: { total: 10, input: 5, output: 4, reasoning: 1, cache: { read: 2, write: 0 } },
          }
        : {
            model: { providerID: message.provider ?? 'provider-1', modelID: message.model ?? 'deepseek-v4-flash' },
          }),
      semantics: { origin: message.origin ?? (message.role === 'user' ? 'real_user' : 'agent_runtime'), kind: message.semanticsKind ?? 'user_prompt' },
      ...(message.summary === undefined ? {} : { summary: message.summary }),
    };
    const sequence = messageSequence++;
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(message.id, sessionId, message.at, message.at, JSON.stringify(data), sequence);
    message.parts.forEach((part, index) => {
      const partData = { ...part };
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`${message.id}-p${index}`, message.id, sessionId, message.at, message.at, JSON.stringify(partData), index);
    });
  };

  const turns = options.turns ?? sampleTurns();
  for (const turn of turns) {
    for (const message of turn.messages) insertMessage(message, turn.turnId);
  }
  for (const message of options.unanchored ?? sampleUnanchored()) insertMessage(message, null);

  return {
    path,
    db,
    sessionId,
    close: () => db.close(),
    /**
     * Append a turn the way a live ZCode session would: new messages *and* an
     * advanced `time_updated`. The timestamp matters — both the registry's
     * cheap "is this session pending?" check and a reader's expectations key off
     * it, so a fixture that appended silently would model something the real
     * store never does.
     * @param {object} turn - turn descriptor (`{ turnId, messages }`).
     */
    appendTurn: (turn) => {
      let latest = 0;
      for (const message of turn.messages) {
        insertMessage(message, turn.turnId ?? null);
        latest = Math.max(latest, Number(message.at) || 0);
      }
      db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(latest + 100, sessionId);
    },
    /**
     * Rewrite one stored part's JSON, as a source-side history rewrite would
     * (ZCode bumps `time_updated` on any write).
     * @param {string} partId - part row id (e.g. `a1-p1`).
     * @param {object} patch - fields merged into the parsed part data.
     */
    rewritePart: (partId, patch) => {
      db.prepare('UPDATE part SET data = json_patch(data, ?) WHERE id = ?').run(JSON.stringify(patch), partId);
      db.prepare('UPDATE session SET time_updated = time_updated + 1000 WHERE id = ?').run(sessionId);
    },
  };
}
