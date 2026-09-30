// Background compression/decompression so snapshotting large forms never
// blocks UI interaction. The same lib modules run on the main thread as a
// fallback when Workers / module workers are unavailable.
import { compressBytes, decompressBytes } from '../lib/compress.js';
import { canonicalStringify, encodeUtf8, decodeUtf8 } from '../lib/serialize.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'pack') {
      // Payload is canonical JSON of { state } — keeps frame self-describing.
      const json = canonicalStringify({ v: 1, state: msg.state });
      const bytes = encodeUtf8(json);
      const { bytes: frame, method, compressed } = compressBytes(bytes);
      self.postMessage({
        type: 'packed',
        id: msg.id,
        frame,
        rawSize: bytes.length,
        compressedSize: frame.length,
        method,
        compressed,
      });
    } else if (msg.type === 'unpack') {
      const raw = decompressBytes(msg.frame);
      const wrapped = JSON.parse(decodeUtf8(raw));
      self.postMessage({ type: 'unpacked', id: msg.id, state: wrapped.state });
    } else {
      self.postMessage({ type: 'error', id: msg.id, message: `unknown worker message ${msg.type}` });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: msg.id, message: error?.message || String(error), name: error?.name });
  }
};
