// PDF object reader: sequential object scan, indirect references, stream filters,
// object streams and the page tree. No external dependencies.
import zlib from 'node:zlib';

export class PdfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfError';
  }
}

const MAX_OBJECTS = 400000;
const MAX_DEPTH = 64;
const MAX_STREAM_BYTES = 96 * 1024 * 1024;

const isWhite = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
  c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c) => !isWhite(c) && !isDelim(c);

export const isName = (v) => v && typeof v === 'object' && v.t === 'name';
export const isRef = (v) => v && typeof v === 'object' && v.t === 'ref';
export const isDict = (v) => v && typeof v === 'object' && v.t === 'dict';
export const isArray = (v) => v && typeof v === 'object' && v.t === 'array';
export const isStream = (v) => isDict(v) && v.stream !== undefined;
export const isString = (v) => v && typeof v === 'object' && v.t === 'str';

/** Dictionary/array access without throwing on missing or malformed values. */
export function get(container, key) {
  if (!isDict(container)) return undefined;
  return container.map.get(key);
}

export function num(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && v.t === 'name') return fallback;
  return fallback;
}

/** Parse a PDF literal string body into raw bytes. */
function literalStringBytes(src, start) {
  const out = [];
  let i = start;
  let depth = 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) {
      const n = src.charCodeAt(i + 1);
      i += 2;
      if (n === 0x6e) out.push(0x0a);
      else if (n === 0x72) out.push(0x0d);
      else if (n === 0x74) out.push(0x09);
      else if (n === 0x62) out.push(0x08);
      else if (n === 0x66) out.push(0x0c);
      else if (n === 0x28 || n === 0x29 || n === 0x5c) out.push(n);
      else if (n === 0x0d) {
        if (src.charCodeAt(i) === 0x0a) i += 1;
      } else if (n === 0x0a) {
        // line continuation: emit nothing
      } else if (n >= 0x30 && n <= 0x37) {
        let oct = n - 0x30;
        let extra = 1;
        while (extra < 3) {
          const d = src.charCodeAt(i);
          if (d >= 0x30 && d <= 0x37) {
            oct = oct * 8 + (d - 0x30);
            i += 1;
            extra += 1;
          } else break;
        }
        out.push(oct & 0xff);
      } else if (Number.isNaN(n)) {
        break;
      } else out.push(n & 0xff);
      continue;
    }
    if (c === 0x28) {
      depth += 1;
      out.push(c);
      i += 1;
      continue;
    }
    if (c === 0x29) {
      depth -= 1;
      i += 1;
      if (depth === 0) return { bytes: Uint8Array.from(out), end: i };
      out.push(c);
      continue;
    }
    out.push(c & 0xff);
    i += 1;
  }
  return { bytes: Uint8Array.from(out), end: i };
}

