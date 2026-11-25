// Budgeted digest construction and heuristic gap mining. Everything here is
// deterministic: it selects and orders existing sentences, never paraphrases,
// so the model spends tokens on reasoning rather than re-reading.
import { clip, dedupeSentences, estimateTokens, splitSentences } from './text.js';

const CLAIM_CUES = /^(we|our|this paper|this work|in this paper|in this work)\b/i;
const CLAIM_VERBS = /\b(propose|present|introduce|develop|design|describe|show|demonstrate|find|observe|establish|provide|release|contribute|study|explore|derive|formulate|prove)\b/i;
const MECHANISM_CUES = /\b(we (propose|introduce|present|develop|design|formulate|derive)|our (approach|method|model|framework|algorithm|router|layer)|the key (idea|insight|observation)|central to|consists of)\b/i;
const EVIDENCE_CUES = /\b(outperform|improve|improv|reduc|lower|higher|increase|decreas|achiev|reach|yield|gain|surpass|better than|compared (to|with)|relative to)\b/i;
const RESULT_VERB = /\b(outperform|improve|improv|reduc|lower|higher|achiev|reach|gain|surpass|better|worse|degrades?|drops?|cuts?)\b/i;
const SETUP_CUE = /\b(we (train|use|set|optimi[sz]e|adopt|initiali[sz]e|run)|are trained on|is trained on|learning rate|batch size|warm-?up steps|hyperparameter|we select|we choose|the dataset consists|hidden width|sequence length|parameter count is|corpus drawn)\b/i;
const LIMIT_CUES = /\b(limitation|limited|limiting|drawback|weakness|shortcoming|restricted|only works|only applies|does not (generalize|scale|apply|support|handle)|fails? to|cannot|can not|struggles?|degrades?|bottleneck|unsuitable|impractical|prohibitive)\b/i;
const FUTURE_CUES = /\b(future work|future research|we leave|left (open|for future)|remains? open|open (question|problem|challenge)|promising (direction|avenue)|beyond the scope|we do not (address|explore|consider)|not (yet )?explored|would be interesting|deserves? further|warrants? further)\b/i;
const ASSUMPTION_CUES = /\b(we assume|assumes? that|under the assumption|assuming (that|a)|holds? only (when|if)|requires? (that|the)|given a|provided that)\b/i;
const THREAT_CUES = /\b(threats? to validity|confound|selection bias|small sample|single (dataset|domain|task|model)|anecdotal)\b/i;
const KEYWORDS_RE = /\b(keywords?|index terms|acm reference format|ccs concepts)\s*[:：]/i;

const CAPTION_RE = /^(figure|fig\.|table|algorithm|listing)\s*([0-9]{1,3}[a-z]?|[IVXLC]{1,5})\s*[:.]\s+/i;

const DATASET_LEXICON = [
  'imagenet', 'cifar-10', 'cifar-100', 'mnist', 'celeba', 'coco', 'ade20k', 'kitti', 'cityscapes',
  'glue', 'superglue', 'sst-2', 'sst2', 'mnli', 'qqp', 'qnli', 'rte', 'cola', 'wnli', 'mrpc',
  'squad', 'squad2', 'natural questions', 'triviaqa', 'hotpotqa', 'ms marco', 'beir', 'scifact',
  'wmt', 'iwslt', 'cnn/dailymail', 'xsum', 'gigaword', 'wikitext', 'the pile', 'c4', 'openwebtext',
  'humaneval', 'mbpp', 'gsm8k', 'math', 'mmlu', 'hellaswag', 'arc', 'winogrande', 'bbh', 'ifeval',
  'librispeech', 'audioset', 'vqa', 'visual genome', 'nocaps', 'atari', 'd4rl', 'mujoco',
];

/** Whole-word patterns, so "arc" does not match "architecture". */
const DATASET_PATTERNS = new Map(
  DATASET_LEXICON.map((name) => {
    const body = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]');
    return [name, new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, 'i')];
  }),
);

