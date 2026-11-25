// Text utilities: line joining, dehyphenation, sentence splitting, and a
// deliberately cheap token estimate for budgeting.

const ABBREVIATIONS = [
  'e.g', 'i.e', 'et al', 'vs', 'etc', 'cf', 'fig', 'figs', 'eq', 'eqs', 'sec', 'secs', 'tab',
  'no', 'nos', 'al', 'approx', 'resp', 'min', 'max', 'dr', 'prof', 'mr', 'ms', 'mrs', 'st', 'inc',
  'ltd', 'co', 'vol', 'vols', 'pp', 'p', 'ch', 'chap', 'ref', 'refs', 'thm', 'lem', 'def', 'prop',
  'cor', 'resp', 'viz', 'sc', 'ieee', 'acm', 'arxiv', 'neurips', 'icml', 'iclr', 'cvpr', 'acl',
  'emnlp', 'naacl', 'kdd', 'www', 'aaai', 'ijcai', 'uai', 'aistats', 'jmlr', 'pmlr', 'corr',
];

/** Rough token estimate: 1 token ≈ 3.8 characters of English prose. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

/** Collapse whitespace, repair common extraction artefacts, drop control bytes. */
export function normalizeText(text) {
  return text
    .replace(/\u00ad/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s*\u00a0\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

// Line-final hyphens are ambiguous: LaTeX hyphenation ("direc-tory") versus a
// real compound broken there ("per-token"). Compound-forming prefixes keep the
// hyphen; anything else is rejoined, which is the common case in dense prose.
const COMPOUND_PREFIXES = new Set([
  'self', 'per', 'non', 'pre', 'post', 'multi', 'cross', 'co', 'anti', 'semi', 'micro', 'macro',
  'sub', 'super', 'inter', 'intra', 'ultra', 'quasi', 'pseudo', 'token', 'zero', 'few', 'low', 'high',
  'long', 'short', 'end', 'mid', 'out', 'in', 'up', 'down', 'on', 'off', 'over', 'under', 'well',
  'ill', 'half', 'full', 'part', 'fine', 'graph', 'model', 'data', 'task', 'test', 'train', 'layer',
  'two', 'three', 'one', 'single', 'state', 'open', 'closed', 'real', 'non', 'all',
]);

/** Join a paragraph's physical lines, undoing end-of-line hyphenation. */
export function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (out === '') {
      out = line;
      continue;
    }
    const tail = out.slice(-2);
    const hyphenated = tail.endsWith('-') && !tail.endsWith('--') && /^[a-z]/.test(line);
    if (!hyphenated) {
      out = `${out} ${line}`;
      continue;
    }
    const fragment = (/([A-Za-z]+)-$/.exec(out)?.[1] ?? '').toLowerCase();
    out = fragment.length <= 3 || COMPOUND_PREFIXES.has(fragment) ? out + line : out.slice(0, -1) + line;
  }
  return out;
}

/** Group positioned lines into paragraphs using vertical gaps and size changes. */
export function linesToParagraphs(lines) {
  const paragraphs = [];
  let current = undefined;
  let prev = undefined;
  for (const line of lines) {
    const text = line.text.trim();
    if (text === '') continue;
    const gap = prev === undefined ? 0 : prev.y - line.y;
    const broken =
      prev === undefined ||
      gap < -2 ||
      gap > Math.max(prev.size, line.size) * 1.58 ||
      Math.abs(line.size - prev.size) > Math.max(1.2, prev.size * 0.14);
    if (broken) {
      if (current !== undefined) paragraphs.push(current);
      current = { lines: [text], size: line.size, y: line.y, page: line.page };
    } else {
      current.lines.push(text);
    }
    prev = line;
  }
  if (current !== undefined) paragraphs.push(current);
  return paragraphs
    .map((paragraph) => ({
      ...paragraph,
      text: normalizeText(joinLines(paragraph.lines)),
    }))
    .filter((paragraph) => paragraph.text.trim() !== '');
}

/** Split prose into sentences while keeping citations and abbreviations intact. */
export function splitSentences(text) {
  if (!text) return [];
  let guarded = text;
  const marks = [];
  for (const abbreviation of ABBREVIATIONS) {
    const re = new RegExp(`(\\b${abbreviation.replace(/\./g, '\\.')})\\.`, 'gi');
    guarded = guarded.replace(re, (_full, name) => {
      marks.push(name);
      return `${name}\u0001`;
    });
  }
  // Decimal numbers, section numbers, and initials keep their dots.
  guarded = guarded.replace(/(\d)\.(\d)/g, '$1\u0001$2');
  guarded = guarded.replace(/\b([A-Z])\.\s?(?=[A-Z]\.)/g, '$1\u0001 ');
  const parts = guarded.split(/(?<=[.!?])\s+(?=(?:["'(\[]?[A-Z0-9]))/u);
  let index = 0;
  const restored = parts.map((part) =>
    part.replace(/\u0001/g, () => {
      const value = '.';
      index += 1;
      return value;
    }),
  );
  return restored
    .map((sentence) => normalizeText(sentence).replace(/^[•·▪◦‣∙*]\s*/u, '').trim())
    .filter((sentence) => sentence.length > 1);
}

export function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z'-]*[a-z]|\d+(?:\.\d+)?/g) ?? []).filter((word) => word.length > 1);
}

/** Collapse near-duplicate sentences while preserving order. */
export function dedupeSentences(items, threshold = 0.82) {
  const kept = [];
  const signatures = [];
  for (const item of items) {
    const sig = new Set(words(item.text));
    let duplicate = false;
    for (const previous of signatures) {
      if (sig.size === 0 || previous.size === 0) continue;
      let shared = 0;
      for (const word of sig) if (previous.has(word)) shared += 1;
      const jaccard = shared / (sig.size + previous.size - shared);
      if (jaccard >= threshold) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      kept.push(item);
      signatures.push(sig);
    }
  }
  return kept;
}

/** Truncate to a character budget on a word boundary. */
export function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(0, maxChars));
  const space = cut.lastIndexOf(' ');
  if (space > maxChars * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()} […]`;
}
