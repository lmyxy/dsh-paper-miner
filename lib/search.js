// Sentence-level retrieval. The index is built once per paper and kept in the
// in-process cache, so a follow-up question costs no re-extraction.
import { splitSentences } from './text.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'and', 'or', 'for', 'on', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'by', 'as', 'at', 'that', 'this', 'these', 'those', 'it', 'its', 'from', 'we', 'our',
  'how', 'what', 'which', 'when', 'where', 'why', 'does', 'do', 'did', 'can', 'could', 'would',
  'should', 'into', 'than', 'then', 'there', 'their', 'they', 'them', 'not', 'no', 'but', 'if',
  'about', 'any', 'all', 'also', 'such', 'so', 'up', 'out', 'has', 'have', 'had', 'will', 'may',
]);

export function tokenizeQuery(query) {
  const terms = (query.toLowerCase().match(/[a-z][a-z'-]*[a-z]|\d+(?:\.\d+)?/g) ?? []);
  return [...new Set(terms.filter((term) => term.length > 1 && !STOPWORDS.has(term)))];
}

export function buildSentenceIndex(sections) {
  const sentences = [];
  for (const section of sections) {
    if (section.chars === 0) continue;
    const role = section.effectiveRole ?? section.role;
    if (role === 'references' || role === 'appendix') continue;
    for (const paragraph of section.paragraphs) {
      for (const text of splitSentences(paragraph.text)) {
        if (text.length < 20) continue;
        sentences.push({
          text,
          sectionId: section.id,
          sectionName: section.name,
          role,
          page: paragraph.page,
          lower: text.toLowerCase(),
        });
      }
    }
  }
  const df = new Map();
  for (const sentence of sentences) {
    const seen = new Set();
    for (const term of (sentence.lower.match(/[a-z][a-z'-]*[a-z]|\d+(?:\.\d+)?/g) ?? [])) {
      if (seen.has(term)) continue;
      seen.add(term);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return { sentences, df, total: sentences.length };
}

/**
 * Rank sentences against a query.
 * @param {object} index - from buildSentenceIndex
 * @param {string} query
 * @param {object} options - { limit, section, role, minScore }
 */
export function searchSentences(index, query, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 6, 1), 30);
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return { hits: [], terms: [] };
  const corpus = index.total || 1;
  const queryLower = query.toLowerCase().trim();
  const scored = [];
  for (const sentence of index.sentences) {
    if (options.section !== undefined) {
      const needle = options.section.toLowerCase();
      if (!sentence.sectionName.toLowerCase().includes(needle) && sentence.sectionId !== options.section) continue;
    }
    if (options.role !== undefined && sentence.role !== options.role) continue;
    let score = 0;
    for (const term of terms) {
      const occurrences = sentence.lower.split(term).length - 1;
      if (occurrences === 0) continue;
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (corpus - df + 0.5) / (df + 0.5));
      score += idf * (occurrences / (occurrences + 1.1));
    }
    if (score === 0) continue;
    if (terms.length > 1 && sentence.lower.includes(queryLower)) score += 2.2;
    const coverage = terms.filter((term) => sentence.lower.includes(term)).length / terms.length;
    if (coverage < 0.34) continue;
    score *= 0.7 + 0.3 * coverage;
    if (score < (options.minScore ?? 0.6)) continue;
    scored.push({ ...sentence, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    terms,
    hits: scored.slice(0, limit).map((hit) => ({
      text: hit.text,
      section: hit.sectionName,
      sectionId: hit.sectionId,
      role: hit.role,
      page: hit.page,
      score: Math.round(hit.score * 100) / 100,
    })),
  };
}
