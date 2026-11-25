// Paper orchestration: file -> positioned lines -> sections -> index, with a
// content-addressed disk cache and an in-process layer above it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { extname } from 'node:path';
import { openPdf } from './pdf/read.js';
import { extractDocumentText } from './pdf/text.js';
import { segmentDocument } from './sections.js';
import { buildSentenceIndex } from './search.js';
import { estimateTokens } from './text.js';
import { readCache, sha256, writeCache } from './cache.js';

const memory = new Map();
const MEMORY_LIMIT = 12;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function remember(sha, paper) {
  if (memory.has(sha)) memory.delete(sha);
  memory.set(sha, paper);
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
}

/** Fallback extractor: one line per physical line, no positional detail. */
function extractWithPdfToText(filePath, binary) {
  const result = spawnSync(binary, ['-layout', '-enc', 'UTF-8', '-nopgbrk', filePath, '-'], {
    encoding: 'buffer',
    timeout: 60000,
    maxBuffer: 96 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined && result.status !== 0) return undefined;
  if (result.stdout === undefined || result.stdout.length === 0) return undefined;
  const text = Buffer.from(result.stdout).toString('utf8');
  const pageTexts = text.split('\f');
  const lines = [];
  pageTexts.forEach((pageText, pageIndex) => {
    const pageLines = pageText.split(/\r?\n/);
    let y = 800;
    for (const raw of pageLines) {
      const content = raw.replace(/\s+$/u, '');
      if (content.trim() !== '') {
        lines.push({ page: pageIndex + 1, y, x0: 0, x1: content.length * 5, size: 10, text: content });
      }
      y -= 12;
    }
  });
  return { lines, pages: pageTexts.length, engine: 'pdftotext' };
}

function countReferences(sections) {
  const references = sections.filter((section) => (section.effectiveRole ?? section.role) === 'references');
  if (references.length === 0) return 0;
  const text = references.map((section) => section.text).join('\n');
  const bracketed = new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map((match) => match[1]));
  if (bracketed.size > 3) return bracketed.size;
  const numbered = new Set([...text.matchAll(/^\s*(\d{1,3})\.\s/gm)].map((match) => match[1]));
  if (numbered.size > 3) return numbered.size;
  return references.reduce((sum, section) => sum + section.paragraphs.length, 0);
}

const CAPTION_LINE = /^(table|figure|fig\.|algorithm|listing)\s*([0-9]{1,3}[a-z]?|[IVXLC]{1,5})\s*[:.]\s/i;

/** Captions live on their own line far more reliably than at a paragraph start. */
function collectCaptions(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length < 12 || text.length > 400) continue;
    if (!CAPTION_LINE.test(text)) continue;
    const key = text.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 60) break;
  }
  return out;
}

function countFloats(captions) {
  const tables = new Set();
  const figures = new Set();
  for (const caption of captions) {
    const match = /^(table|figure|fig\.|algorithm|listing)\s*([0-9]{1,3}[a-z]?|[IVXLC]{1,5})/i.exec(caption);
    if (match === null) continue;
    const key = match[2].toUpperCase();
    if (match[1].toLowerCase() === 'table') tables.add(key);
    else figures.add(key);
  }
  return { tables: tables.size, figures: figures.size };
}

function assemble(record) {
  const lines = record.lines;
  const segmented = segmentDocument(lines);
  const sections = segmented.sections;
  const totalChars = lines.reduce((sum, line) => sum + line.text.length, 0);
  const captions = collectCaptions(lines);
  const { tables, figures } = countFloats(captions);
  const index = buildSentenceIndex(sections);
  return {
    sha: record.sha,
    sourcePath: record.sourcePath,
    engine: record.engine,
    pageCount: record.pageCount,
    title: segmented.title,
    base: segmented.base,
    sections,
    index,
    captions,
    totalChars,
    estimatedTokens: estimateTokens(sections.map((section) => section.text).join(' ')),
    tables,
    figures,
    referenceCount: countReferences(sections),
    createdAt: record.createdAt,
    cacheHit: record.cacheHit === true,
  };
}

/**
 * Open a PDF as a structured paper.
 * @param {object} options - { filePath, cacheDir, maxBytes, refresh, pdftotextPath }
 */
export async function openPaper(options) {
  const { filePath, cacheDir } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`PDF is ${Math.round(stat.size / 1048576)} MiB, above the ${Math.round(maxBytes / 1048576)} MiB limit`);
  const bytes = await fs.readFile(filePath);
  const sha = sha256(bytes);

  if (options.refresh !== true) {
    const cached = memory.get(sha);
    if (cached !== undefined) return { ...cached, cacheHit: true };
    const onDisk = await readCache(cacheDir, sha);
    if (onDisk !== undefined) {
      const paper = assemble({ ...onDisk, sha, sourcePath: filePath, cacheHit: true });
      remember(sha, paper);
      return paper;
    }
  }

  const extension = extname(filePath).toLowerCase();
  if (extension !== '' && extension !== '.pdf') {
    throw new Error(`unsupported file type "${extension}": pass a PDF`);
  }

  let lines;
  let pageCount;
  let engine = 'builtin';
  let extractionError;
  try {
    const doc = openPdf(bytes);
    const pages = extractDocumentText(doc);
    pageCount = pages.length;
    lines = pages.flatMap((page) => page.lines.map((line) => ({ ...line, page: page.index })));
    const chars = lines.reduce((sum, line) => sum + line.text.length, 0);
    if (chars < 400 || pages.length === 0) {
      const fallback = options.pdftotextPath === undefined ? undefined : extractWithPdfToText(filePath, options.pdftotextPath);
      if (fallback !== undefined) {
        lines = fallback.lines;
        pageCount = Math.max(pageCount, fallback.pages);
        engine = fallback.engine;
      }
    }
  } catch (error) {
    extractionError = error;
    const fallback = options.pdftotextPath === undefined ? undefined : extractWithPdfToText(filePath, options.pdftotextPath);
    if (fallback === undefined) {
      throw new Error(`PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    lines = fallback.lines;
    pageCount = fallback.pages;
    engine = fallback.engine;
  }
  void extractionError;

  const totalChars = lines.reduce((sum, line) => sum + line.text.length, 0);
  if (totalChars < 200) {
    throw new Error('no extractable text layer found: the PDF is likely a scanned image, which this tool does not OCR');
  }

  const record = {
    sha,
    sourcePath: filePath,
    engine,
    pageCount,
    lines,
    createdAt: Date.now(),
  };
  const paper = assemble({ ...record, cacheHit: false });
  try {
    await writeCache(cacheDir, sha, { ...record, title: paper.title, totalChars: paper.totalChars });
  } catch {
    // Caching is an optimisation; a read-only cache directory must not fail the call.
  }
  remember(sha, paper);
  return paper;
}

/** Resolve a section by id, exact name, role, or name substring. */
export function resolveSection(paper, selector) {
  const key = String(selector).trim().toLowerCase();
  const sections = paper.sections;
  return (
    sections.find((section) => section.id.toLowerCase() === key) ??
    sections.find((section) => section.name.toLowerCase() === key) ??
    sections.find((section) => (section.effectiveRole ?? section.role) === key) ??
    sections.find((section) => section.name.toLowerCase().startsWith(key)) ??
    sections.find((section) => section.name.toLowerCase().includes(key)) ??
    undefined
  );
}

export function sectionSummary(paper) {
  return paper.sections
    .filter((section) => section.role !== 'front')
    .map((section) => ({
      id: section.id,
      name: section.name,
      role: section.effectiveRole ?? section.role,
      level: section.level,
      page: section.page,
      chars: section.chars,
    }));
}
