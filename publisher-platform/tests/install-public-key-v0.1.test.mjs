import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTALL_PUBLIC_KEY_PREFIX, INSTALL_PUBLIC_KEY_LENGTH,
  isValidInstallPublicKey, generateInstallPublicKey } from '../install-public-key-v0.1.mjs';

test('repeated generation produces exact public key format', () => {
  assert.equal(INSTALL_PUBLIC_KEY_PREFIX, 'cfi_');
  assert.equal(INSTALL_PUBLIC_KEY_LENGTH, 36);
  for (let i = 0; i < 1000; i++) {
    const key = generateInstallPublicKey();
    assert.ok(isValidInstallPublicKey(key));
    assert.equal(key.length, 36);
    assert.equal(Buffer.byteLength(key, 'ascii'), 36);
    assert.equal(key.slice(0, 4), 'cfi_');
    assert.match(key.slice(4), /^[0-9a-f]{32}$/);
    assert.ok(!key.includes('-'));
  }
});

test('validator accepts exact cases without normalization', () => {
  for (const hex of ['0'.repeat(32), 'f'.repeat(32), '0123456789abcdef'.repeat(2)]) {
    const key = `cfi_${hex}`;
    assert.equal(isValidInstallPublicKey(key), true);
    assert.equal(isValidInstallPublicKey(key), true);
  }
});

test('validator rejects malformed, partial, normalized and non-string inputs', () => {
  const key = `cfi_${'abcdef01'.repeat(4)}`;
  const invalid = [key.toUpperCase(), `cfi_${'A'.repeat(32)}`,
    ` ${key}`, `${key} `, `\t${key}`, `${key}\n`, `${key}\r\n`, `${key}\r`,
    `${key}\u2028`, `${key}\u2029`, `${key.slice(0, 12)}\n${key.slice(13)}`,
    key.replace('cfi_', 'cfx_'), key.replace('cfi_', 'CFI_'), key.replace('_', '-'),
    key.slice(1), key.slice(0, -1), `${key}0`, `x${key}`, `${key}x`, `${key}${key}`,
    key.replace('a', 'g'), key.replace('a', 'ａ'), key.slice(4), '',
    '00000000-0000-4000-8000-000000000000', null, undefined, 36, true, 1n,
    Symbol('test'), [], {}, new String(key), { toString() { throw Error('must not coerce'); } }];
  for (const value of invalid) assert.equal(isValidInstallPublicKey(value), false);
});

test('generator uses exactly 16 random bytes and encodes every byte without identity inputs', t => {
  let calls = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', bytes => {
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 16);
    assert.equal(bytes.byteLength * 8, 128);
    // Across 16 calls, exercise every byte, including leading-zero encoding.
    for (let i = 0; i < 16; i++) bytes[i] = calls * 16 + i;
    calls++;
    return bytes;
  });
  const unreadableIdentity = new Proxy({}, { get() { throw Error('identity accessed'); } });
  assert.equal(generateInstallPublicKey.length, 0);
  for (let block = 0; block < 16; block++) {
    const key = generateInstallPublicKey(unreadableIdentity);
    const expected = Array.from({ length: 16 }, (_, i) => (block * 16 + i).toString(16).padStart(2, '0')).join('');
    assert.equal(key, `cfi_${expected}`);
    assert.ok(isValidInstallPublicKey(key));
  }
  assert.equal(calls, 16);
});

test('randomness failure propagates without an identity or weak-random fallback', t => {
  t.mock.method(globalThis.crypto, 'getRandomValues', () => { throw Error('randomness unavailable'); });
  assert.throws(() => generateInstallPublicKey(), /randomness unavailable/);
});
