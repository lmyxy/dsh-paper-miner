// Structural segmentation: title, abstract, numbered/unnumbered headings,
// references and appendix, each carrying a coarse research role.
import { linesToParagraphs, normalizeText } from './text.js';

const KNOWN_HEADINGS = [
  ['abstract', 'abstract'],
  ['introduction', 'introduction'],
  ['related work', 'related_work'],
  ['related works', 'related_work'],
  ['background', 'background'],
  ['preliminaries', 'background'],
  ['problem formulation', 'background'],
  ['problem statement', 'background'],
  ['method', 'method'],
  ['methods', 'method'],
  ['methodology', 'method'],
  ['approach', 'method'],
  ['our approach', 'method'],
  ['proposed method', 'method'],
  ['proposed approach', 'method'],
  ['model', 'method'],
  ['architecture', 'method'],
  ['experiments', 'experiments'],
  ['experimental setup', 'experiments'],
  ['experiment', 'experiments'],
  ['evaluation', 'experiments'],
  ['empirical evaluation', 'experiments'],
  ['empirical results', 'experiments'],
  ['numerical experiments', 'experiments'],
  ['numerical illustration', 'experiments'],
  ['numerical results', 'experiments'],
  ['case study', 'experiments'],
  ['simulations', 'experiments'],
  ['results', 'results'],
  ['results and discussion', 'results'],
  ['analysis', 'analysis'],
  ['ablation study', 'analysis'],
  ['ablation', 'analysis'],
  ['discussion', 'discussion'],
  ['limitations', 'limitations'],
  ['limitation', 'limitations'],
  ['threats to validity', 'limitations'],
  ['conclusion', 'conclusion'],
  ['conclusions', 'conclusion'],
  ['conclusion and future work', 'conclusion'],
  ['future work', 'conclusion'],
  ['references', 'references'],
  ['bibliography', 'references'],
  ['acknowledgments', 'acknowledgments'],
  ['acknowledgements', 'acknowledgments'],
  ['appendix', 'appendix'],
  ['appendices', 'appendix'],
  ['supplementary material', 'appendix'],
  ['supplementary', 'appendix'],
];

const EXCLUDED_STARTS = /^(figure|fig\.|table|algorithm|listing|proof|theorem|lemma|corollary|definition|example|remark|assumption|equation|step|item|observation|claim|proposition)\b/i;
const SENTENCE_LIKE = /[a-z]\s[a-z]/;

function classify(name) {
  const lower = name.toLowerCase().replace(/^[0-9.\s]+/, '').trim();
  for (const [key, role] of KNOWN_HEADINGS) {
    if (lower === key || lower.startsWith(`${key} `) || lower.startsWith(`${key}:`)) return role;
  }
  if (/^(references|bibliography)\b/.test(lower)) return 'references';
  // A section named after its subject still says what it is about; these words
  // are specific enough not to fire on unrelated headings.
  if (/\b(kernel|kernels|architecture|implementation|algorithm|formulation|training procedure|scoring function|design)\b/.test(lower)) return 'method';
  if (/\b(benchmark|benchmarks|evaluation|experiments?|measurements?)\b/.test(lower)) return 'experiments';
  return 'other';
}

