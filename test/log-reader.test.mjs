/**
 * Reading stored artifacts without the harness.
 *
 * Two things here were learned the hard way and would silently misreport if they
 * regressed: a newer generation writes its log *beside* the old one (so a reader
 * that picks the first file it finds reports stale content), and the file name
 * carries the generation from v1 onward.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';

import { listArtifacts, parseArtifactName, readSessionArtifact, reasoningBlocksOf } from '../src/target/dsh-log-reader.js';

/**
 * Write one artifact the way the backend does: a header frame followed by an
 * event frame, concatenated.
 * @param {string} path - target file.
 * @param {object} header - session header line.
 * @param {object[]} events - event lines.
 */
function writeArtifact(path, header, events) {
  const frames = [Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')];
  for (const event of events) frames.push(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'));
  writeFileSync(path, Buffer.concat(frames.map((frame) => zstdCompressSync(frame))));
}

/** One assistant message carrying reasoning text. */
function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: 1700000000000,
    data: {
      turn: 1,
      step: 1,
      message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'reasoning', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
    },
    surfaceOp: 'append',
  };
}

describe('artifact naming', () => {
  it('recognizes both the bare and the versioned spelling', () => {
    assert.deepEqual(parseArtifactName('session.jsonl.zstd'), { version: undefined });
    assert.deepEqual(parseArtifactName('session.jsonl'), { version: undefined });
    assert.deepEqual(parseArtifactName('session.v3.jsonl.zstd'), { version: 3 });
    assert.deepEqual(parseArtifactName('session.v12.jsonl'), { version: 12 });
  });

  it('ignores everything else in a session directory', () => {
    assert.equal(parseArtifactName('notes.txt'), undefined);
    assert.equal(parseArtifactName('session.jsonl.tmp'), undefined);
    assert.equal(parseArtifactName('session.jsonl.zstd.bak'), undefined);
  });
});

describe('generation handling', () => {
  /** @type {string} */
  let root;
  const sessionId = 'session-abc';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'zcm-reader-'));
    const dir = join(root, '--D-work-demo--', sessionId);
    mkdirSync(dir, { recursive: true });
    // The same session in two generations, the way a migration leaves it.
    writeArtifact(
      join(dir, 'session.jsonl.zstd'),
      { type: 'session', version: 0, id: sessionId, createdAt: 1, cwd: 'D:\\work\\demo', delegationDepth: 0 },
      [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, assistantEvent(1, '旧的一代')],
    );
    writeArtifact(
      join(dir, 'session.v3.jsonl.zstd'),
      { type: 'session', version: 3, id: sessionId, createdAt: 1, cwd: 'D:\\work\\demo', isSeeded: false, delegationDepth: 0 },
      [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        assistantEvent(1, '新的一代'),
        { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists both generations of a session, newest first', () => {
    const artifacts = listArtifacts(root);
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].formatVersion, 3);
    assert.equal(artifacts[1].formatVersion, 0);
  });

  it('reads the newest one, so a migrated session does not look stale', () => {
    const artifact = readSessionArtifact(root, sessionId);
    assert.match(artifact.path, /session\.v3\.jsonl\.zstd$/);
    assert.equal(artifact.header.version, 3);
    assert.deepEqual(reasoningBlocksOf(artifact.events).map((block) => block.text), ['新的一代']);
  });
});