const SECTION_LABEL = {
  abstract: 'Abstract', introduction: 'Intro', related_work: 'Related', background: 'Background',
  method: 'Method', experiments: 'Experiments', results: 'Results', analysis: 'Analysis',
  discussion: 'Discussion', limitations: 'Limits', conclusion: 'Conclusion',
  references: 'Refs', appendix: 'Appendix', acknowledgments: 'Acks', front: 'Front', other: 'Other',
};

/** Sentences of one section, numbered in document order across the whole call. */
function sentencesOf(section, counter) {
  return section.paragraphs.flatMap((paragraph) =>
    splitSentences(paragraph.text).map((text) => {
      counter[0] += 1;
      return { text, section, order: counter[0] };
    }),
  );
}

function collect(sections, counter) {
  return sections.flatMap((section) => sentencesOf(section, counter));
}

/** Keep document order after a relevance-based selection. */
function pick(scored, limit) {
  return scored
    .slice(0, limit)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.text);
}

function scoreSentence(text, cues, weight = 1) {
  let score = cues.test(text) ? weight : 0;
  if (/\d/.test(text)) score += 0.35;
  if (/%|×|x faster|speedup|points?/i.test(text)) score += 0.3;
  if (text.length > 60 && text.length < 400) score += 0.2;
  if (text.length > 500) score -= 0.5;
  return score;
}

function byRole(sections, ...roles) {
  return sections.filter((section) => roles.includes(section.effectiveRole ?? section.role) && section.chars > 0);
}

function bodySections(sections) {
  return sections.filter((section) => {
    const role = section.effectiveRole ?? section.role;
    return role !== 'references' && role !== 'appendix' && role !== 'front' && section.chars > 0;
  });
}

/** Deterministic structural observations that suggest extension work. */
export function detectSignals(sections, title) {
  const signals = [];
  const counter = [0];
  const body = bodySections(sections);
  const allText = body.map((section) => section.text).join(' ');
  const lower = allText.toLowerCase();

  const experimentSections = byRole(sections, 'experiments', 'results', 'analysis');
  const experimentText = experimentSections.map((section) => section.text).join(' ');
  const experimentLower = experimentText.toLowerCase();

  const datasets = [...new Set(DATASET_LEXICON.filter((name) => DATASET_PATTERNS.get(name).test(experimentLower)))];
  if (datasets.length === 1) {
    signals.push(`evaluation breadth: only one benchmark detected in the experiments (${datasets[0]}); transfer to other tasks is untested`);
  } else if (datasets.length === 0 && experimentSections.length > 0) {
    signals.push('evaluation breadth: no standard benchmark name detected in the experiments; check whether the evaluation is in-house or renamed');
  } else if (datasets.length >= 2) {
    signals.push(`evaluation breadth: ${datasets.length} benchmarks detected (${datasets.slice(0, 4).join(', ')})`);
  }

  const efficiencyClaim = /\b(efficien|faster|cheaper|scalab|lightweight|low[- ]cost|overhead)\b/i.test(allText.slice(0, 4000));
  const efficiencyEvidence = /\b(latency|throughput|tokens?\/s|flops|wall[- ]clock|gpu[- ]hours?|memory (footprint|usage)|speed-?up|×)\b/i.test(experimentText);
  if (efficiencyClaim && !efficiencyEvidence) {
    signals.push('efficiency claim without system evidence: the paper argues about cost, but the experiments report no latency, throughput, FLOPs or memory measurement');
  }

  const variance = /\b(std\.?|standard deviation|variance|error bars?|confidence interval|seed(s)?|±)\b/i.test(experimentText);
  if (experimentSections.length > 0 && !variance) {
    signals.push('no dispersion reported: experiments mention no variance, seeds or error bars, so small differences are not established');
  }

  const ablation = /\b(ablation|ablat)\b/i.test(lower);
  if (experimentSections.length > 0 && !ablation) {
    signals.push('no ablation study detected: the contribution of each component is not isolated');
  }

  const assumptions = collect(body, counter).filter((item) => ASSUMPTION_CUES.test(item.text));
  if (assumptions.length > 0) {
    signals.push(`explicit assumptions (${assumptions.length}) constrain where the results transfer; see ASSUMPTIONS`);
  }

  const limitations = byRole(sections, 'limitations');
  if (limitations.length === 0 && !FUTURE_CUES.test(allText)) {
    signals.push('no limitations or future-work statement found: the boundary of validity has to be inferred from the method alone');
  }

  const released = /\b(we (release|open[- ]source|make .{0,20}available)|available at|github\.com|code is (publicly )?available|our code)\b/i.test(allText);
  if (!released) {
    signals.push('no artifact release detected: reproduction requires reimplementation from the paper text');
  }

  const theory = /\b(theorem|lemma|proof|bound|convergence|regret)\b/i.test(allText);
  const empirical = experimentSections.length > 0;
  if (theory && !empirical) signals.push('theory-only paper: no empirical validation of the stated bound is reported');
  if (!theory && empirical) signals.push('empirical-only paper: no formal analysis of why the mechanism works is provided');

  void title;
  return signals;
}

