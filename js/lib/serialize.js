// Canonical JSON serialization + strict "state must be serializable" checks.
// Canonical form: object keys sorted by UTF-16 code unit, no whitespace,
// `undefined` object properties dropped, `undefined` inside arrays rejected.
import { crc32 } from './util.js';

export class SerializationError extends Error {
  constructor(message, path) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'SerializationError';
    this.path = path;
  }
}

export function assertSerializable(value, path = '$', seen = new Set()) {
  if (value === undefined) {
    throw new SerializationError('undefined is not serializable', path);
  }
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new SerializationError(`non-finite number ${String(value)}`, path);
    }
    return;
  }
  if (t === 'bigint') throw new SerializationError('bigint is not serializable', path);
  if (t === 'function' || t === 'symbol') {
    throw new SerializationError(`${t} is not serializable`, path);
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) {
    throw new SerializationError(`${value.constructor.name} is not JSON-serializable`, path);
  }
  if (t !== 'object') {
    throw new SerializationError(`unsupported type ${t}`, path);
  }
  if (seen.has(value)) {
    throw new SerializationError('cyclic reference detected', path);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSerializable(item, `${path}[${i}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      assertSerializable(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const child = sortKeys(value[key]);
      if (child !== undefined) out[key] = child;
    }
    return out;
  }
  if (value === undefined) return undefined;
  return value;
}

export function canonicalStringify(value) {
  // Strict check first: silently dropping an `undefined` state field would
  // violate "rollback / snapshot must not lose data".
  assertSerializable(value);
  return JSON.stringify(sortKeys(value));
}

export function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

export function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

// Fingerprint of a state: CRC32 over canonical JSON bytes.
// Lets the UI detect "identical snapshot" cheaply and detect import tampering.
export function stateFingerprint(state) {
  const bytes = encodeUtf8(canonicalStringify(state));
  return {
    crc: crc32(bytes),
    bytes,
    size: bytes.length,
  };
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}
