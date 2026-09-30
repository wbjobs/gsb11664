import test from 'node:test';
import assert from 'node:assert/strict';
import { compressBytes, decompressBytes, CompressionError } from '../js/lib/compress.js';

const enc = new TextEncoder();
function roundtrip(text) {
  const input = enc.encode(text);
  const { bytes, method } = compressBytes(input);
  const output = decompressBytes(bytes);
  return { input, bytes, method, output };
}

test('empty / tiny payloads use stored frames and round-trip', () => {
  for (const text of ['', 'a', 'ab', 'abc']) {
    const { input, output, method } = roundtrip(text);
    assert.equal(method, 'stored');
    assert.deepEqual(output, input);
  }
});

test('repetitive data is LZ77-compressed and fully restored', () => {
  const text = JSON.stringify({
    name: '张三', records: Array.from({ length: 60 }, (_, i) => ({
      id: i, company: 'Acme', role: 'Engineer', tags: ['js', 'canvas', 'idb'],
    })),
  });
  const { input, bytes, output, method } = roundtrip(text);
  assert.equal(method, 'lz77');
  assert.ok(bytes.length < input.length * 0.4, `expected strong compression, got ${bytes.length}/${input.length}`);
  assert.deepEqual(output, input);
});

test('500 fuzz inputs round-trip byte-for-byte', () => {
  const cases = [];
  for (let t = 0; t < 500; t += 1) {
    let s = '';
    const alphabet = 'abcdefgh'[t % 6] ? 'abcababcdef' : 'abc';
    const n = Math.floor(Math.random() * 900);
    for (let i = 0; i < n; i += 1) s += alphabet[Math.floor(Math.random() * (3 + (t % 7)))];
    if (t % 3 === 0) s += 'xyz'.repeat(40);
    cases.push(s);
  }
  for (const text of cases) {
    const { input, output } = roundtrip(text);
    assert.equal(output.length, input.length);
    for (let i = 0; i < input.length; i += 1) assert.equal(output[i], input[i]);
  }
});

test('frame rejects bad magic, bad version, truncated data and CRC corruption', () => {
  const { bytes } = roundtrip('abc'.repeat(400));
  let bad = bytes.slice();
  bad[0] = 0;
  assert.throws(() => decompressBytes(bad), /bad magic/);

  bad = bytes.slice(); bad[4] = 99;
  assert.throws(() => decompressBytes(bad), /version/);

  assert.throws(() => decompressBytes(bytes.subarray(0, bytes.length - 4)), /crc|size|truncated|mismatch/i);

  bad = bytes.slice(); bad[14] ^= 0xff; // control byte corruption
  assert.throws(() => decompressBytes(bad), CompressionError);
});
