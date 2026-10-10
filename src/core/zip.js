/**
 * zip.js —— 自研极简 ZIP 读写器（零依赖）。
 *
 * 写：只使用 store（不压缩）方式，兼容 Excel / WPS / Numbers / LibreOffice。
 * 读：支持 store 与 deflate，deflate 依赖浏览器内置 DecompressionStream
 *     （Chrome 80+ / Edge 80+ / Safari 16.4+ / Firefox 113+）。
 *
 * 纯逻辑模块，不触碰 DOM，可被 Node 单测直接引用。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32（ZIP 校验用） */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const utf8 = {
  encode: (text) => encoder.encode(text),
  decode: (bytes) => decoder.decode(bytes),
};

/** 本地时间 → MS-DOS 日期/时间对 */
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }
  u16(value) {
    return this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }
  u32(value) {
    return this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
  }
  concat() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/**
 * 打包为 ZIP。
 * @param {Array<{name: string, data: string|Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function zipSync(files) {
  const writer = new ByteWriter();
  const central = new ByteWriter();
  const { time, date } = dosDateTime();
  const entries = [];

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const offset = writer.length;

    writer.u32(0x04034b50);
    writer.u16(20);              // version needed
    writer.u16(0x0800);          // UTF-8 文件名标志
    writer.u16(0);               // 压缩方式：store
    writer.u16(time);
    writer.u16(date);
    writer.u32(crc);
    writer.u32(data.length);     // 压缩后大小
    writer.u32(data.length);     // 原始大小
    writer.u16(nameBytes.length);
    writer.u16(0);
    writer.push(nameBytes);
    writer.push(data);

    entries.push({ nameBytes, crc, size: data.length, offset });
  }

  for (const entry of entries) {
    central.u32(0x02014b50);
    central.u16(20);             // version made by
    central.u16(20);             // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(time);
    central.u16(date);
    central.u32(entry.crc);
    central.u32(entry.size);
    central.u32(entry.size);
    central.u16(entry.nameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(entry.offset);
    central.push(entry.nameBytes);
  }

  const centralBytes = central.concat();
  const body = writer.concat();

  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(centralBytes.length);
  end.u32(body.length);
  end.u16(0);

  const endBytes = end.concat();
  const out = new Uint8Array(body.length + centralBytes.length + endBytes.length);
  out.set(body, 0);
  out.set(centralBytes, body.length);
  out.set(endBytes, body.length + centralBytes.length);
  return out;
}

/** 在字节流中查找某个 4 字节签名（从后往前） */
function findSignature(bytes, signature, fromEnd = true) {
  const target = [
    signature & 0xff,
    (signature >>> 8) & 0xff,
    (signature >>> 16) & 0xff,
    (signature >>> 24) & 0xff,
  ];
  const read = (view, i) => view[i] === target[0] && view[i + 1] === target[1] && view[i + 2] === target[2] && view[i + 3] === target[3];
  if (fromEnd) {
    for (let i = bytes.length - 4; i >= 0; i -= 1) if (read(bytes, i)) return i;
    return -1;
  }
  for (let i = 0; i + 4 <= bytes.length; i += 1) if (read(bytes, i)) return i;
  return -1;
}

/**
 * 可插拔的解压实现。
 * 浏览器直接用内置 DecompressionStream（Chrome 80+ / Safari 16.4+ / Firefox 113+），
 * Node 环境（单测、CLI 脚本）通过 setInflateRaw 注入 zlib，避免在浏览器包里出现 node: 依赖。
 * @type {((bytes: Uint8Array) => Uint8Array)|null}
 */
let inflateImpl = null;

/** 注入自定义解压实现（Node 用 zlib.inflateRawSync） */
export function setInflateRaw(fn) {
  inflateImpl = typeof fn === 'function' ? fn : null;
}

/**
 * 解压 deflate-raw 数据。
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (inflateImpl) return inflateImpl(bytes);
  throw new Error('当前环境不支持 deflate 解压（缺少 DecompressionStream）');
}

export const zipSupport = {
  get canReadDeflate() {
    return typeof DecompressionStream !== 'undefined' || Boolean(inflateImpl);
  },
};

/**
 * 解包 ZIP。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function unzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const eocd = findSignature(bytes, 0x06054b50);
  if (eocd === -1) throw new Error('不是有效的 ZIP 文件（缺少 EOCD）');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);

  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    pointer += 46 + nameLength + extraLength + commentLength;

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`不支持的压缩方式: ${method}`);
  }
  return out;
}