function hexStringBytes(body) {
  const clean = body.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Token reader over a latin1 view of the file bytes. */
class Reader {
  constructor(src, pos = 0) {
    this.src = src;
    this.pos = pos;
    this.depth = 0;
  }

  skipSpace() {
    const src = this.src;
    while (this.pos < src.length) {
      const c = src.charCodeAt(this.pos);
      if (isWhite(c)) {
        this.pos += 1;
        continue;
      }
      if (c === 0x25) {
        while (this.pos < src.length && src.charCodeAt(this.pos) !== 0x0a && src.charCodeAt(this.pos) !== 0x0d) this.pos += 1;
        continue;
      }
      break;
    }
  }

  readKeyword() {
    const start = this.pos;
    const src = this.src;
    while (this.pos < src.length) {
      const c = src.charCodeAt(this.pos);
      if (!isRegular(c)) break;
      this.pos += 1;
    }
    return src.slice(start, this.pos);
  }

  /** Read one object value. Returns undefined at end of input. */
  readValue() {
    if (this.depth > MAX_DEPTH) throw new PdfError('PDF nesting too deep');
    this.skipSpace();
    if (this.pos >= this.src.length) return undefined;
    const src = this.src;
    const c = src.charCodeAt(this.pos);

    if (c === 0x2f) {
      this.pos += 1;
      let name = '';
      while (this.pos < src.length) {
        const d = src.charCodeAt(this.pos);
        if (!isRegular(d)) break;
        name += src[this.pos];
        this.pos += 1;
      }
      return { t: 'name', v: name.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 0x28) {
      const { bytes, end } = literalStringBytes(src, this.pos + 1);
      this.pos = end;
      return { t: 'str', bytes };
    }
    if (c === 0x3c && src.charCodeAt(this.pos + 1) === 0x3c) {
      this.pos += 2;
      const map = new Map();
      this.depth += 1;
      for (;;) {
        this.skipSpace();
        if (this.pos >= src.length) break;
        if (src.charCodeAt(this.pos) === 0x3e && src.charCodeAt(this.pos + 1) === 0x3e) {
          this.pos += 2;
          break;
        }
        const key = this.readValue();
        if (!isName(key)) continue;
        const value = this.readValue();
        if (value === undefined) break;
        map.set(key.v, value);
      }
      this.depth -= 1;
      return { t: 'dict', map };
    }
    if (c === 0x3c) {
      const close = src.indexOf('>', this.pos + 1);
      const end = close === -1 ? src.length : close;
      const body = src.slice(this.pos + 1, end);
      this.pos = end + 1;
      return { t: 'str', bytes: hexStringBytes(body) };
    }
    if (c === 0x5b) {
      this.pos += 1;
      const arr = [];
      this.depth += 1;
      for (;;) {
        this.skipSpace();
        if (this.pos >= src.length) break;
        if (src.charCodeAt(this.pos) === 0x5d) {
          this.pos += 1;
          break;
        }
        const value = this.readValue();
        if (value === undefined) break;
        arr.push(value);
      }
      this.depth -= 1;
      return { t: 'array', v: arr };
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x29) {
      this.pos += 1;
      return { t: 'op', v: src[this.pos - 1] };
    }

    const start = this.pos;
    const word = this.readKeyword();
    if (word === '') {
      this.pos += 1;
      return { t: 'op', v: src[this.pos - 1] };
    }
    if (word === 'true') return { t: 'bool', v: true };
    if (word === 'false') return { t: 'bool', v: false };
    if (word === 'null') return { t: 'null' };
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const value = Number(word);
      // Possible indirect reference "num gen R".
      const save = this.pos;
      if (Number.isInteger(value) && value >= 0) {
        this.skipSpace();
        const genStart = this.pos;
        const genWord = this.readKeyword();
        if (/^\d+$/.test(genWord)) {
          this.skipSpace();
          const rStart = this.pos;
          const rWord = this.readKeyword();
          if (rWord === 'R') return { t: 'ref', num: value, gen: Number(genWord) };
          this.pos = rStart;
        }
        this.pos = runeSafeReset(genStart, save);
      }
      return value;
    }
    if (word === 'R') return { t: 'op', v: 'R' };
    return { t: 'op', v: word, start };
  }
}

/** Restore the reader when an indirect-reference lookahead did not apply. */
function runeSafeReset(_genStart, save) {
  return save;
}

function decodeFilters(dict, bytes, doc) {
  let filters = doc.resolve(get(dict, 'Filter'));
  let params = doc.resolve(get(dict, 'DecodeParms')) ?? doc.resolve(get(dict, 'DP'));
  if (filters === undefined) return bytes;
  if (!isArray(filters)) filters = { t: 'array', v: [filters] };
  if (!isArray(params)) params = { t: 'array', v: [params] };
  let out = bytes;
  for (let i = 0; i < filters.v.length; i += 1) {
    const filter = doc.resolve(filters.v[i]);
    if (!isName(filter)) continue;
    const parm = doc.resolve(params.v[i]);
    out = applyFilter(filter.v, out, isDict(parm) ? parm : undefined, doc);
    if (out === undefined) return undefined;
  }
  return out;
}

function applyFilter(name, bytes, parms, doc) {
  switch (name) {
    case 'FlateDecode':
    case 'Fl': {
      let inflated;
      try {
        inflated = zlib.inflateSync(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        try {
          inflated = zlib.inflateRawSync(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch {
          return undefined;
        }
      }
      return applyPredictor(inflated, parms, doc);
    }
    case 'ASCIIHexDecode':
    case 'AHx':
      return Buffer.from(hexStringBytes(Buffer.from(bytes).toString('latin1')));
    case 'ASCII85Decode':
    case 'A85':
      return ascii85(bytes);
    case 'LZWDecode':
    case 'LZW':
      return applyPredictor(lzw(bytes, doc.resolve(get(parms, 'EarlyChange')) !== 0), parms, doc);
    case 'RunLengthDecode':
    case 'RL':
      return runLength(bytes);
    default:
      return undefined; // image codecs are not text
  }
}

function ascii85(bytes) {
  const s = Buffer.from(bytes).toString('latin1').replace(/\s+/g, '');
  const out = [];
  let chunk = '';
  for (let i = 0; i < s.length && s[i] !== '~'; i += 1) {
    const ch = s[i];
    if (ch === 'z' && chunk === '') {
      out.push(0, 0, 0, 0);
      continue;
    }
    chunk += ch;
    if (chunk.length === 5) {
      let value = 0;
      for (const d of chunk) value = value * 85 + (d.charCodeAt(0) - 33);
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      chunk = '';
    }
  }
  if (chunk.length > 0) {
    const pad = 5 - chunk.length;
    chunk += 'u'.repeat(pad);
    let value = 0;
    for (const d of chunk) value = value * 85 + (d.charCodeAt(0) - 33);
    const four = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...four.slice(0, 4 - pad));
  }
  return Uint8Array.from(out);
}

function lzw(bytes, earlyChange) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i += 1) dict.push([i]);
    dict.push(null, null);
  };
  reset();
  let bitBuf = 0;
  let bitLen = 0;
  let pos = 0;
  let codeLen = 9;
  let prev = null;
  const nextByte = () => (pos < bytes.length ? bytes[pos++] : -1);
  for (;;) {
    while (bitLen < codeLen) {
      const byte = nextByte();
      if (byte < 0) return Uint8Array.from(out);
      bitBuf = (bitBuf << 8) | byte;
      bitLen += 8;
    }
    const code = (bitBuf >> (bitLen - codeLen)) & ((1 << codeLen) - 1);
    bitLen -= codeLen;
    if (code === 256) {
      reset();
      codeLen = 9;
      prev = null;
      continue;
    }
    if (code === 257) return Uint8Array.from(out);
    let entry;
    if (code < dict.length && dict[code] !== null) entry = dict[code];
    else if (prev !== null) entry = prev.concat([prev[0]]);
    else return Uint8Array.from(out);
    out.push(...entry);
    if (prev !== null) dict.push(prev.concat([entry[0]]));
    prev = entry;
    const threshold = dict.length + (earlyChange ? 1 : 0);
    if (threshold >= 512 && codeLen === 9) codeLen = 10;
    else if (threshold >= 1024 && codeLen === 10) codeLen = 11;
    else if (threshold >= 2048 && codeLen === 11) codeLen = 12;
    if (dict.length > 4096) {
      reset();
      codeLen = 9;
      prev = null;
    }
  }
}

