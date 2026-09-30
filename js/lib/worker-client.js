// Compression service: prefers a module Web Worker, transparently falls back
// to running the same code synchronously on the main thread.
import { compressBytes, decompressBytes } from './compress.js';
import { canonicalStringify, encodeUtf8, decodeUtf8 } from './serialize.js';

export class CompressionClient {
  constructor(workerUrl = new URL('../worker/compress-worker.js', import.meta.url)) {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.disabled = false;
    try {
      if (typeof Worker !== 'undefined') {
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.worker.onmessage = (event) => this.handleMessage(event.data);
        this.worker.onerror = () => this.disable();
      } else {
        this.disabled = true;
      }
    } catch {
      this.disabled = true;
    }
  }

  handleMessage(msg) {
    const resolver = this.pending.get(msg.id);
    if (!resolver) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') resolver.reject(new Error(msg.message));
    else resolver.resolve(msg);
  }

  disable() {
    this.disabled = true;
    for (const { reject } of this.pending.values()) reject(new Error('worker disabled'));
    this.pending.clear();
  }

  nextId() {
    this.seq += 1;
    return this.seq;
  }

  async pack(state) {
    if (this.disabled || !this.worker) return packSync(state);
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'pack', id, state });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.get(id).reject(new Error('compression worker timeout'));
          this.pending.delete(id);
        }
      }, 15000);
    });
  }

  async unpack(frame) {
    if (this.disabled || !this.worker) return unpackSync(frame);
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'unpack', id, frame }, [frame.buffer]);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.get(id).reject(new Error('decompression worker timeout'));
          this.pending.delete(id);
        }
      }, 15000);
    });
  }
}

export function packSync(state) {
  const json = canonicalStringify({ v: 1, state });
  const bytes = encodeUtf8(json);
  const { bytes: frame, method, compressed } = compressBytes(bytes);
  return {
    frame,
    rawSize: bytes.length,
    compressedSize: frame.length,
    method,
    compressed,
  };
}

export function unpackSync(frame) {
  const raw = decompressBytes(frame);
  const wrapped = JSON.parse(decodeUtf8(raw));
  return { state: wrapped.state };
}
