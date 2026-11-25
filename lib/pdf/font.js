// Font decoding: ToUnicode CMaps, simple-font encodings, glyph-name fallback,
// and glyph widths for text positioning. Covers the encodings academic PDFs use.
import { get, isArray, isDict, isName, isRef, isStream, num } from './read.js';

const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const MAC_ROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\u0000ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** Glyph names used by TeX and Latin fonts, mapped to Unicode text. */
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  exclamdown: '¡', cent: '¢', sterling: '£', fraction: '⁄', yen: '¥', florin: 'ƒ', section: '§',
  currency: '¤', quotedblleft: '“', guillemotleft: '«', guilsinglleft: '‹', guilsinglright: '›',
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', endash: '–', emdash: '—', dagger: '†',
  daggerdbl: '‡', periodcentered: '·', paragraph: '¶', bullet: '•', quotesinglbase: '‚',
  quotedblbase: '„', quotedblright: '”', guillemotright: '»', ellipsis: '…', perthousand: '‰',
  questiondown: '¿', acute: '´', circumflex: 'ˆ', tilde: '˜', macron: '¯', breve: '˘',
  dotaccent: '˙', dieresis: '¨', ring: '˚', cedilla: '¸', hungarumlaut: '˝', ogonek: '˛',
  caron: 'ˇ', Lslash: 'Ł', lslash: 'ł', OE: 'Œ', oe: 'œ', Scaron: 'Š', scaron: 'š', Ydieresis: 'Ÿ',
  Zcaron: 'Ž', zcaron: 'ž', dotlessi: 'ı', dotlessj: 'ȷ', germandbls: 'ß', AE: 'Æ', ae: 'æ',
  Oslash: 'Ø', oslash: 'ø', Aring: 'Å', aring: 'å', Eth: 'Ð', eth: 'ð', Thorn: 'Þ', thorn: 'þ',
  multiply: '×', divide: '÷', minus: '−', plusminus: '±', logicalnot: '¬', mu: 'µ', registered: '®',
  copyright: '©', trademark: '™', degree: '°', brokenbar: '¦', onesuperior: '¹', twosuperior: '²',
  threesuperior: '³', onequarter: '¼', onehalf: '½', threequarters: '¾', nbspace: '\u00a0',
  emspace: ' ', enspace: ' ', thinspace: ' ', sfthyphen: '\u00ad', softhyphen: '\u00ad',
  ffraktur: '𝔣', doublestruck: ' ', checkmark: '✓', star: '⋆', circlemultiply: '⊗', circleplus: '⊕',
  element: '∈', notelement: '∉', subset: '⊂', superset: '⊃', union: '∪', intersection: '∩',
  infinity: '∞', summation: '∑', product: '∏', integral: '∫', radical: '√', approxequal: '≈',
  notequal: '≠', lessequal: '≤', greaterequal: '≥', arrowright: '→', arrowleft: '←',
  arrowboth: '↔', arrowup: '↑', arrowdown: '↓', periodcentered_two: '·', middot: '·',
};

const ACCENTED = {
  Aacute: 'Á', aacute: 'á', Abreve: 'Ă', abreve: 'ă', Acircumflex: 'Â', acircumflex: 'â',
  Adieresis: 'Ä', adieresis: 'ä', Agrave: 'À', agrave: 'à', Aogonek: 'Ą', aogonek: 'ą', Atilde: 'Ã',
  atilde: 'ã', Cacute: 'Ć', cacute: 'ć', Ccaron: 'Č', ccaron: 'č', Ccedilla: 'Ç', ccedilla: 'ç',
  Dcaron: 'Ď', dcaron: 'ď', Dcroat: 'Đ', dcroat: 'đ', Eacute: 'É', eacute: 'é', Ebreve: 'Ĕ',
  ebreve: 'ĕ', Ecaron: 'Ě', ecaron: 'ě', Ecircumflex: 'Ê', ecircumflex: 'ê', Edieresis: 'Ë',
  edieresis: 'ë', Edotaccent: 'Ė', edotaccent: 'ė', Egrave: 'È', egrave: 'è', Eogonek: 'Ę',
  eogonek: 'ę', Gbreve: 'Ğ', gbreve: 'ğ', Gcaron: 'Ǧ', gcaron: 'ǧ', Idieresis: 'Ï', idieresis: 'ï',
  Iacute: 'Í', iacute: 'í', Icircumflex: 'Î', icircumflex: 'î', Igrave: 'Ì', igrave: 'ì',
  Iogonek: 'Į', iogonek: 'į', Itilde: 'Ĩ', itilde: 'ĩ', Lacute: 'Ĺ', lacute: 'ĺ', Lcaron: 'Ľ',
  lcaron: 'ľ', Nacute: 'Ń', nacute: 'ń', Ncaron: 'Ň', ncaron: 'ň', Ntilde: 'Ñ', ntilde: 'ñ',
  Oacute: 'Ó', oacute: 'ó', Ocircumflex: 'Ô', ocircumflex: 'ô', Odieresis: 'Ö', odieresis: 'ö',
  Ograve: 'Ò', ograve: 'ò', Ohungarumlaut: 'Ő', ohungarumlaut: 'ő', Otilde: 'Õ', otilde: 'õ',
  Racute: 'Ŕ', racute: 'ŕ', Rcaron: 'Ř', rcaron: 'ř', Sacute: 'Ś', sacute: 'ś', Scedilla: 'Ş',
  scedilla: 'ş', Tcaron: 'Ť', tcaron: 'ť', Uacute: 'Ú', uacute: 'ú', Ucircumflex: 'Û',
  ucircumflex: 'û', Udieresis: 'Ü', udieresis: 'ü', Ugrave: 'Ù', ugrave: 'ù', Uhungarumlaut: 'Ű',
  uhungarumlaut: 'ű', Uogonek: 'Ų', uogonek: 'ų', Uring: 'Ů', uring: 'ů', Yacute: 'Ý', yacute: 'ý',
  Ydieresis: 'Ÿ', ydieresis: 'ÿ', Zacute: 'Ź', zacute: 'ź', Zdotaccent: 'Ż', zdotaccent: 'ż',
  aogonek_alt: 'ą', ccedilla_alt: 'ç', Eogonek2: 'Ę', scommaaccent: 'ș', tcommaaccent: 'ț',
};

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ',
  Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ',
  Omega: 'Ω', epsilon1: 'ϵ', theta1: 'ϑ', phi1: 'ϕ', sigma1: 'ς', omegapi: 'ϖ', Upsilon1: 'ϒ',
};