function runLength(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const n = bytes[i];
    i += 1;
    if (n === 128) break;
    if (n < 128) {
      for (let j = 0; j <= n && i < bytes.length; j += 1) out.push(bytes[i++]);
    } else if (n > 128) {
      const value = bytes[i++];
      for (let j = 0; j < 257 - n; j += 1) out.push(value);
    }
  }
  return Uint8Array.from(out);
}

function applyPredictor(data, parms, doc) {
  if (!isDict(parms)) return data;
  const predictor = num(doc.resolve(get(parms, 'Predictor')), 1);
  if (predictor <= 1) return data;
  const colors = num(doc.resolve(get(parms, 'Colors')), 1);
  const bpc = num(doc.resolve(get(parms, 'BitsPerComponent')), 8);
  const columns = num(doc.resolve(get(parms, 'Columns')), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  if (predictor === 2) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const left = i % rowLen >= bpp ? out[i - bpp] : 0;
      out[i] = (data[i] + left) & 0xff;
    }
    return out;
  }
  // PNG predictors: each row is prefixed with its filter type byte.
  const out = [];
  let prevRow = new Uint8Array(rowLen);
  for (let i = 0; i + 1 <= data.length; i += rowLen + 1) {
    const type = data[i];
    const row = data.subarray(i + 1, i + 1 + rowLen);
    const cur = new Uint8Array(rowLen);
    for (let x = 0; x < rowLen; x += 1) {
      const raw = row[x] ?? 0;
      const left = x >= bpp ? cur[x - bpp] : 0;
      const up = prevRow[x] ?? 0;
      const upLeft = x >= bpp ? (prevRow[x - bpp] ?? 0) : 0;
      let value;
      switch (type) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: value = raw;
      }
      cur[x] = value & 0xff;
    }
    out.push(...cur);
    prevRow = cur;
  }
  return Uint8Array.from(out);
}

