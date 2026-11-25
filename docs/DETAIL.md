# Paper miner

Reads PDF research papers in a token-budgeted way and mines them for extension
work. The Host does the expensive reading; the model gets a small brief plus
targeted drill-downs.

## Why it is cheap

A 10-page CS paper is typically 5–12k prompt tokens as raw text, and 20–35k
with appendix, references and tables. Reading four papers that way easily fills
a context window. Paper miner parses the PDF once, on disk, and then:

- returns a structural map (a few hundred tokens) for triage;
- returns a *brief* that keeps the 10% of sentences that carry the argument —
  abstract, claimed contributions, mechanism, headline numbers, stated limits,
  author-stated future work, assumptions, captions — targets 1.5–2.5k tokens;
- answers follow-up questions by sentence lookup (a few hundred tokens) instead
  of re-reading sections;
- parses each file exactly once per content hash, cached under
  `~/.dsh/paper-miner` (gzip JSON), with an in-process layer above it.

The brief states its own cost against the full-text cost, so the saving is
visible in the transcript. Measured on three LaTeX-built fixtures:

| Paper | Full text | Brief | Saving |
| --- | --- | --- | --- |
| 8-page single column, tables + TikZ figures | 6,179 tok | 1,279 tok | 4.8× |
| 4-page two column | 3,530 tok | 1,000 tok | 3.5× |
| 4-page maths-heavy | 2,822 tok | 745 tok | 3.8× |

A warm cache makes a repeat call take about 20 ms instead of 50–100 ms of PDF
parsing.

## Tools

| Tool | Purpose | Typical cost |
| --- | --- | --- |
| `paper_scan` | title, section map with ids and sizes, page/char counts, float and reference counts | 200–400 tok |
| `paper_brief` | budgeted digest plus uncovered-angle signals | 1.5–2.5k tok |
| `paper_find` | ranked sentence hits for a query, with section and page | 150–500 tok |
| `paper_slice` | bounded character window of one section | as requested |
| `paper_cache` | list or purge the extraction cache | ~50 tok |

Sections carry a coarse research role — abstract, introduction, related work,
method, experiments, results, analysis, discussion, limitations, conclusion,
references, appendix — and unnamed subsections inherit their parent's role, so
"Clustered routing" under Method still counts as method text.

## Uncovered-angle signals

`paper_brief` ends with heuristic observations about what the paper does *not*
establish, for example: a single benchmark detected in the experiments, a cost
claim without latency or FLOPs measurements, no variance or seeds reported, no
ablation, no artifact release, or no limitations statement. They are derived
from the text with fixed rules and are labelled as heuristic. Treat them as
candidate leads to check, not as findings.

## Configuration

Override in the profile's `cordis.patch.yml` under the `paper-miner` row:

| Key | Default | Meaning |
| --- | --- | --- |
| `cacheDir` | `~/.dsh/paper-miner` | where parsed papers are cached |
| `briefTokens` | `2200` | default budget for `paper_brief` |
| `maxPdfMiB` | `128` | largest accepted PDF |
| `pdftotext` | unset | path to a `pdftotext` binary, used only when the built-in extractor finds too little text |

## Limitations

- Text-layer PDFs only. Scanned pages and images are not OCRed; the call fails
  with a clear message instead of returning an empty paper.
- Encrypted PDFs are refused.
- Extraction is a reader, not a typesetter: two-column order, hyphenation and
  word spacing are heuristic, and reading order can be wrong around rotated
  tables or side notes.
- `paper_brief` selects existing sentences. It never paraphrases, and it can
  miss a contribution that is only shown in a figure.
- Gap signals are rule-based hints about *coverage*, not judgements about
  novelty or correctness. Verify any of them against `paper_find` before
  building an argument on them.