function headingText(line) {
  const text = line.text.trim();
  if (text.length === 0 || text.length > 96) return undefined;
  if (EXCLUDED_STARTS.test(text)) return undefined;
  if (/\.{3,}/.test(text)) return undefined;
  if (/\d{3,}/.test(text)) return undefined;
  if (!/[A-Za-z]/.test(text)) return undefined;

  const numbered = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(\S.*)$/.exec(text);
  if (numbered !== undefined && numbered !== null) {
    const rest = numbered[2].trim();
    if (rest.length === 0 || rest.length > 80) return undefined;
    if (rest.replace(/[^A-Za-z]/g, '').length < 3) return undefined;
    if (/[.;:,]$/.test(rest)) return undefined;
    const wordCount = rest.split(/\s+/).length;
    if (wordCount > 14) return undefined;
    if (!/^[A-Z(]/.test(rest)) return undefined;
    if (SENTENCE_LIKE.test(rest) && wordCount > 8) return undefined;
    return rest;
  }

  const letters = text.replace(/[^A-Za-z]/g, '');
  const isUpper = letters.length > 3 && text === text.toUpperCase() && !/\d/.test(text);
  const isKnown = KNOWN_HEADINGS.some(([key]) => lower(text) === key || lower(text) === `${key}s`);
  if (!isUpper && !isKnown) return undefined;
  if (!isKnown && (/\d/.test(text) || /[.;:,]$/.test(text))) return undefined;
  if (text.split(/\s+/).length > 10) return undefined;
  return text;
}

function lower(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function bodySize(lines) {
  const weights = new Map();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + line.text.length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best;
}

/** Largest-font line cluster near the top of page 1 becomes the title. */
function detectTitle(lines, base) {
  const firstPage = lines.filter((line) => line.page === 1);
  if (firstPage.length === 0) return { title: '', titleLines: [] };
  const isHeader = (line) => /^(draft version|preprint|arxiv:|version of|submitted to|to appear|accepted for|preprint typeset|journal of|typeset using)\b/i.test(line.text.trim());
  const pool = firstPage.slice(0, 30).filter((line) => line.text.trim() !== '' && !isHeader(line));
  if (pool.length === 0) return { title: '', titleLines: [] };
  const maxSize = Math.max(...pool.map((line) => line.size));
  if (maxSize < base * 1.18) {
    const first = pool[0];
    return { title: normalizeText(first.text), titleLines: [first] };
  }
  const candidates = pool.filter((line) => line.size >= maxSize * 0.92).slice(0, 3);
  const titleLines = candidates.sort((a, b) => b.y - a.y);
  return { title: normalizeText(titleLines.map((line) => line.text.trim()).join(' ')), titleLines };
}

/**
 * Segment a document into titled sections.
 * Returns { title, base, sections: [{id, name, role, level, page, paragraphs, text, chars}] }.
 */
export function segmentDocument(lines) {
  const base = bodySize(lines);
  const { title, titleLines } = detectTitle(lines, base);
  const titleSet = new Set(titleLines.map((line) => line));
  const inTitle = (line) => titleSet.has(line);

  // Locate the table of contents so its entries cannot masquerade as headings.
  const tocStart = lines.findIndex((line) => /^(contents|table of contents)$/i.test(line.text.trim()));
  let tocEnd = -1;
  if (tocStart !== -1) {
    for (let i = tocStart + 1; i < lines.length; i += 1) {
      const text = lines[i].text.trim();
      if (text === '') continue;
      if (!/\.{3,}/.test(text) && !/[.\s]\d{1,3}$/.test(text)) {
        tocEnd = i;
        break;
      }
    }
  }

  const sections = [];
  let current = { name: 'Front matter', role: 'front', level: 0, page: 1, lines: [] };
  sections.push(current);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inTitle(line)) continue;
    if (tocStart !== -1 && i >= tocStart && (tocEnd === -1 || i < tocEnd)) continue;
    const text = line.text.trim();
    if (text === '') continue;
    const name = headingText(line);
    const sizeOk = line.size >= base * 1.02;
    const known = name !== undefined && KNOWN_HEADINGS.some(([key]) => lower(name) === key);
    const isHeading = name !== undefined && (sizeOk || known || /^\d+(\.\d+)*\.?\s/.test(text));
    if (isHeading) {
      const numbered = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s/.exec(text);
      const level = numbered === null ? 1 : numbered[1].split('.').length;
      current = {
        name: normalizeText(name).replace(/\s+/g, ' ').trim(),
        role: classify(name),
        level,
        page: line.page,
        lines: [],
      };
      sections.push(current);
      continue;
    }
    current.lines.push(line);
  }

  const output = [];
  let bodyIndex = 0;
  for (const section of sections) {
    const paragraphs = linesToParagraphs(section.lines);
    const text = paragraphs.map((paragraph) => paragraph.text).join('\n\n');
    if (section.name === 'Front matter' && text.trim() === '' && paragraphs.length === 0) continue;
    const id = section.role === 'front' ? 's0' : `s${bodyIndex + 1}`;
    if (section.role !== 'front') bodyIndex += 1;
    output.push({
      id,
      name: section.name,
      role: section.role,
      level: section.level,
      page: section.page,
      paragraphs,
      text,
      chars: text.length,
    });
  }

  // Many two-column formats inline the abstract as "Abstract. ..." with no
  // heading of its own; lift it out of the front matter when that happens.
  if (!output.some((section) => section.role === 'abstract')) {
    const front = output.find((section) => section.role === 'front');
    const index = front === undefined ? -1 : front.paragraphs.findIndex((paragraph) => /^abstract\b[.:]?\s+/i.test(paragraph.text));
    if (front !== undefined && index >= 0) {
      const abstractParagraphs = front.paragraphs.slice(index);
      abstractParagraphs[0] = {
        ...abstractParagraphs[0],
        text: abstractParagraphs[0].text.replace(/^abstract\b[.:]?\s+/i, ''),
      };
      front.paragraphs = front.paragraphs.slice(0, index);
      front.text = front.paragraphs.map((paragraph) => paragraph.text).join('\n\n');
      front.chars = front.text.length;
      const abstractText = abstractParagraphs.map((paragraph) => paragraph.text).join('\n\n');
      output.splice(output.indexOf(front) + 1, 0, {
        id: 's-abs',
        name: 'Abstract',
        role: 'abstract',
        level: 1,
        page: front.page,
        paragraphs: abstractParagraphs,
        text: abstractText,
        chars: abstractText.length,
      });
    }
  }

  // A subsection without a recognizable name inherits the enclosing role, so
  // "Clustered routing" under Method still counts as method text.
  for (let index = 0; index < output.length; index += 1) {
    const section = output[index];
    let parent;
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = output[back];
      if (candidate.level < section.level && candidate.role !== 'front') {
        parent = candidate;
        break;
      }
    }
    if (parent === undefined && section.level > 1) {
      // Only a nested heading may borrow a role from the section before it.
      for (let back = index - 1; back >= 0; back -= 1) {
        if (output[back].role !== 'front') {
          parent = output[back];
          break;
        }
      }
    }
    section.parentId = parent === undefined ? undefined : parent.id;
    section.effectiveRole = section.role !== 'other' && section.role !== 'front'
      ? section.role
      : parent === undefined ? section.role : (parent.effectiveRole ?? parent.role);
  }
  return { title, base, sections: output };
}

/** Sentences with section attribution, used by search and the digest. */
export function sectionSentences(section, splitSentences) {
  const out = [];
  for (const paragraph of section.paragraphs) {
    for (const sentence of splitSentences(paragraph.text)) {
      out.push({ text: sentence, sectionId: section.id, sectionName: section.name, role: section.role, page: paragraph.page });
    }
  }
  return out;
}
