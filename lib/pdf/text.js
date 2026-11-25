// Content-stream interpretation and layout: turns decoded page content into
// reading-ordered lines. Handles text matrices, TJ kerning gaps, Form XObjects
// and two-column gutters.
import { get, isArray, isDict, isName, isStream, num } from './read.js';
import { createFont, fallbackFont } from './font.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_FORM_DEPTH = 12;

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** Tokenize a content stream into operands and operators. */
function* contentTokens(src) {
  let i = 0;
  const n = src.length;
  const isWhite = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
  const isDelim = (c) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
  const isRegular = (c) => !isWhite(c) && !isDelim(c);
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isWhite(c)) {
      i += 1;
      continue;
    }
    if (c === 0x25) {
      while (i < n && src.charCodeAt(i) !== 0x0a && src.charCodeAt(i) !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x28) {
      const out = [];
      let depth = 1;
      i += 1;
      while (i < n) {
        const d = src.charCodeAt(i);
        if (d === 0x5c) {
          const e = src.charCodeAt(i + 1);
          i += 2;
          if (e === 0x6e) out.push(10);
          else if (e === 0x72) out.push(13);
          else if (e === 0x74) out.push(9);
          else if (e === 0x62) out.push(8);
          else if (e === 0x66) out.push(12);
          else if (e === 0x0d) { if (src.charCodeAt(i) === 0x0a) i += 1; }
          else if (e === 0x0a) { /* continuation */ }
          else if (e >= 0x30 && e <= 0x37) {
            let oct = e - 0x30;
            let extra = 1;
            while (extra < 3) {
              const f = src.charCodeAt(i);
              if (f >= 0x30 && f <= 0x37) { oct = oct * 8 + (f - 0x30); i += 1; extra += 1; } else break;
            }
            out.push(oct & 0xff);
          } else out.push(e & 0xff);
          continue;
        }
        if (d === 0x28) depth += 1;
        if (d === 0x29) {
          depth -= 1;
          i += 1;
          if (depth === 0) break;
          out.push(d & 0xff);
          continue;
        }
        out.push(d & 0xff);
        i += 1;
      }
      yield { kind: 'string', bytes: Uint8Array.from(out) };
      continue;
    }
    if (c === 0x3c && src.charCodeAt(i + 1) !== 0x3c) {
      const close = src.indexOf('>', i + 1);
      const end = close === -1 ? n : close;
      const body = src.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
      const bytes = new Uint8Array(Math.ceil(body.length / 2));
      const padded = body.length % 2 ? `${body}0` : body;
      for (let k = 0; k < bytes.length; k += 1) bytes[k] = parseInt(padded.slice(k * 2, k * 2 + 2), 16) || 0;
      i = end + 1;
      yield { kind: 'string', bytes };
      continue;
    }
    if (c === 0x3c && src.charCodeAt(i + 1) === 0x3c) {
      // Inline dictionary for a marked-content or image operator.
      let depth = 0;
      const start = i;
      while (i < n) {
        if (src.charCodeAt(i) === 0x3c && src.charCodeAt(i + 1) === 0x3c) { depth += 1; i += 2; continue; }
        if (src.charCodeAt(i) === 0x3e && src.charCodeAt(i + 1) === 0x3e) { depth -= 1; i += 2; if (depth === 0) break; continue; }
        i += 1;
      }
      yield { kind: 'op', value: '<dict>' };
      void start;
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      i += 1;
      yield { kind: c === 0x5b ? 'openArray' : 'closeArray' };
      continue;
    }
    if (c === 0x7b || c === 0x7d) {
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      const start = i + 1;
      i += 1;
      while (i < n && isRegular(src.charCodeAt(i))) i += 1;
      yield { kind: 'name', value: src.slice(start, i) };
      continue;
    }
    if (c === 0x27 || c === 0x22) {
      i += 1;
      yield { kind: 'op', value: String.fromCharCode(c) };
      continue;
    }
    const start = i;
    while (i < n && isRegular(src.charCodeAt(i))) i += 1;
    const word = src.slice(start, i);
    if (word === '') {
      i += 1;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      yield { kind: 'number', value: Number(word) };
      continue;
    }
    if (word === 'BI') {
      // Skip inline image data up to the closing EI operator.
      const id = src.indexOf('ID', i);
      if (id !== -1) {
        let p = id + 2;
        while (p < n) {
          if (src[p] === 'E' && src[p + 1] === 'I') {
            const prev = src.charCodeAt(p - 1);
            const after = src.charCodeAt(p + 2);
            if (isWhite(prev) && (Number.isNaN(after) || isWhite(after) || isDelim(after))) {
              p += 2;
              break;
            }
          }
          p += 1;
        }
        i = p;
      }
      continue;
    }
    yield { kind: 'op', value: word };
  }
}

