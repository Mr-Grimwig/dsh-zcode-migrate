/**
 * Read stored DSH session artifacts without a running harness.
 *
 * Needed in two places, both of them "prove it" situations:
 *
 * - the standalone `verify` command, which compares a migrated session's
 *   reasoning with its source after the fact (AC-1, AC-3) — and must read what
 *   the *harness* wrote, not what the plugin thinks it wrote;
 * - the integration tests, which need to inspect a session the real JSONL
 *   backend materialized.
 *
 * Two properties of the physical format matter here:
 *
 * 1. A session artifact is a **concatenation of zstd frames** — the header is
 *    its own frame and each flush adds more — so it is decoded frame by frame
 *    rather than in one call.
 * 2. A log line is a **storage record**, not necessarily an event: runs of
 *    streaming deltas are packed into `text-chunks` / `reasoning-chunks` /
 *    `tool-call-chunks` rows. Those rows carry the stream that *produced* an
 *    `assistant/message`, never content that is missing from it, so this reader
 *    counts them and leaves them out of the event list: the assistant message,
 *    the tool call/result pairing, and the reasoning text are all real events.
 *
 * @module dsh-zcode-migrate/target/dsh-log-reader
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** Zstandard frame magic number, used to split a multi-frame artifact. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Physical suffixes a session artifact can carry. */
const ARTIFACT_NAMES = ['session.jsonl.zstd', 'session.jsonl'];

/**
 * Decode a whole multi-frame zstd artifact, or read a plaintext one.
 *
 * @param {Buffer} buffer - raw file bytes.
 * @returns {{ text: string, frames: number }} decoded UTF-8 text and frame count.
 */
export function decodeArtifactBuffer(buffer) {
  if (buffer.length >= 4 && buffer.compare(ZSTD_MAGIC, 0, 4, 0, 4) !== 0) {
    return { text: buffer.toString('utf8'), frames: 0 };
  }
  const offsets = [];
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, index, index + 4) === 0) offsets.push(index);
  }
  const chunks = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    chunks.push(zstdDecompressSync(buffer.subarray(offsets[index], end)));
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames: offsets.length };
}

/**
 * The `~XXXX` path-segment escape DSH's JSONL backend uses, decoded.
 *
 * Only used to make diagnostics readable; the plugin never writes paths itself.
 *
 * @param {string} segment - encoded segment.
 * @returns {string} decoded segment.
 */
export function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * List every session artifact under a sessions root.
 *
 * @param {string} root - the DSH sessions root (`<dsh home>/sessions`).
 * @returns {Array<{ sessionId: string, path: string, size: number, projectDir: string }>} artifacts found.
 */
export function listArtifacts(root) {
  if (!existsSync(root)) return [];
  /** @type {Array<{ sessionId: string, path: string, size: number, projectDir: string }>} */
  const found = [];
  let projectDirs;
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(projectPath, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      for (const artifact of ARTIFACT_NAMES) {
        const path = join(projectPath, sessionDir.name, artifact);
        if (!existsSync(path)) continue;
        try {
          found.push({
            sessionId: decodeSegment(sessionDir.name),
            path,
            size: statSync(path).size,
            projectDir: projectDir.name,
          });
        } catch {
          /* an unreadable artifact is simply not listed */
        }
        break;
      }
    }
  }
  return found;
}

/**
 * Parse a decoded artifact into its header, events, and packed-row count.
 *
 * @param {string} text - decoded artifact text.
 * @returns {{ header: object|undefined, events: object[], chunkRows: number, malformed: number }} parsed parts.
 */
export function parseArtifact(text) {
  const lines = text.split('\n').filter((line) => line !== '');
  /** @type {object|undefined} */
  let header;
  /** @type {object[]} */
  const events = [];
  let chunkRows = 0;
  let malformed = 0;

  for (const [index, line] of lines.entries()) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (index === 0 && value !== null && typeof value === 'object' && value.type === 'session') {
      header = value;
      continue;
    }
    if (Array.isArray(value)) {
      chunkRows += value.length;
      continue;
    }
    if (typeof value?.type === 'string' && value.type.endsWith('-chunks')) {
      // A packed delta run: it produced an assistant/message that is stored as
      // a real event, so it is counted rather than expanded.
      chunkRows += Array.isArray(value.data?.texts ?? value.data?.args)
        ? (value.data.texts ?? value.data.args).length
        : 1;
      continue;
    }
    events.push(value);
  }
  return { header, events, chunkRows, malformed };
}

/**
 * Read one session artifact by id.
 *
 * @param {string} root - DSH sessions root.
 * @param {string} sessionId - target session id.
 * @returns {{ header: object|undefined, events: object[], chunkRows: number, malformed: number, path: string }|undefined}
 *   the parsed artifact, or `undefined` when the session has no artifact.
 */
export function readSessionArtifact(root, sessionId) {
  const match = listArtifacts(root).find((artifact) => artifact.sessionId === sessionId);
  if (match === undefined) return undefined;
  const { text } = decodeArtifactBuffer(readFileSync(match.path));
  return { ...parseArtifact(text), path: match.path };
}

/**
 * Collect the reasoning blocks of a stored log, in order.
 *
 * @param {object[]} events - stored events.
 * @returns {Array<{ text: string, turn: number, step: number }>} reasoning blocks with placement.
 */
export function reasoningBlocksOf(events) {
  /** @type {Array<{ text: string, turn: number, step: number }>} */
  const blocks = [];
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === 'reasoning') {
        blocks.push({ text: block.text, turn: event.data.turn, step: event.data.step });
      }
    }
  }
  return blocks;
}
