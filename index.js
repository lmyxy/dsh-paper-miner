// paper-miner: token-frugal reading of PDF research papers.
//
// The Host does all the expensive work locally — PDF parsing, section
// segmentation, sentence indexing, gap mining — and hands the model a small,
// already-selected brief. A full paper normally costs 5–30k prompt tokens; the
// brief costs 1.5–2.5k and targeted drill-downs cost a few hundred each.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openPaper, resolveSection, sectionSummary } from './lib/paper.js';
import { buildBrief } from './lib/digest.js';
import { searchSentences } from './lib/search.js';
import { clip } from './lib/text.js';
import { listCache, purgeCache } from './lib/cache.js';

export const name = 'paper-miner';
export const inject = ['tools'];

const DEFAULT_CACHE = path.join(os.homedir(), '.dsh', 'paper-miner');
const SKILL_DIR = fileURLToPath(new URL('./skills/', import.meta.url));

/** Local stand-in for the framework helper: the registry takes plain definitions. */
const defineTool = (definition) => definition;

function resolved(config = {}) {
  const source = config ?? {};
  const cacheDir = typeof source.cacheDir === 'string' && source.cacheDir.trim() !== '' ? source.cacheDir : DEFAULT_CACHE;
  const raw = typeof source.maxPdfMiB === 'number' && source.maxPdfMiB > 0 ? source.maxPdfMiB : 128;
  return {
    cacheDir,
    briefTokens: typeof source.briefTokens === 'number' && source.briefTokens >= 400 ? source.briefTokens : 2200,
    maxBytes: raw * 1024 * 1024,
    pdftotextPath: typeof source.pdftotext === 'string' && source.pdftotext.trim() !== '' ? source.pdftotext.trim() : undefined,
  };
}