/** Resolve a glyph name to its Unicode text, or '' when unknown. */
export function glyphToText(name) {
  if (!name) return '';
  if (name.length === 1) return name;
  const direct = GLYPHS[name] ?? ACCENTED[name] ?? GREEK[name];
  if (direct !== undefined) return direct;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return safeFromCodePoint(parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return safeFromCodePoint(parseInt(u[1], 16));
  const base = /^([A-Za-z]+)\.(?:sc|alt|sup|oldstyle|swash|small)$/.exec(name);
  if (base) return glyphToText(base[1]);
  // TeX style names such as "eacute.sc" or "ffi.sc" are handled above; "g12" is a slot name.
  return '';
}

function safeFromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

function winAnsiTable() {
  const table = new Array(256).fill('');
  for (let i = 0x20; i < 0x7f; i += 1) table[i] = String.fromCharCode(i);
  for (let i = 0xa0; i < 0x100; i += 1) table[i] = String.fromCharCode(i);
  for (let i = 0; i < WIN_ANSI_HIGH.length; i += 1) table[0x80 + i] = WIN_ANSI_HIGH[i];
  return table;
}

function macRomanTable() {
  const table = new Array(256).fill('');
  for (let i = 0x20; i < 0x7f; i += 1) table[i] = String.fromCharCode(i);
  for (let i = 0; i < MAC_ROMAN_HIGH.length; i += 1) table[0x80 + i] = MAC_ROMAN_HIGH[i];
  return table;
}

function standardTable() {
  const table = new Array(256).fill('');
  for (let i = 0x20; i < 0x7f; i += 1) table[i] = String.fromCharCode(i);
  table[0x27] = '’';
  table[0x60] = '‘';
  return table;
}

const WIN_ANSI = winAnsiTable();
const MAC_ROMAN = macRomanTable();
const STANDARD = standardTable();

function baseEncodingTable(name) {
  if (name === 'WinAnsiEncoding') return [...WIN_ANSI];
  if (name === 'MacRomanEncoding') return [...MAC_ROMAN];
  if (name === 'StandardEncoding') return [...STANDARD];
  return undefined;
}

/** Parse a /ToUnicode CMap stream into a code -> text map. */
function parseToUnicode(data) {
  const src = Buffer.from(data).toString('latin1');
  const map = new Map();
  const decodeUtf16 = (hex) => {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const unit = parseInt(hex.slice(i, i + 4), 16);
      if (!Number.isFinite(unit)) continue;
      out += String.fromCharCode(unit);
    }
    return out;
  };
  const blockRe = /begin(bfchar|bfrange)([\s\S]*?)end\1/g;
  let block;
  while ((block = blockRe.exec(src)) !== null) {
    const body = block[2];
    if (block[1] === 'bfchar') {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
      let pair;
      while ((pair = pairRe.exec(body)) !== null) {
        map.set(parseInt(pair[1], 16), decodeUtf16(pair[2]));
      }
      continue;
    }
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
    let range;
    while ((range = rangeRe.exec(body)) !== null) {
      const from = parseInt(range[1], 16);
      const to = parseInt(range[2], 16);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
      if (range[3].startsWith('<')) {
        const baseHex = range[4] ?? '';
        const prefix = baseHex.slice(0, Math.max(0, baseHex.length - 4));
        const last = parseInt(baseHex.slice(-4), 16);
        for (let code = from; code <= to && code - from < 65536; code += 1) {
          const unit = Number.isFinite(last) ? last + (code - from) : code;
          map.set(code, decodeUtf16(prefix + unit.toString(16).padStart(4, '0')));
        }
      } else {
        const items = [...(range[5] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)].map((m) => m[1]);
        for (let i = 0; i < items.length; i += 1) map.set(from + i, decodeUtf16(items[i]));
      }
    }
  }
  return map;
}

