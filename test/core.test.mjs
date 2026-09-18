/**
 * Core utilities: home resolution (FR-1.1), deterministic identity (FR-3.2/6.1),
 * and the warning log's severity contract (FR-1.5/3.4).
 */

import { strict as assert } from 'node:assert';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG, normalizeConfig, resolveDshHome, resolveZcodeHome } from '../src/core/config.js';
import { deterministicUuid, messageId, sha256, stableStringify, targetSessionId } from '../src/core/digest.js';
import { SEVERITY, WarningLog } from '../src/core/warnings.js';

describe('ZCode home resolution (FR-1.1)', () => {
  it('prefers an explicit source over the environment and the default', () => {
    assert.equal(resolveZcodeHome('D:/explicit', { ZCODE_HOME: 'D:/env' }).path, 'D:\\explicit');
    assert.equal(resolveZcodeHome('D:/explicit', { ZCODE_HOME: 'D:/env' }).origin, 'config');
  });

  it('falls back to $ZCODE_HOME, then ~/.zcode', () => {
    const fromEnv = resolveZcodeHome(undefined, { ZCODE_HOME: 'D:/env' });
    assert.equal(fromEnv.path, 'D:\\env');
    assert.equal(fromEnv.origin, 'env');

    const fromDefault = resolveZcodeHome(undefined, {});
    assert.equal(fromDefault.path, join(homedir(), '.zcode'));
    assert.equal(fromDefault.origin, 'default');
  });

  it('treats a blank override as unset, so a blank never resolves to the cwd', () => {
    assert.equal(resolveZcodeHome('   ', { ZCODE_HOME: '' }).origin, 'default');
  });

  it('expands a leading tilde', () => {
    assert.equal(resolveZcodeHome('~/.zcode-alt', {}).path, join(homedir(), '.zcode-alt'));
  });

  it('resolves the DSH home as configured > $DSH_HOME > ~/.dsh', () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: 'D:/dsh' }), 'D:\\dsh');
    assert.equal(resolveDshHome(undefined, {}), join(homedir(), '.dsh'));
    assert.equal(resolveDshHome('D:/explicit', { DSH_HOME: 'D:/dsh' }), 'D:\\explicit');
  });
});

describe('config normalization', () => {
  it('is total: bad types fall back to defaults instead of throwing', () => {
    const config = normalizeConfig({ sourceMode: 'nonsense', legacy: 'yes', maxSessions: -5, source: 42 });
    assert.equal(config.sourceMode, DEFAULT_CONFIG.sourceMode);
    assert.equal(config.legacy, false, 'only true/false/1/0 are accepted as booleans; anything else keeps the default');
    assert.equal(config.maxSessions, 0);
    assert.equal(config.source, undefined, 'a non-string source falls back to the environment/default');
  });

  it('accepts string booleans, which is what a patch file or CLI produces', () => {
    assert.equal(normalizeConfig({ legacy: 'true' }).legacy, true);
    assert.equal(normalizeConfig({ legacy: 'false' }).legacy, false);
    assert.equal(normalizeConfig({ createMissingDirs: '1' }).createMissingDirs, true);
  });

  it('defaults the state directory under the DSH home', () => {
    const config = normalizeConfig({}, { DSH_HOME: 'D:/dsh' });
    assert.equal(config.stateDirResolved, join('D:\\dsh', 'zcode-migrate'));
  });
});

describe('deterministic identity', () => {
  it('produces byte-identical ids for the same source, run after run', () => {
    const first = targetSessionId('sess_fixture-0000');
    const second = targetSessionId('sess_fixture-0000');
    assert.equal(first, second);
    assert.match(first, /^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('gives different sources different ids, and a forced copy its own id', () => {
    assert.notEqual(targetSessionId('sess_a'), targetSessionId('sess_b'));
    assert.notEqual(targetSessionId('sess_a'), targetSessionId('sess_a', 'abc123'));
  });

  it('derives message ids from source identity, not from a counter', () => {
    assert.equal(messageId('sess_a', 'assistant', 'msg_1'), messageId('sess_a', 'assistant', 'msg_1'));
    assert.notEqual(messageId('sess_a', 'assistant', 'msg_1'), messageId('sess_a', 'assistant', 'msg_2'));
    assert.notEqual(messageId('sess_a', 'assistant', 'msg_1'), messageId('sess_b', 'assistant', 'msg_1'));
  });

  it('sorts object keys, so a digest cannot depend on member insertion order', () => {
    assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }));
    assert.notEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ a: 1, b: 3 }));
  });

  it('drops undefined members when canonicalizing, matching what JSON would store', () => {
    assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
  });

  it('hashes stably and produces uuid-shaped text', () => {
    assert.equal(sha256('abc'), sha256('abc'));
    assert.match(deterministicUuid('x'), /^[0-9a-f-]{36}$/);
  });
});

describe('warning log', () => {
  it('carries severity, code, and the owning session', () => {
    const log = new WarningLog('sess_1');
    log.add('empty-reasoning', '源侧缺失', { severity: SEVERITY.info, where: 'part_9' });
    log.add('db-open-failed', '打不开', { severity: SEVERITY.error });

    assert.equal(log.length, 2);
    assert.deepEqual(log.counts(), { 'empty-reasoning': 1, 'db-open-failed': 1 });
    assert.equal(log.items[0].sessionId, 'sess_1');
    assert.equal(log.items[0].where, 'part_9');
    assert.equal(log.errors().length, 1);
  });

  it('merges nested collectors without losing their attribution', () => {
    const outer = new WarningLog();
    const inner = new WarningLog('sess_2');
    inner.add('x', 'y');
    outer.merge(inner);
    assert.equal(outer.items[0].sessionId, 'sess_2');
  });
});