/** One parsed PDF document. */
export class PdfDocument {
  constructor(buf) {
    if (!buf || buf.length < 8) throw new PdfError('empty or unreadable PDF');
    const header = Buffer.from(buf.subarray(0, 1024)).toString('latin1');
    if (!header.includes('%PDF-')) throw new PdfError('not a PDF (missing %PDF header)');
    this.bytes = buf;
    this.src = Buffer.from(buf).toString('latin1');
    this.objects = new Map();
    this.objStmDone = false;
    this.pageCache = undefined;
    if (/\/Encrypt\b/.test(this.src.slice(-65536)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(this.src)) {
      const encrypted = this.scanForEncrypt();
      if (encrypted) throw new PdfError('encrypted PDF: text extraction is not supported');
    }
    this.scanObjects();
  }

  scanForEncrypt() {
    let idx = this.src.indexOf('/Encrypt');
    while (idx !== -1) {
      const after = this.src.slice(idx + 8, idx + 40);
      if (/^\s*(<<|\d+\s+\d+\s+R)/.test(after)) return true;
      idx = this.src.indexOf('/Encrypt', idx + 8);
    }
    return false;
  }

  /** Sequentially parse every "N G obj ... endobj" run, skipping stream bodies. */
  scanObjects() {
    const src = this.src;
    let pos = 0;
    let count = 0;
    for (;;) {
      const objIdx = src.indexOf('obj', pos);
      if (objIdx === -1) break;
      // "obj" must be preceded by "N G " and not be part of a longer keyword.
      const before = src.slice(Math.max(0, objIdx - 40), objIdx);
      const m = /(\d+)\s+(\d+)\s*$/.exec(before);
      if (!m || (objIdx > 0 && isRegular(src.charCodeAt(objIdx - 1)))) {
        pos = objIdx + 3;
        continue;
      }
      const number = Number(m[1]);
      const gen = Number(m[2]);
      const reader = new Reader(src, objIdx + 3);
      let value;
      try {
        value = reader.readValue();
      } catch {
        pos = objIdx + 3;
        continue;
      }
      if (value === undefined) break;
      reader.skipSpace();
      let streamStart = -1;
      if (isDict(value)) {
        const save = reader.pos;
        const keyword = reader.readKeyword();
        if (keyword === 'stream') {
          streamStart = reader.pos;
          if (src.charCodeAt(streamStart) === 0x0d) streamStart += 1;
          if (src.charCodeAt(streamStart) === 0x0a) streamStart += 1;
        } else {
          reader.pos = save;
        }
      }
      const entry = { number, gen, value, streamStart, streamEnd: -1, data: undefined };
      if (streamStart >= 0) {
        const length = this.directLength(value);
        let end = -1;
        if (length !== undefined && length >= 0 && streamStart + length <= src.length) {
          const tail = src.slice(streamStart + length, streamStart + length + 20);
          if (/^\s*endstream/.test(tail)) end = streamStart + length;
        }
        if (end < 0) {
          const marker = src.indexOf('endstream', streamStart);
          end = marker === -1 ? src.length : marker;
          // Trim the EOL that precedes endstream.
          if (src.charCodeAt(end - 1) === 0x0a) end -= 1;
          if (src.charCodeAt(end - 1) === 0x0d) end -= 1;
        }
        entry.streamEnd = end;
        pos = Math.max(end, objIdx + 3);
      } else {
        pos = reader.pos;
      }
      if (!this.objects.has(number)) this.objects.set(number, []);
      this.objects.get(number).push(entry);
      count += 1;
      if (count > MAX_OBJECTS) throw new PdfError('PDF object count exceeds the supported limit');
    }
    if (this.objects.size === 0) throw new PdfError('no PDF objects found');
  }

  directLength(dict) {
    const value = get(dict, 'Length');
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
  }

  /** Resolve indirect references recursively over a plain value. */
  resolve(value, seen = 0) {
    if (seen > MAX_DEPTH) return undefined;
    if (!isRef(value)) return value;
    return this.resolve(this.lookup(value.num), seen + 1);
  }

  lookup(number) {
    const list = this.objects.get(number);
    if (list === undefined) {
      this.loadObjectStreams();
      const again = this.objects.get(number);
      return again === undefined ? undefined : again[again.length - 1].value;
    }
    // Later definitions win; earlier ones are usually superseded revisions.
    return list[list.length - 1].value;
  }

  entry(number) {
    const list = this.objects.get(number);
    if (list === undefined) {
      this.loadObjectStreams();
      const again = this.objects.get(number);
      return again === undefined ? undefined : again[again.length - 1];
    }
    return list[list.length - 1];
  }

  /** Expand /Type /ObjStm containers into addressable objects. */
  loadObjectStreams() {
    if (this.objStmDone) return;
    this.objStmDone = true;
    const containers = [];
    for (const [, list] of this.objects) {
      for (const entry of list) if (isDict(entry.value) && isName(this.resolve(get(entry.value, 'Type'))) && this.resolve(get(entry.value, 'Type')).v === 'ObjStm') containers.push(entry);
    }
    for (const entry of containers) {
      let data;
      try {
        data = this.streamData(entry);
      } catch {
        continue;
      }
      if (data === undefined) continue;
      const n = num(this.resolve(get(entry.value, 'N')), 0);
      const first = num(this.resolve(get(entry.value, 'First')), 0);
      const head = Buffer.from(data.subarray(0, Math.min(first, data.length))).toString('latin1');
      const numbers = head.trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i += 1) {
        const objNum = numbers[i * 2];
        const offset = numbers[i * 2 + 1];
        if (!Number.isInteger(objNum) || !Number.isInteger(offset)) continue;
        if (this.objects.has(objNum)) continue;
        const src = Buffer.from(data).toString('latin1');
        const reader = new Reader(src, first + offset);
        let value;
        try {
          value = reader.readValue();
        } catch {
          continue;
        }
        if (value === undefined) continue;
        this.objects.set(objNum, [{ number: objNum, gen: 0, value, streamStart: -1, streamEnd: -1, data: undefined }]);
      }
    }
  }