function streamOf(doc, value) {
  const resolved = doc.resolve(value);
  if (resolved === undefined) return undefined;
  if (isRef(value)) {
    const entry = doc.entry(value.num);
    return entry === undefined ? undefined : doc.streamData(entry);
  }
  const entry = doc.findEntryOfValue(resolved);
  return entry === undefined ? undefined : doc.streamData(entry);
}

/**
 * Build a decoder for one /Font dictionary.
 * Returns { decode(bytes, isEnd) => { text, widthEm, space }, wordSpacingEm, twoByte }.
 */
export function createFont(doc, fontDict) {
  const subtype = doc.resolve(get(fontDict, 'Subtype'));
  const subtypeName = isName(subtype) ? subtype.v : '';
  const toUnicodeData = streamOf(doc, get(fontDict, 'ToUnicode'));
  const toUnicode = toUnicodeData === undefined ? undefined : parseToUnicode(toUnicodeData);
  const isType0 = subtypeName === 'Type0';

  if (isType0) {
    const descendants = doc.resolve(get(fontDict, 'DescendantFonts'));
    const cid = isArray(descendants) ? doc.resolve(descendants.v[0]) : undefined;
    const defaultWidth = num(doc.resolve(get(cid, 'DW')), 1000);
    const widths = new Map();
    const wArray = doc.resolve(get(cid, 'W'));
    if (isArray(wArray)) {
      const items = wArray.v.map((item) => doc.resolve(item));
      let i = 0;
      while (i < items.length) {
        const first = items[i];
        const second = items[i + 1];
        if (typeof first !== 'number') {
          i += 1;
          continue;
        }
        if (isArray(second)) {
          for (let k = 0; k < second.v.length; k += 1) widths.set(first + k, num(doc.resolve(second.v[k]), defaultWidth));
          i += 2;
        } else {
          const last = second;
          const width = items[i + 2];
          if (typeof last === 'number' && typeof width === 'number') {
            for (let code = first; code <= last && code - first < 65536; code += 1) widths.set(code, width);
          }
          i += 3;
        }
      }
    }
    return {
      twoByte: true,
      widthOf: (code) => widths.get(code) ?? defaultWidth,
      textOf: (code) => (toUnicode === undefined ? '' : (toUnicode.get(code) ?? '')),
    };
  }

  // Simple fonts (Type1, TrueType, Type3, MMType1).
  const encodingValue = doc.resolve(get(fontDict, 'Encoding'));
  let table;
  if (isName(encodingValue)) table = baseEncodingTable(encodingValue.v);
  else if (isDict(encodingValue)) table = baseEncodingTable(isName(doc.resolve(get(encodingValue, 'BaseEncoding'))) ? doc.resolve(get(encodingValue, 'BaseEncoding')).v : '');
  if (table === undefined) table = [...STANDARD];
  if (isDict(encodingValue)) {
    const differences = doc.resolve(get(encodingValue, 'Differences'));
    if (isArray(differences)) {
      let code = 0;
      for (const item of differences.v) {
        const value = doc.resolve(item);
        if (typeof value === 'number') {
          code = value;
          continue;
        }
        if (isName(value)) {
          const text = glyphToText(value.v);
          if (code >= 0 && code < 256) table[code] = text;
          code += 1;
        }
      }
    }
  }
  const firstChar = num(doc.resolve(get(fontDict, 'FirstChar')), 0);
  const widthsValue = doc.resolve(get(fontDict, 'Widths'));
  const widths = isArray(widthsValue) ? widthsValue.v.map((item) => num(doc.resolve(item), 500)) : undefined;
  const defaultWidth = num(doc.resolve(get(fontDict, 'MissingWidth')), 0) || 500;
  const symbolic = isName(doc.resolve(get(fontDict, 'Encoding'))) === false && !isDict(encodingValue) && subtypeName === 'TrueType';

  return {
    twoByte: false,
    widthOf: (code) => {
      if (widths === undefined) return 500;
      const index = code - firstChar;
      return index >= 0 && index < widths.length ? widths[index] : defaultWidth;
    },
    textOf: (code) => {
      if (toUnicode !== undefined) {
        const mapped = toUnicode.get(code);
        if (mapped !== undefined && mapped !== '') return mapped;
      }
      const direct = table[code];
      if (direct !== undefined && direct !== '') return direct;
      if (code >= 0x20 && code < 0x7f) return String.fromCharCode(code);
      return symbolic ? '' : '';
    },
  };
}

/** Default decoder used when a font resource cannot be resolved. */
export const fallbackFont = {
  twoByte: false,
  widthOf: () => 500,
  textOf: (code) => (code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : code >= 0xa0 && code < 0x100 ? String.fromCharCode(code) : ''),
};