class TextState {
  constructor() {
    this.font = fallbackFont;
    this.fontSize = 0;
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.scaleX = 1;
    this.leading = 0;
    this.rise = 0;
  }
}

function decodeCodes(font, bytes, twoByte) {
  const codes = [];
  if (twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
    if (bytes.length % 2 === 1) codes.push(bytes[bytes.length - 1]);
  } else {
    for (let i = 0; i < bytes.length; i += 1) codes.push(bytes[i]);
  }
  return codes;
}

/** Interpret one content stream, appending positioned runs. */
function runStream(ctx, src, resources, ctm, depth) {
  if (depth > MAX_FORM_DEPTH) return;
  const fontCache = ctx.fontCache;
  const fontFor = (name) => {
    const key = `${depth}:${name}`;
    if (fontCache.has(key)) return fontCache.get(key);
    const fonts = resources === undefined ? undefined : ctx.doc.resolve(get(resources, 'Font'));
    const ref = isDict(fonts) ? get(fonts, name) : undefined;
    const dict = ref === undefined ? undefined : ctx.doc.resolve(ref);
    const font = isDict(dict) ? createFont(ctx.doc, dict) : fallbackFont;
    fontCache.set(key, font);
    return font;
  };

  const state = new TextState();
  let tm = [...IDENTITY];
  let tlm = [...IDENTITY];
  let graphicsStack = [];
  let operands = [];
  let arrayDepth = 0;
  let array = [];
  let openRun = undefined;

  const flush = () => {
    if (openRun !== undefined && openRun.text !== '') ctx.runs.push(openRun);
    openRun = undefined;
  };

  const devicePoint = (x, y) => ({
    x: ctm[0] * x + ctm[2] * y + ctm[4],
    y: ctm[1] * x + ctm[3] * y + ctm[5],
  });

  const effectiveSize = () => Math.abs(state.fontSize) * Math.max(0.2, Math.abs(ctm[3] || 1));

  const showText = (bytes, extraWordGap) => {
    const codes = decodeCodes(state.font, bytes, state.font.twoByte);
    for (const code of codes) {
      const text = state.font.textOf(code);
      const width = state.font.widthOf(code) / 1000;
      const advance = (width * state.fontSize + state.charSpacing) * state.scaleX;
      const isSpace = text === ' ' || (text === '' && code === 32);
      if (text !== '' && !isSpace) {
        const p = devicePoint(tm[4] + tm[2] * state.rise, tm[5] + tm[3] * state.rise);
        if (openRun === undefined) {
          openRun = { x: p.x, y: p.y, size: effectiveSize(), text: '', endX: p.x };
        }
        openRun.text += text;
        openRun.endX = p.x + advance * (ctm[0] || 1);
      } else if (isSpace) {
        if (openRun !== undefined) openRun.text += ' ';
      } else {
        ctx.missed = (ctx.missed ?? 0) + 1;
      }
      tm[4] += advance + (isSpace ? state.wordSpacing : 0) + (extraWordGap ?? 0);
      extraWordGap = 0;
    }
  };

  for (const token of contentTokens(src)) {
    if (token.kind === 'openArray') {
      arrayDepth += 1;
      array = [];
      continue;
    }
    if (token.kind === 'closeArray') {
      arrayDepth -= 1;
      if (arrayDepth === 0) operands.push({ kind: 'array', items: array });
      array = [];
      continue;
    }
    if (arrayDepth > 0) {
      array.push(token);
      continue;
    }
    if (token.kind !== 'op') {
      operands.push(token);
      continue;
    }
    const op = token.value;
    switch (op) {
      case 'q':
        graphicsStack.push(ctm);
        ctm = [...ctm];
        break;
      case 'Q':
        if (graphicsStack.length > 0) ctm = graphicsStack.pop();
        break;
      case 'cm': {
        const m = operands.slice(-6).filter((item) => item.kind === 'number').map((item) => item.value);
        if (m.length === 6) ctm = multiply(m, ctm);
        break;
      }
      case 'BT':
        tm = [...IDENTITY];
        tlm = [...IDENTITY];
        break;
      case 'ET':
        flush();
        break;
      case 'Tf': {
        const name = operands.filter((item) => item.kind === 'name').pop();
        const size = operands.filter((item) => item.kind === 'number').pop();
        if (name !== undefined) state.font = fontFor(name.value);
        if (size !== undefined) state.fontSize = size.value;
        break;
      }
      case 'Tc': {
        const v = operands.filter((item) => item.kind === 'number').pop();
        if (v !== undefined) state.charSpacing = v.value;
        break;
      }
      case 'Tw': {
        const v = operands.filter((item) => item.kind === 'number').pop();
        if (v !== undefined) state.wordSpacing = v.value;
        break;
      }
      case 'Tz': {
        const v = operands.filter((item) => item.kind === 'number').pop();
        if (v !== undefined) state.scaleX = v.value / 100;
        break;
      }
      case 'TL': {
        const v = operands.filter((item) => item.kind === 'number').pop();
        if (v !== undefined) state.leading = v.value;
        break;
      }
      case 'Ts': {
        const v = operands.filter((item) => item.kind === 'number').pop();
        if (v !== undefined) state.rise = v.value;
        break;
      }
      case 'Td':
      case 'TD': {
        const nums = operands.filter((item) => item.kind === 'number').slice(-2);
        if (nums.length === 2) {
          if (op === 'TD') state.leading = -nums[1].value;
          tlm = multiply([1, 0, 0, 1, nums[0].value, nums[1].value], tlm);
          tm = [...tlm];
        }
        flush();
        break;
      }
      case 'Tm': {
        const nums = operands.filter((item) => item.kind === 'number').slice(-6).map((item) => item.value);
        if (nums.length === 6) {
          tlm = [...nums];
          tm = [...nums];
        }
        flush();
        break;
      }
      case 'T*': {
        tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        tm = [...tlm];
        flush();
        break;
      }
      case 'Tj': {
        const str = operands.filter((item) => item.kind === 'string').pop();
        if (str !== undefined) showText(str.bytes);
        break;
      }
      case "'": {
        tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        tm = [...tlm];
        flush();
        const str = operands.filter((item) => item.kind === 'string').pop();
        if (str !== undefined) showText(str.bytes);
        break;
      }
      case '"': {
        const nums = operands.filter((item) => item.kind === 'number');
        if (nums.length >= 2) {
          state.wordSpacing = nums[nums.length - 2].value;
          state.charSpacing = nums[nums.length - 1].value;
        }
        tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
        tm = [...tlm];
        flush();
        const str = operands.filter((item) => item.kind === 'string').pop();
        if (str !== undefined) showText(str.bytes);
        break;
      }
      case 'TJ': {
        const arr = operands.filter((item) => item.kind === 'array').pop();
        if (arr !== undefined) {
          for (const item of arr.items) {
            if (item.kind === 'string') {
              showText(item.bytes);
            } else if (item.kind === 'number') {
              const shift = (-item.value / 1000) * Math.abs(state.fontSize) * state.scaleX;
              // Word gaps in justified text are TJ displacements, not space glyphs.
              // Compare against the font's own space advance so tight kerning
              // (well under a space) never becomes a break.
              // Compare against the font's own space advance when available, but
              // cap it: fonts without /Widths report 0.5 em, which would hide
              // real word gaps.
              const spaceEm = Math.min(0.2, Math.max(0.12, (state.font.widthOf(32) / 1000) * 0.55));
              const spaceWidth = spaceEm * Math.abs(state.fontSize) * state.scaleX;
              if (shift >= spaceWidth && openRun !== undefined && !openRun.text.endsWith(' ')) openRun.text += ' ';
              tm[4] += shift;
            }
          }
        }
        break;
      }
      case 'Do': {
        const name = operands.filter((item) => item.kind === 'name').pop();
        if (name !== undefined) {
          const xobjects = resources === undefined ? undefined : ctx.doc.resolve(get(resources, 'XObject'));
          const ref = isDict(xobjects) ? get(xobjects, name.value) : undefined;
          const form = ctx.doc.resolve(ref);
          if (isStream(form) && isName(ctx.doc.resolve(get(form, 'Subtype'))) && ctx.doc.resolve(get(form, 'Subtype')).v === 'Form') {
            const entry = ctx.doc.findEntryOfValue(form);
            const data = entry === undefined ? undefined : ctx.doc.streamData(entry);
            if (data !== undefined) {
              flush();
              const matrix = ctx.doc.resolve(get(form, 'Matrix'));
              const m = isArray(matrix) && matrix.v.length === 6 ? matrix.v.map((item) => num(ctx.doc.resolve(item), 0)) : IDENTITY;
              const formResources = ctx.doc.resolve(get(form, 'Resources')) ?? resources;
              runStream(ctx, Buffer.from(data).toString('latin1'), formResources, multiply(m, ctm), depth + 1);
            }
          }
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  flush();
}

/**
 * Group runs into lines. A baseline is split only where the horizontal gap
 * straddles the column gutter, so justified full-width lines stay whole.
 */
function runsToLines(runs, gutterX) {
  const valid = runs.filter((run) => run.text.trim() !== '' || run.text === ' ');
  if (valid.length === 0) return [];
  valid.sort((a, b) => (Math.abs(a.y - b.y) > 0.8 ? b.y - a.y : a.x - b.x));
  const baselines = [];
  for (const run of valid) {
    const size = run.size || 10;
    const last = baselines[baselines.length - 1];
    if (last !== undefined && Math.abs(last.y - run.y) <= Math.max(1.6, size * 0.32)) {
      last.runs.push(run);
      last.y = (last.y * (last.runs.length - 1) + run.y) / last.runs.length;
      continue;
    }
    baselines.push({ y: run.y, runs: [run] });
  }

  const lines = [];
  for (const baseline of baselines) {
    baseline.runs.sort((a, b) => a.x - b.x);
    let group = [];
    let prevEnd;
    for (const run of baseline.runs) {
      const size = run.size || 10;
      const crossesGutter = gutterX !== undefined && prevEnd !== undefined && prevEnd <= gutterX - 1 && run.x >= gutterX + 1;
      if (group.length > 0 && crossesGutter) {
        lines.push(group);
        group = [];
      }
      group.push(run);
      prevEnd = Math.max(prevEnd ?? run.x, run.endX ?? run.x + run.text.length * size * 0.5);
      if (group.length === 1) prevEnd = run.endX ?? run.x + run.text.length * size * 0.5;
    }
    if (group.length > 0) lines.push(group);
  }

  const out = [];
  for (const group of lines) {
    let text = '';
    let prevEnd;
    let maxSize = 0;
    for (const run of group) {
      const size = run.size || 10;
      maxSize = Math.max(maxSize, size);
      if (prevEnd !== undefined) {
        const gap = run.x - prevEnd;
        if (gap > size * 0.18 && !text.endsWith(' ') && !run.text.startsWith(' ')) text += ' ';
        else if (gap > size * 1.1 && !text.endsWith(' ')) text += ' ';
      }
      text += run.text;
      prevEnd = Math.max(prevEnd ?? run.x, run.endX ?? run.x + run.text.length * size * 0.5);
    }
    const clean = text.replace(/[ \t]+/g, ' ').trimEnd();
    if (clean.trim() === '') continue;
    out.push({ y: group[0].y, x0: group[0].x, x1: prevEnd ?? group[0].x, size: maxSize, text: clean });
  }
  return out;
}

/** Split lines into columns using the widest empty vertical gutter. */
function orderColumns(lines, pageWidth) {
  if (lines.length < 8 || pageWidth <= 0) return lines;
  const spanning = (x) => lines.filter((line) => line.x0 < x - 2 && line.x1 > x + 2).length;
  let bestX = -1;
  let bestScore = -1;
  for (let frac = 0.34; frac <= 0.66; frac += 0.02) {
    const x = pageWidth * frac;
    const crossing = spanning(x);
    const left = lines.filter((line) => line.x1 <= x + 2).length;
    const right = lines.filter((line) => line.x0 >= x - 2).length;
    if (left < lines.length * 0.2 || right < lines.length * 0.2) continue;
    const score = crossing === 0 ? 1000 : 1 / crossing;
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
    }
  }
  if (bestX < 0) return lines;
  const crossingRatio = spanning(bestX) / lines.length;
  if (crossingRatio > 0.35) return lines;

  const bands = [];
  let band = [];
  for (const line of lines) {
    const isFullWidth = line.x0 < bestX - 2 && line.x1 > bestX + 2;
    if (isFullWidth) {
      if (band.length > 0) bands.push({ lines: band, full: false });
      band = [];
      bands.push({ lines: [line], full: true });
      continue;
    }
    band.push(line);
  }
  if (band.length > 0) bands.push({ lines: band, full: false });
  const out = [];
  for (const item of bands) {
    if (item.full) {
      out.push(item.lines[0]);
      continue;
    }
    const left = item.lines.filter((line) => line.x1 <= bestX + 2).sort((a, b) => b.y - a.y);
    const right = item.lines.filter((line) => line.x1 > bestX + 2).sort((a, b) => b.y - a.y);
    out.push(...left, ...right);
  }
  return out;
}

/** Find a vertical gutter that no run crosses, if the page has two columns. */
function detectGutter(runs, pageWidth) {
  if (runs.length < 30 || pageWidth <= 0) return undefined;
  const usable = runs.filter((run) => run.text.trim() !== '');
  const endOf = (run) => run.endX ?? run.x + run.text.length * run.size * 0.5;
  // Title, abstract and rules legitimately span both columns; they cannot veto
  // a gutter that the body text itself leaves empty.
  const narrow = usable.filter((run) => endOf(run) - run.x <= pageWidth * 0.5);
  if (narrow.length < 24) return undefined;
  let best;
  let bestCrossing = Infinity;
  const maxCrossing = Math.max(2, Math.floor(narrow.length * 0.1));
  for (let frac = 0.36; frac <= 0.64; frac += 0.02) {
    const x = pageWidth * frac;
    let left = 0;
    let right = 0;
    let crossing = 0;
    for (const run of narrow) {
      if (endOf(run) <= x + 2) left += 1;
      else if (run.x >= x - 2) right += 1;
      else crossing += 1;
    }
    // A few centered blocks (title, author line) may span the gutter; body text
    // on both sides of an empty band is what identifies two columns.
    if (left < narrow.length * 0.25 || right < narrow.length * 0.25) continue;
    if (crossing <= maxCrossing && crossing < bestCrossing) {
      bestCrossing = crossing;
      best = x;
    }
  }
  return best;
}

/**
 * Order two-column lines: a full-width line separates bands, and inside a band
 * the whole left column is read before the right one.
 */
function twoColumnOrder(leftLines, rightLines, spanLines) {
  const items = [
    ...leftLines.map((line) => ({ line, col: 0 })),
    ...rightLines.map((line) => ({ line, col: 1 })),
    ...spanLines.map((line) => ({ line, col: 2 })),
  ];
  items.sort((a, b) => (Math.abs(a.line.y - b.line.y) > 0.5
    ? b.line.y - a.line.y
    : (a.col - b.col) || (a.line.x0 - b.line.x0)));
  const out = [];
  let band = [];
  const flush = () => {
    if (band.length === 0) return;
    band.sort((a, b) => (Math.abs(a.line.y - b.line.y) > 0.5 ? b.line.y - a.line.y : a.line.x0 - b.line.x0));
    out.push(...band.filter((item) => item.col === 0).map((item) => item.line));
    out.push(...band.filter((item) => item.col === 1).map((item) => item.line));
    band = [];
  };
  for (const item of items) {
    if (item.col === 2) {
      flush();
      out.push(item.line);
      continue;
    }
    band.push(item);
  }
  flush();
  return out;
}

/** Dev aid: positioned runs of one page, before line assembly. */
export function debugRuns(doc, pageIndex) {
  const page = doc.pages()[pageIndex];
  const ctx = { doc, runs: [], fontCache: new Map(), missed: 0 };
  runStream(ctx, doc.pageContent(page), page.resources, IDENTITY, 0);
  return { runs: ctx.runs, missed: ctx.missed ?? 0 };
}

/** Full document text as pages of ordered lines. */
export function extractDocumentText(doc) {
  const pages = [];
  for (const page of doc.pages()) {
    const ctx = { doc, runs: [], fontCache: new Map() };
    let content = '';
    try {
      content = doc.pageContent(page);
    } catch {
      content = '';
    }
    const box = isArray(page.mediaBox) ? page.mediaBox.v.map((item) => num(doc.resolve(item), 0)) : [0, 0, 612, 792];
    const width = Math.abs((box[2] ?? 612) - (box[0] ?? 0)) || 612;
    const height = Math.abs((box[3] ?? 792) - (box[1] ?? 0)) || 792;
    if (content !== '') runStream(ctx, content, page.resources, IDENTITY, 0);

    const gutter = detectGutter(ctx.runs, width);
    const allLines = runsToLines(ctx.runs, gutter);
    let lines;
    if (gutter === undefined) {
      lines = allLines;
    } else {
      const crosses = (line) => line.x0 < gutter - 2 && (line.x1 ?? line.x0) > gutter + 2;
      const left = allLines.filter((line) => !crosses(line) && (line.x1 ?? line.x0) <= gutter + 2);
      const right = allLines.filter((line) => !crosses(line) && line.x0 >= gutter - 2);
      const span = allLines.filter(crosses);
      lines = twoColumnOrder(left, right, span);
    }
    pages.push({
      index: pages.length + 1,
      width,
      height,
      lines: lines.map((line) => ({ ...line, text: line.text.replace(/\u0000/g, '') })),
    });
  }
  return pages;
}