/** Captions are cheap, high-signal evidence about what was actually measured. */
function collectCaptions(sections, limit) {
  const captions = [];
  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      const text = paragraph.text.trim();
      if (!CAPTION_RE.test(text)) continue;
      if (text.length < 12 || text.length > 320) continue;
      captions.push(text.replace(/\s+/g, ' '));
    }
  }
  return [...new Set(captions)].slice(0, limit);
}

function stripKeywords(text) {
  const match = KEYWORDS_RE.exec(text);
  return match === null ? text : text.slice(0, match.index).trimEnd();
}

/**
 * Build the token-budgeted brief.
 * @param {object} paper - { title, sections, pageCount, totalChars, estimatedTokens }
 * @param {object} options - { maxTokens }
 */
export function buildBrief(paper, options = {}) {
  const maxTokens = options.maxTokens ?? 2200;
  const budgetChars = Math.max(1200, Math.round(maxTokens * 3.8));
  const counter = [0];
  const sections = paper.sections;
  const body = bodySections(sections);
  const abstract = byRole(sections, 'abstract')[0];
  const intro = byRole(sections, 'introduction')[0];
  const method = byRole(sections, 'method');
  const experiment = byRole(sections, 'experiments', 'results', 'analysis');
  const closing = byRole(sections, 'limitations', 'discussion', 'conclusion');

  const abstractRaw = abstract === undefined ? '' : stripKeywords(abstract.text.replace(/\s+/g, ' '));
  const abstractText = abstractRaw === '' ? '' : clip(abstractRaw, Math.min(1900, Math.round(budgetChars * 0.32)));

  const contributions = pick(
    (intro === undefined ? [] : sentencesOf(intro, counter))
      .map((item) => ({ ...item, score: scoreSentence(item.text, CLAIM_CUES) + (CLAIM_VERBS.test(item.text) ? 1 : 0) }))
      .filter((item) => item.score >= 1.2)
      .sort((a, b) => b.score - a.score),
    5,
  );

  const mechanism = pick(
    collect(method, counter)
      .map((item) => ({ ...item, score: scoreSentence(item.text, MECHANISM_CUES, 1.2) }))
      .filter((item) => item.score >= 1.2)
      .sort((a, b) => b.score - a.score),
    3,
  );

  const evidenceList = pick(
    collect(experiment, counter)
      .filter((item) => /\d/.test(item.text) && item.text.length >= 60 && item.text.length < 400)
      .map((item) => ({
        ...item,
        score: (EVIDENCE_CUES.test(item.text) ? 1 : 0)
          + (RESULT_VERB.test(item.text) ? 0.6 : 0)
          - (SETUP_CUE.test(item.text) ? 0.9 : 0)
          + (item.text.length < 300 ? 0.2 : 0),
      }))
      .filter((item) => item.score >= 0.9)
      .sort((a, b) => b.score - a.score),
    4,
  );

  const limitsSource = dedupeSentences(collect(closing, counter).filter((item) => LIMIT_CUES.test(item.text)), 0.75)
    .map((item) => item.text);
  const futureSource = dedupeSentences(collect(body, counter).filter((item) => FUTURE_CUES.test(item.text)), 0.75)
    .map((item) => item.text);
  const assumptionSource = dedupeSentences(collect(body, counter).filter((item) => ASSUMPTION_CUES.test(item.text)), 0.8)
    .map((item) => item.text);
  const threatSource = dedupeSentences(collect(body, counter).filter((item) => THREAT_CUES.test(item.text)), 0.8)
    .map((item) => item.text);

  const signals = detectSignals(sections, paper.title);
  const captionSource = paper.captions ?? collectCaptions(sections, 40);
  const captions = captionSource.filter((text) => text.length <= 320).slice(0, 6);

  const map = sections
    .filter((section) => section.role !== 'front')
    .map((section) => `${section.id}:${SECTION_LABEL[section.effectiveRole ?? section.role] ?? 'Other'}${section.chars > 0 ? '' : '(empty)'}`)
    .join(' ');

  const blocks = [
    {
      key: 'header',
      priority: 0,
      text: [
        `PAPER ${paper.title || '(title not detected)'}`,
        `MAP ${paper.pageCount}p · ${Math.round(paper.totalChars / 100) / 10}k chars · full text ≈${paper.estimatedTokens} tok`,
        `SECTIONS ${map}`,
        `COUNT tables=${paper.tables} figures=${paper.figures} refs≈${paper.referenceCount} floats=${captions.length}`,
      ].join('\n'),
    },
  ];
  if (abstractText !== '') blocks.push({ key: 'abstract', priority: 1, text: `ABSTRACT\n${abstractText}` });
  if (contributions.length > 0) blocks.push({ key: 'claims', priority: 2, text: `CLAIMED CONTRIBUTIONS\n${contributions.map((text) => `- ${clip(text, 300)}`).join('\n')}` });
  if (mechanism.length > 0) blocks.push({ key: 'mechanism', priority: 3, text: `CORE MECHANISM\n${mechanism.map((text) => `- ${clip(text, 300)}`).join('\n')}` });
  if (evidenceList.length > 0) blocks.push({ key: 'evidence', priority: 4, text: `HEADLINE EVIDENCE\n${evidenceList.map((text) => `- ${clip(text, 300)}`).join('\n')}` });
  if (limitsSource.length > 0) blocks.push({ key: 'limits', priority: 5, text: `STATED LIMITS\n${limitsSource.slice(0, 6).map((text) => `- ${clip(text, 260)}`).join('\n')}` });
  if (futureSource.length > 0) blocks.push({ key: 'future', priority: 5, text: `AUTHOR-STATED FUTURE WORK\n${futureSource.slice(0, 5).map((text) => `- ${clip(text, 260)}`).join('\n')}` });
  if (assumptionSource.length > 0) blocks.push({ key: 'assumptions', priority: 6, text: `ASSUMPTIONS\n${assumptionSource.slice(0, 4).map((text) => `- ${clip(text, 220)}`).join('\n')}` });
  if (threatSource.length > 0) blocks.push({ key: 'threats', priority: 6, text: `THREATS TO VALIDITY\n${threatSource.slice(0, 3).map((text) => `- ${clip(text, 220)}`).join('\n')}` });
  if (captions.length > 0) blocks.push({ key: 'floats', priority: 7, text: `FLOATS\n${captions.map((text) => `- ${clip(text, 200)}`).join('\n')}` });
  if (signals.length > 0) blocks.push({ key: 'signals', priority: 8, text: `UNCOVERED ANGLES (heuristic, verify against the text)\n${signals.map((text, index) => `${index + 1}. ${text}`).join('\n')}` });

  // Fill by priority until the character budget is spent; the header always stays.
  blocks.sort((a, b) => a.priority - b.priority);
  const kept = [];
  let used = 0;
  for (const block of blocks) {
    if (block.key !== 'header' && used + block.text.length > budgetChars) continue;
    kept.push(block);
    used += block.text.length + 2;
  }
  const text = kept.map((block) => block.text).join('\n\n');
  return {
    text,
    chars: text.length,
    estimatedTokens: estimateTokens(text),
    omitted: blocks.filter((block) => !kept.includes(block)).map((block) => block.key),
    fullTextTokens: paper.estimatedTokens,
  };
}
