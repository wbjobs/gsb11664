// Lossless snapshot compression.
//
// Frame layout (little-endian):
//   magic      4 bytes  "LZ77"
//   version    1 byte   1
//   rawSize    uint32   uncompressed payload size
//   crc32      uint32   CRC32 of the uncompressed payload
//   flag       1 byte   0 = stored raw payload, 1 = LZ77 token stream
//   payload    raw bytes or token blocks
//
// Token block (deflate-style): one control byte describes up to 8 tokens,
// flags packed LSB-first. flag 0 => literal run [len-1 (1..256)][bytes],
// flag 1 => back-reference [offsetHi][offsetLo][len-3] (3..258, window 65535).
import { crc32 } from './util.js';

const MAGIC = [0x4c, 0x5a, 0x37, 0x37]; // "LZ77"
const VERSION = 1;
const MAX_OFFSET = 0xffff;
const MAX_MATCH = 258;
const MIN_MATCH = 3;
const MAX_LITERAL_RUN = 256;
const CHAIN_LIMIT = 48;

export class CompressionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompressionError';
  }
}

function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function makeFrame(raw, payload, flag) {
  if (raw.length > 0xffffffff) {
    throw new CompressionError('payload larger than 4 GiB is not supported');
  }
  const checksum = crc32(raw);
  const out = new Uint8Array(14 + payload.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out.set(u32(raw.length), 5);
  out.set(u32(checksum), 9);
  out[13] = flag;
  out.set(payload, 14);
  return out;
}

function hash3(input, pos) {
  return ((input[pos] << 16) | (input[pos + 1] << 8) | input[pos + 2]) >>> 0;
}

// LZ77 encoder: hash-chain based, purely byte-oriented so it never drops a byte.
function lz77Tokens(input) {
  const n = input.length;
  const head = new Map();
  const prev = new Int32Array(n).fill(-1);
  const tokens = [];
  let pos = 0;

  const matchLengthAt = (candidate, start, maxLen) => {
    let len = 0;
    while (len < maxLen && input[candidate + len] === input[start + len]) len += 1;
    return len;
  };

  while (pos < n) {
    let bestLen = 0;
    let bestOff = 0;
    if (pos + MIN_MATCH <= n) {
      const key = hash3(input, pos);
      let candidate = head.has(key) ? head.get(key) : -1;
      let chain = 0;
      while (candidate !== -1 && chain < CHAIN_LIMIT) {
        const offset = pos - candidate;
        if (offset > MAX_OFFSET) break;
        const maxLen = Math.min(MAX_MATCH, n - pos);
        if (input[candidate] === input[pos]) {
          const len = matchLengthAt(candidate, pos, maxLen);
          if (len > bestLen) {
            bestLen = len;
            bestOff = offset;
            if (len >= maxLen) break;
          }
        }
        candidate = prev[candidate];
        chain += 1;
      }
      prev[pos] = head.has(key) ? head.get(key) : -1;
      head.set(key, pos);
    }

    if (bestLen >= MIN_MATCH) {
      tokens.push({ off: bestOff, len: bestLen });
      for (let skip = 1; skip < bestLen; skip += 1) {
        const p = pos + skip;
        if (p + MIN_MATCH <= n) {
          const key = hash3(input, p);
          prev[p] = head.has(key) ? head.get(key) : -1;
          head.set(key, p);
        }
      }
      pos += bestLen;
    } else {
      // Merge consecutive literals into a single run token (<= 256 bytes);
      // one control bit always corresponds to exactly one emitted token.
      const last = tokens[tokens.length - 1];
      if (last && 'litStart' in last && last.litLen < MAX_LITERAL_RUN) {
        last.litLen += 1;
      } else {
        tokens.push({ litStart: pos, litLen: 1 });
      }
      pos += 1;
    }
  }
  return tokens;
}

function emitBlocks(input, tokens) {
  const body = [];
  for (let base = 0; base < tokens.length; base += 8) {
    const slice = tokens.slice(base, base + 8);
    let control = 0;
    slice.forEach((token, bit) => {
      if ('off' in token) control |= 1 << bit;
    });
    body.push(control);

    for (const token of slice) {
      if ('off' in token) {
        body.push((token.off >>> 8) & 0xff, token.off & 0xff, token.len - MIN_MATCH);
      } else {
        body.push(token.litLen - 1);
        for (let k = 0; k < token.litLen; k += 1) body.push(input[token.litStart + k]);
      }
    }
  }
  return new Uint8Array(body);
}

function lz77Decode(body, rawSize) {
  const out = new Uint8Array(rawSize);
  let inPos = 0;
  let outPos = 0;
  while (inPos < body.length) {
    const control = body[inPos];
    inPos += 1;
    for (let bit = 0; bit < 8 && outPos < rawSize; bit += 1) {
      if ((control & (1 << bit)) === 0) {
        const len = body[inPos] + 1;
        inPos += 1;
        if (inPos + len > body.length) {
          throw new CompressionError('truncated literal run');
        }
        if (outPos + len > rawSize) {
          throw new CompressionError('literal run exceeds declared size');
        }
        out.set(body.subarray(inPos, inPos + len), outPos);
        inPos += len;
        outPos += len;
      } else {
        if (inPos + 3 > body.length) throw new CompressionError('truncated back-reference');
        const off = (body[inPos] << 8) | body[inPos + 1];
        const len = body[inPos + 2] + MIN_MATCH;
        inPos += 3;
        if (off === 0 || off > outPos) {
          throw new CompressionError(`invalid back-reference offset ${off} at output ${outPos}`);
        }
        if (outPos + len > rawSize) {
          throw new CompressionError('back-reference exceeds declared size');
        }
        // Byte-by-byte copy because copies may overlap (RLE case).
        for (let k = 0; k < len; k += 1) out[outPos + k] = out[outPos - off + k];
        outPos += len;
      }
    }
  }
  if (outPos !== rawSize) {
    throw new CompressionError(`size mismatch: produced ${outPos}, expected ${rawSize}`);
  }
  return out;
}

export function compressBytes(input) {
  if (!(input instanceof Uint8Array)) {
    throw new CompressionError('compressBytes expects Uint8Array');
  }
  const compressed = emitBlocks(input, lz77Tokens(input));
  // Never enlarge: framing costs 14 bytes, raw frame is a safe fallback.
  if (compressed.length + 14 < input.length + 14) {
    return { bytes: makeFrame(input, compressed, 1), method: 'lz77', compressed: true };
  }
  return { bytes: makeFrame(input, input, 0), method: 'stored', compressed: false };
}

export function decompressBytes(framed) {
  if (!(framed instanceof Uint8Array) || framed.length < 14) {
    throw new CompressionError('snapshot frame too short');
  }
  if (MAGIC.some((m, i) => framed[i] !== m)) {
    throw new CompressionError('bad magic: not a snapshot frame');
  }
  const version = framed[4];
  if (version !== VERSION) {
    throw new CompressionError(`unsupported compression frame version ${version}`);
  }
  const rawSize =
    framed[5] | (framed[6] << 8) | (framed[7] << 16) | (framed[8] << 24);
  const expectedCrc =
    framed[9] | (framed[10] << 8) | (framed[11] << 16) | (framed[12] << 24);
  const flag = framed[13];
  const body = framed.subarray(14);
  const raw = flag === 0 ? body.slice() : lz77Decode(body, rawSize >>> 0);
  if (raw.length !== (rawSize >>> 0)) {
    throw new CompressionError('decompressed size mismatch');
  }
  const actualCrc = crc32(raw);
  if (actualCrc !== (expectedCrc >>> 0)) {
    throw new CompressionError(
      `CRC mismatch: snapshot data is corrupted (expected ${expectedCrc.toString(16)}, got ${actualCrc.toString(16)})`,
    );
  }
  return raw;
}