  streamData(entry) {
    if (entry.data !== undefined) return entry.data;
    if (entry.streamStart < 0) return undefined;
    if (entry.streamEnd - entry.streamStart > MAX_STREAM_BYTES) {
      entry.data = undefined;
      return undefined;
    }
    let raw = new Uint8Array(this.bytes.subarray(entry.streamStart, entry.streamEnd));
    const dict = entry.value;
    const filter = this.resolve(get(dict, 'Filter'));
    if (filter === undefined) {
      entry.data = raw;
      return raw;
    }
    raw = decodeFilters(dict, raw, this);
    entry.data = raw;
    return raw;
  }

  /** Catalog dictionary, located without relying on the xref table. */
  catalog() {
    for (const [, list] of this.objects) {
      for (const entry of list) {
        if (isDict(entry.value) && isName(this.resolve(get(entry.value, 'Type'))) && this.resolve(get(entry.value, 'Type')).v === 'Catalog') return entry.value;
      }
    }
    this.loadObjectStreams();
    for (const [, list] of this.objects) {
      for (const entry of list) {
        if (isDict(entry.value) && isName(this.resolve(get(entry.value, 'Type'))) && this.resolve(get(entry.value, 'Type')).v === 'Catalog') return entry.value;
      }
    }
    return undefined;
  }

