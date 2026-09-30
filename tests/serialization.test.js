import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalStringify, assertSerializable, stateFingerprint,
  bytesToBase64, base64ToBytes,
} from '../js/lib/serialize.js';

test('canonical JSON sorts keys recursively and is stable', () => {
  const a = { z: 1, a: { d: 4, c: [3, { b: 2, a: 1 }] } };
  const b = { a: { c: [3, { a: 1, b: 2 }] }, z: 1 };
  assert.equal(canonicalStringify(a), canonicalStringify({ a: { d: 4, c: [3, { b: 2, a: 1 }] }, z: 1 }));
  assert.equal(canonicalStringify(a), '{"a":{"c":[3,{"a":1,"b":2}],"d":4},"z":1}');
});

test('assertSerializable rejects non-finite numbers, undefined in arrays, cycles', () => {
  assert.throws(() => assertSerializable({ x: NaN }), /non-finite/);
  assert.throws(() => assertSerializable({ x: Infinity }), /non-finite/);
  assert.throws(() => assertSerializable([undefined]), /undefined/);
  assert.throws(() => assertSerializable({ d: new Date() }), /Date/);
  const cyc = {}; cyc.self = cyc;
  assert.throws(() => assertSerializable(cyc), /cyclic/);
});

test('fingerprint is deterministic', () => {
  const fp1 = stateFingerprint({ a: 1, b: [2, 3] });
  const fp2 = stateFingerprint({ b: [2, 3], a: 1 });
  assert.equal(fp1.crc, fp2.crc);
  assert.ok(fp1.size > 0);
});

test('base64 round trip including binary bytes', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) bytes[i] = i;
  const b64 = bytesToBase64(bytes);
  const back = base64ToBytes(b64);
  assert.deepEqual(back, bytes);
});
