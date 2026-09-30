/* Web Worker：无损 LZW 压缩/解压 + cyrb53 校验哈希
 * 压缩方案：字符串 -> UTF-8 字节 -> LZW（字母表 0-255，256=字典重置码）-> UTF-16 打包
 * 保证任意 Unicode 输入无损往返，且字典码永不超出 16 位。 */
'use strict';

const LZW_RESET = 256;
const LZW_DICT_MAX = 65535;

/* cyrb53 哈希：快速、确定性，用于完整性校验与冲突检测 */
function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/* WTF-8 风格 UTF-8 编码：孤立代理项也按码点编码，保证任意 JS 字符串无损 */
function utf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return bytes;
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b0 = bytes[i];
    let cp;
    if (b0 < 0x80) { cp = b0; }
    else if (b0 < 0xE0) { cp = ((b0 & 31) << 6) | (bytes[++i] & 63); }
    else if (b0 < 0xF0) { cp = ((b0 & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63); }
    else { cp = ((b0 & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63); }
    if (cp < 0x10000) out += String.fromCharCode(cp); // 含孤立代理项，原样还原
    else {
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
    }
  }
  return out;
}

function toBinaryString(str) {
  const bytes = utf8Encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.slice(i, i + CHUNK));
  }
  return bin;
}

function lzwCompress(input) {
  const bin = toBinaryString(input);
  const dict = new Map();
  let dictSize = 257;
  const out = [];
  let w = '';
  for (let i = 0; i < bin.length; i++) {
    const c = bin[i];
    const wc = w + c;
    if (w === '' || wc.length === 1 || dict.has(wc)) { w = wc; continue; }
    out.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    if (dictSize < LZW_DICT_MAX) {
      dict.set(wc, dictSize++);
    } else {
      out.push(LZW_RESET);
      dict.clear();
      dictSize = 257;
    }
    w = c;
  }
  if (w !== '') out.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  let res = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < out.length; i += CHUNK) {
    res += String.fromCharCode.apply(null, out.slice(i, i + CHUNK));
  }
  return res;
}

function lzwDecompress(packed) {
  let dict = new Map();
  let dictSize = 257;
  let result = '';
  let w = '';
  let first = true;
  for (let i = 0; i < packed.length; i++) {
    const k = packed.charCodeAt(i);
    if (k === LZW_RESET) { dict = new Map(); dictSize = 257; first = true; w = ''; continue; }
    let entry;
    if (k < 256) entry = String.fromCharCode(k);
    else if (dict.has(k)) entry = dict.get(k);
    else if (k === dictSize) entry = w + w[0];
    else throw new Error('解压失败：损坏的压缩数据 (code=' + k + ')');
    result += entry;
    if (first) first = false;
    else if (dictSize < LZW_DICT_MAX) dict.set(dictSize++, w + entry[0]);
    w = entry;
  }
  const bytes = Array.prototype.map.call(result, (ch) => ch.charCodeAt(0));
  return utf8Decode(bytes);
}

self.onmessage = (e) => {
  const { id, op, payload } = e.data;
  try {
    let result;
    if (op === 'compress') {
      const json = payload;
      const packed = lzwCompress(json);
      // 压缩后回读校验，确保无损；失败则回退原始存储
      const roundtrip = lzwDecompress(packed);
      if (roundtrip === json) {
        result = { algo: 'lzw', data: packed, hash: hash(json), rawSize: json.length, size: packed.length };
      } else {
        result = { algo: 'raw', data: json, hash: hash(json), rawSize: json.length, size: json.length };
      }
    } else if (op === 'decompress') {
      const json = payload.algo === 'lzw' ? lzwDecompress(payload.data) : payload.data;
      result = { json, hash: hash(json) };
    } else if (op === 'hash') {
      result = { hash: hash(payload) };
    } else {
      throw new Error('未知操作: ' + op);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