  /** Ordered page dictionaries, carrying inherited Resources and MediaBox. */
  pages() {
    if (this.pageCache !== undefined) return this.pageCache;
    const catalog = this.catalog();
    const root = catalog === undefined ? undefined : this.resolve(get(catalog, 'Pages'));
    const out = [];
    const walk = (node, inherited, depth) => {
      if (depth > MAX_DEPTH || out.length > 20000) return;
      const dict = this.resolve(node);
      if (!isDict(dict)) return;
      const type = this.resolve(get(dict, 'Type'));
      const next = {
        resources: this.resolve(get(dict, 'Resources')) ?? inherited.resources,
        mediaBox: this.resolve(get(dict, 'MediaBox')) ?? inherited.mediaBox,
        rotate: this.resolve(get(dict, 'Rotate')) ?? inherited.rotate,
      };
      const kids = this.resolve(get(dict, 'Kids'));
      if (isArray(kids) && (type === undefined || type.v !== 'Page')) {
        for (const kid of kids.v) walk(kid, next, depth + 1);
        return;
      }
      if (type !== undefined && type.v === 'Page') out.push({ dict, resources: next.resources, mediaBox: next.mediaBox, rotate: next.rotate });
      else if (isArray(kids)) for (const kid of kids.v) walk(kid, next, depth + 1);
    };
    if (root !== undefined) walk(root, {}, 0);
    if (out.length === 0) {
      // Fallback: any object that looks like a page, in object-number order.
      const numbers = [...this.objects.keys()].sort((a, b) => a - b);
      for (const number of numbers) {
        const value = this.resolve({ t: 'ref', num: number, gen: 0 });
        if (!isDict(value)) continue;
        const type = this.resolve(get(value, 'Type'));
        if (isName(type) && type.v === 'Page') {
          out.push({ dict: value, resources: this.resolve(get(value, 'Resources')), mediaBox: this.resolve(get(value, 'MediaBox')), rotate: this.resolve(get(value, 'Rotate')) });
        }
      }
    }
    this.pageCache = out;
    return out;
  }

  /** Concatenated decoded content stream bytes for one page. */
  pageContent(page) {
    const contents = this.resolve(get(page.dict, 'Contents'));
    const parts = [];
    const push = (value) => {
      const resolved = this.resolve(value);
      if (isStream(resolved) || isDict(resolved)) {
        const entry = this.findEntryOfValue(resolved);
        if (entry !== undefined) {
          const data = this.streamData(entry);
          if (data !== undefined) parts.push(Buffer.from(data));
        }
      }
    };
    if (isArray(contents)) for (const item of contents.v) push(item);
    else if (contents !== undefined) push(contents);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = Buffer.concat(parts, total);
    return joined.toString('latin1');
  }

  findEntryOfValue(value) {
    for (const [, list] of this.objects) {
      for (const entry of list) if (entry.value === value) return entry;
    }
    return undefined;
  }

  get info() {
    const catalog = this.catalog();
    return { pageCount: this.pages().length, hasCatalog: catalog !== undefined };
  }
}

export function openPdf(bytes) {
  return new PdfDocument(bytes);
}

export const pdfHelpers = { get, isName, isRef, isDict, isArray, isStream, isString, num };
