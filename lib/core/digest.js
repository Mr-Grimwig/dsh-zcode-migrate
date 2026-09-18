/**
 * Deterministic identity and hashing.
 *
 * The migration must be *repeatable byte-for-byte*: FR-6.1 (idempotent re-import)
 * and AC-1 (reasoning compared with `===`) both break if a second run produces
 * different ids or different JSON key order. So every id is derived from source
 * facts with a name-based UUID (RFC 4122 v5 shape, SHA-1), and every digest is
 * computed over a canonical stringification with sorted keys.
 *
 * Nothing here is random. Given the same source session, two runs — on two
 * machines — produce the same target session id, the same message ids, and the
 * same digests.
 *
 * @module dsh-zcode-migrate/core/digest
 */

import { createHash } from 'node:crypto';

/** Namespace for every id this plugin mints (an arbitrary fixed UUID). */
export const MIGRATE_NAMESPACE = '6f1a0d3c-7b4e-5a92-8c11-2d5e9f0b4a77';

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped.
 *
 * Digests must not depend on member insertion order, or a re-import could
 * report a conflict against itself.
 *
 * @param {unknown} value - any JSON-representable value.
 * @returns {string} canonical JSON text.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * SHA-256 hex digest of a string.
 * @param {string} text - input text (UTF-8).
 * @returns {string} 64-char lowercase hex.
 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Short digest for reports and registry fingerprints.
 * @param {string} text - input text.
 * @param {number} [length] - hex characters to keep (default 16).
 * @returns {string} truncated digest.
 */
export function shortHash(text, length = 16) {
  return sha256(text).slice(0, length);
}

/** Bytes of a name-based (v5) UUID, as hex, before version/variant stamping. */
function nameDigestBytes(name) {
  return createHash('sha1').update(MIGRATE_NAMESPACE, 'utf8').update('\0').update(name, 'utf8').digest().subarray(0, 16);
}

/**
 * Deterministic UUID derived from a name.
 *
 * Shape-compatible with RFC 4122 v5 (version and variant bits stamped) so the
 * values look like ordinary uuids to DSH, the UI, and the filesystem path
 * encoder — but the digest is SHA-1 of `namespace \0 name`.
 *
 * @param {string} name - stable, source-derived name (never random).
 * @returns {string} uuid text with version 5 and RFC variant bits.
 */
export function deterministicUuid(name) {
  const b = nameDigestBytes(name);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The DSH session id a source session migrates to.
 *
 * FR-6.1: a stable target id is what makes re-import an update rather than a
 * duplicate. Deriving it from the source id (not from a counter or a timestamp)
 * keeps it stable across runs, machines, and registry loss.
 *
 * @param {string} sourceSessionId - ZCode session id (e.g. `sess_4cc8…`).
 * @param {string} [variant] - disambiguator for forced full copies (FR-6.3).
 * @returns {string} DSH session id, `session-<uuid>`.
 */
export function targetSessionId(sourceSessionId, variant = '') {
  return `session-${deterministicUuid(`session/${sourceSessionId}${variant === '' ? '' : `/${variant}`}`)}`;
}

/**
 * Deterministic DSH message id.
 * @param {string} sourceSessionId - source session id.
 * @param {string} kind - `assistant` | `tool-result` | …
 * @param {string} sourceId - originating source id (message id / part id).
 * @returns {string} uuid text.
 */
export function messageId(sourceSessionId, kind, sourceId) {
  return deterministicUuid(`message/${sourceSessionId}/${kind}/${sourceId}`);
}

/**
 * Deterministic local registry/report file name for a source session.
 * @param {string} sourceSessionId - source session id.
 * @returns {string} filesystem-safe name.
 */
export function stateFileName(sourceSessionId) {
  return `${sourceSessionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${shortHash(sourceSessionId, 8)}`;
}