function expandPath(input, cwd) {
  let value = String(input).trim().replace(/^"(.*)"$/u, '$1');
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

async function load(args, config, exec) {
  const settings = resolved(config);
  const filePath = expandPath(args.path, cwdOf(exec));
  const paper = await openPaper({
    filePath,
    cacheDir: settings.cacheDir,
    maxBytes: settings.maxBytes,
    pdftotextPath: settings.pdftotextPath,
    refresh: args.refresh === true,
  });
  return { paper, filePath, settings };
}

const OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

function renderScan(paper, filePath) {
  const lines = [];
  lines.push(`FILE ${filePath}`);
  lines.push(`TITLE ${paper.title || '(not detected)'}`);
  lines.push(`STRUCTURE ${paper.pageCount} pages · ${paper.totalChars} chars · full text ≈${paper.estimatedTokens} tok · tables ${paper.tables} · figures ${paper.figures} · refs ≈${paper.referenceCount}`);
  lines.push(`CACHED ${paper.cacheHit ? 'yes (no re-parse)' : 'no (parsed now)'} · engine ${paper.engine}`);
  lines.push('SECTIONS id | role | name | chars | page');
  for (const section of sectionSummary(paper)) {
    lines.push(`  ${section.id} | ${section.role} | ${clip(section.name, 60)} | ${section.chars} | p${section.page}`);
  }
  lines.push('NEXT paper_brief for the budgeted digest (abstract, claims, evidence, limits, gap signals); paper_find to query sentences; paper_slice for one section.');
  return lines.join('\n');
}

export function apply(ctx, config) {
  const settings = resolved(config);

  ctx.tools.register(defineTool({
    name: 'paper_scan',
    description: 'Index a PDF paper locally and return a compact structural map: title, sections with ids and sizes, page/char counts, float and reference counts, and the cost of reading the full text. Parses once and caches, so later calls on the same file are nearly free. Start here when triaging whether a paper is worth reading.',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF file path, absolute or relative to the session working directory.' },
      refresh: { type: 'boolean', description: 'Re-parse the file even when a cached extraction exists.' },
    },
    output: OUT,
    async execute(args, exec) {
      const { paper, filePath } = await load(args, config, exec);
      return { text: renderScan(paper, filePath) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_brief',
    description: 'Return a token-budgeted digest of a PDF paper: abstract, claimed contributions, core mechanism, headline numbers, stated limits, author-stated future work, assumptions, table/figure captions, and heuristic signals about what the paper does not cover. This is the main reading call: it usually replaces reading the paper, and its own output states how many tokens it saved.',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF file path, absolute or relative to the session working directory.' },
      max_tokens: { type: 'number', description: 'Token budget for the digest. Defaults to the plugin config (2200). Lower it for triage; raise it to about 5000 for a deep read.' },
      refresh: { type: 'boolean', description: 'Re-parse the file even when a cached extraction exists.' },
    },
    output: OUT,
    async execute(args, exec) {
      const { paper, filePath } = await load(args, config, exec);
      const budget = typeof args.max_tokens === 'number' && args.max_tokens >= 400 ? args.max_tokens : settings.briefTokens;
      const brief = buildBrief(paper, { maxTokens: budget });
      const footer = `COST digest≈${brief.estimatedTokens} tok vs full text≈${paper.estimatedTokens} tok${brief.omitted.length > 0 ? ` · omitted for budget: ${brief.omitted.join(', ')}` : ''}\nFILE ${filePath}`;
      return { text: `${brief.text}\n\n${footer}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_find',
    description: 'Search a paper\'s sentences for a query and return the best-matching ones with their section and page. Use it to pin down a specific claim, metric, dataset or caveat without loading a whole section. Costs a few hundred tokens.',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF file path.' },
      query: { type: 'string', required: true, description: 'Words to look for, e.g. "latency overhead", "failure cases", "human evaluation".' },
      limit: { type: 'number', description: 'Number of sentences to return, 1–30. Defaults to 6.' },
      section: { type: 'string', description: 'Restrict to one section, by id (s4) or name fragment (e.g. "experiments").' },
      role: {
        type: 'string',
        enum: ['abstract', 'introduction', 'related_work', 'background', 'method', 'experiments', 'results', 'analysis', 'discussion', 'limitations', 'conclusion', 'other'],
        description: 'Restrict to sections with this research role.',
      },
      refresh: { type: 'boolean', description: 'Re-parse the file even when a cached extraction exists.' },
    },
    output: OUT,
    async execute(args, exec) {
      const { paper } = await load(args, config, exec);
      const result = searchSentences(paper.index, args.query, {
        limit: args.limit,
        section: args.section,
        role: args.role,
      });
      if (result.hits.length === 0) {
        return { text: `No sentence matched "${args.query}"${args.section === undefined ? '' : ` in section "${args.section}"`}. Try broader terms, or drop the section filter. Sections: ${sectionSummary(paper).map((section) => section.id).join(' ')}` };
      }
      const blocks = result.hits.map((hit, index) =>
        `${index + 1}. [${hit.section} p${hit.page}] ${hit.text}`,
      );
      const text = `QUERY "${args.query}" → ${result.hits.length} sentence(s)${args.section === undefined ? '' : ` in ${args.section}`}\n${blocks.join('\n')}`;
      return { text };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_slice',
    description: 'Return a bounded window of one section\'s text. Use it only when exact wording or numbers matter, because it costs far more tokens than paper_find. Start with the section id from paper_scan or paper_brief.',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF file path.' },
      section: { type: 'string', required: true, description: 'Section id (s4), exact name, name fragment, or role.' },
      start: { type: 'number', description: 'Character offset into the section. Defaults to 0.' },
      chars: { type: 'number', description: 'Maximum characters to return, 200–12000. Defaults to 3000.' },
      refresh: { type: 'boolean', description: 'Re-parse the file even when a cached extraction exists.' },
    },
    output: OUT,
    async execute(args, exec) {
      const { paper } = await load(args, config, exec);
      const section = resolveSection(paper, args.section);
      if (section === undefined) {
        return { text: `No section matched "${args.section}". Available: ${sectionSummary(paper).map((item) => `${item.id}=${item.name}`).join('; ')}` };
      }
      const size = Math.min(Math.max(typeof args.chars === 'number' ? args.chars : 3000, 200), 12000);
      const start = Math.min(Math.max(typeof args.start === 'number' ? args.start : 0, 0), Math.max(0, section.chars - 1));
      const window = section.text.slice(start, start + size);
      const end = start + window.length;
      const header = `SECTION ${section.id} "${section.name}" [${section.effectiveRole ?? section.role}] · ${section.chars} chars · showing ${start}–${end}${end < section.chars ? ' (more available: raise start)' : ' (end)'}`;
      return { text: `${header}\n\n${window}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'paper_cache',
    description: 'List or purge the local extraction cache. Use purge only when a paper file changed without a content change being detected, or when clearing disk.',
    parameters: {
      action: { type: 'string', enum: ['list', 'purge'], required: true, description: 'list shows cached papers; purge deletes one entry or all entries.' },
      key: { type: 'string', description: 'Cache key from paper_cache list. Omit to purge every entry.' },
    },
    output: OUT,
    async execute(args) {
      if (args.action === 'purge') {
        const removed = await purgeCache(settings.cacheDir, args.key);
        return { text: `Purged ${removed.length} cache entr${removed.length === 1 ? 'y' : 'ies'} from ${settings.cacheDir}.` };
      }
      const entries = await listCache(settings.cacheDir);
      if (entries.length === 0) return { text: `Cache is empty (${settings.cacheDir}).` };
      const lines = entries.map((entry) =>
        `${entry.key} · ${entry.title ?? '(untitled)'} · ${entry.pages ?? '?'}p · ${Math.round(entry.bytes / 1024)} KiB · ${entry.path ?? ''}`,
      );
      const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      return { text: `Cache ${settings.cacheDir} · ${entries.length} paper(s) · ${Math.round(total / 1024)} KiB\n${lines.join('\n')}` };
    },
  }));

  // The workflow skill is registered when the profile exposes the skill
  // registry; tools keep working when it does not.
  // The workflow skill is optional: it registers through a scoped context when
  // the profile provides a skill registry, and the tools work without it.
  const installSkill = (scope) => {
    registerSkill(scope).catch((error) => {
      ctx.logger?.warn?.(`paper-miner: skill registration skipped: ${String(error)}`);
    });
  };
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['skills'], installSkill);
    } catch (error) {
      ctx.logger?.warn?.(`paper-miner: skill injection unavailable: ${String(error)}`);
    }
  }
}

async function registerSkill(ctx) {
  const registry = ctx.skills;
  if (registry === undefined || typeof registry.register !== 'function') return;
  const raw = await readFile(path.join(SKILL_DIR, 'paper-mining', 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  const description = frontmatter === null
    ? 'Token-frugal workflow for reading PDF research papers and mining extension ideas.'
    : (/description:\s*(.+)/u.exec(frontmatter[1])?.[1] ?? 'Token-frugal workflow for reading PDF research papers.').trim();
  const content = (frontmatter === null ? raw : raw.slice(frontmatter[0].length)).trim();
  registry.register({ name: 'paper-mining', description, content });
}
