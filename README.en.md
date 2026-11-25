# paper-miner

> Read PDF papers for a fraction of their token cost, and mine them for research directions.
> 用极小的 token 成本精读 PDF 论文，并从中挖出可延伸的研究方向。

**English** · [中文](README.md)

Built for computer-science research: reading papers, writing literature notes, deciding whether a paper is worth reading, and working out what to do next.

---

## Why it exists

A 10-page CS paper costs roughly **5–12k prompt tokens** as raw text, and **20–35k** once the appendix and references are included. Four papers fill a context window, and most of that budget goes into re-reading the paper rather than reasoning about it.

paper-miner moves the reading onto the Host — locally, with no model calls. PDF parsing, section segmentation, sentence indexing and coverage checking all happen on disk; the model receives an **already-selected brief** and drills into sentences only when it needs to.

Measured on one machine, three LaTeX-built fixtures plus a real journal PDF:

| Paper | Full text | `paper_brief` | Saving |
|---|---:|---:|---:|
| 8 pages, single column, 3 tables + 2 TikZ figures | 6,179 tok | 1,279 tok | **4.8×** |
| 4 pages, two column | 3,530 tok | 1,000 tok | 3.5× |
| 4 pages, maths-heavy with proofs | 2,822 tok | 745 tok | 3.8× |
| Real AASTeX paper, 19 pages | 13,378 tok | 779 tok | **17×** |

Every brief states its own cost: `COST digest≈779 tok vs full text≈13378 tok`.

## How it works

```
PDF
 └─ local parse: objects / fonts / content streams → text runs with coordinates
     └─ segmentation: heading detection + role inference + hierarchy
         └─ index: sentence splitting + BM25-lite
             └─ model calls on demand: scan → brief → find / slice
```

Parsing, segmentation, indexing and gap detection produce no model calls; the model only consumes the result.

Design choices worth knowing:

- **Selection, never paraphrase.** Every sentence in a brief is lifted from the paper. That rules out invention by the summariser, at the cost of missing a contribution that only appears in a figure.
- **Structure first.** The model gets a section map (id / role / size / page) and decides which part to read, instead of reading everything.
- **Role inheritance.** A subsection the classifier cannot name — say "Clustered routing" under Method — inherits its parent's role, so method and experiment prose is not dropped.
- **Gap signals are leads, not findings.** They are rule-derived and labelled as heuristic; the model has to confirm one with `paper_find` before relying on it.

## Install

The plugin mounts into a DSH profile as a bundle. **Install it through the plugin manager**; do not hand-edit the profile's `package.json`:

```bash
# Ask the agent to run this, or use the GUI: Plugins → Add plugin → pick this directory
plugin_manager  action=install_bundle  target=<absolute path to this directory>
```

A row called "Paper miner / 论文精读" then appears on the **Plugins** page; in `list_plugins` its `fiberPhase` should read `active`.

> ⚠️ Installing from a local directory (`file:`) links the source in place. Moving or deleting this directory breaks the plugin; pack it as an npm package first if you need it to survive.

**Requirements**: DSH `>=0.2.2-rc.1 <0.2.3-0`; Node 22.19+ or 24+ (supplied by DSH). **No third-party runtime dependencies** — the PDF parser ships with this repository and needs neither poppler, pdf.js nor Python.

## Tools

| Tool | Purpose | Cost |
|---|---|---|
| `paper_scan` | Title, section ids/roles/sizes, page count, float and reference counts — triage before reading | 200–400 tok |
| `paper_brief` | Budgeted digest: abstract, claimed contributions, core mechanism, headline numbers, stated limits, author-stated future work, assumptions, captions, uncovered angles | 0.7–1.5k tok |
| `paper_find` | Sentence-level search (BM25-lite) with section and page, optionally narrowed by section or role | 150–500 tok |
| `paper_slice` | Bounded character window of one section, paged with `start`/`chars` | as requested |
| `paper_cache` | List or purge the local extraction cache | ~50 tok |

`paper_brief` takes `max_tokens` (default 2200): 800 for triage, 4000–5000 for a deep read.

### Usage

Plain language is enough — the `paper-mining` skill takes over the workflow:

> Read `papers/moe-routing.pdf`, summarise it, and tell me what could be built on top of it.

Or call the tools directly, the cheapest two-step path:

```
paper_brief(path="papers/moe-routing.pdf", max_tokens=1500)
paper_find(path="papers/moe-routing.pdf", query="inference latency", role="limitations")
```

### The `paper-mining` skill

Registered with the plugin and loaded only when needed, so it costs nothing in the standing prompt. It enforces: one brief per paper, no drill-down without a specific question, and output that keeps "the authors claim" separate from "the evidence supports". It also carries a direction template — starting point / gap / approach / minimum validation experiment / risk / difficulty.

## What the output looks like

```
PAPER Efficient Long-Context Attention via Block-Sparse Kernels
MAP 4p · 13.6k chars · full text ≈3527 tok
SECTIONS s-abs:Abstract s1:Intro s2:Background s5:Background s6:Method ...
COUNT tables=1 figures=2 refs≈15 floats=3

ABSTRACT
Attention over long sequences is bounded by a quadratic term that is wasteful in practice: ...

CLAIMED CONTRIBUTIONS
- This paper describes BKATT, a block-sparse attention kernel that fixes the block granularity at 64 tokens ...

HEADLINE EVIDENCE
- Perplexity at 32K without continued training degrades by 0.9, and the degradation is concentrated on ...

STATED LIMITS
- The results support the claim that structural sparsity is a competitive way to extend context, but the evidence is limited to language modeling at a single scale.

UNCOVERED ANGLES (heuristic, verify against the text)
1. no dispersion reported: experiments mention no variance, seeds or error bars ...
2. no artifact release detected: reproduction requires reimplementation from the paper text

COST digest≈1056 tok vs full text≈3527 tok
```

## Configuration

Override the `paper-miner` row's `config` in the profile's `cordis.patch.yml`:

```yaml
- id: paper-miner
  name: '@local/dsh-paper-miner'
  config:
    briefTokens: 1800      # default paper_brief budget
    maxPdfMiB: 200         # largest accepted PDF
    cacheDir: 'D:/papers/.miner-cache'
    pdftotext: ''          # only used when the built-in parser finds too little text
```

| Key | Default | Meaning |
|---|---|---|
| `cacheDir` | `~/.dsh/paper-miner` | Extraction cache (gzip JSON, addressed by content hash) |
| `briefTokens` | `2200` | Default token budget for `paper_brief` |
| `maxPdfMiB` | `128` | Largest accepted PDF |
| `pdftotext` | unset | Path to a `pdftotext` binary, used only as a fallback |

## Cache

- Location: `~/.dsh/paper-miner/<first 32 hex of sha256>.json.gz`
- Key: SHA-256 of the file bytes — an unchanged file is never re-parsed, a changed one invalidates itself
- About 20 ms on a hit, 50–100 ms on a miss (8-page paper)
- Clear with `paper_cache(action="purge")`, or `purge` plus `key` for one entry
- Bump `FORMAT_VERSION` in `lib/cache.js` whenever parsing changes; old entries then expire automatically

## Repository layout

```
dsh-paper-miner/
├── index.js              234  plugin entry: 5 tools, skill registration, config
├── cordis.patch.yml           bundle loader patch (inserts the plugin row)
├── package.json               dsh.bundle.patch / exports / files
├── lib/
│   ├── pdf/
│   │   ├── read.js       733  object scan, stream filters, object streams, page tree
│   │   ├── font.js       287  ToUnicode CMaps, encodings, glyph names, widths
│   │   └── text.js       639  content-stream interpreter, TJ spacing, layout, column gutter
│   ├── paper.js          231  orchestration: file → lines → sections → index; cache; fallback
│   ├── sections.js       281  headings, role classification and inheritance, inline abstract
│   ├── digest.js         275  budgeted brief, gap signals, priority packing
│   ├── search.js          97  sentence index and BM25-lite retrieval
│   ├── text.js           163  hyphenation, sentence splitting, token estimate, dedupe
│   └── cache.js           87  gzip cache read/write, list, purge
├── skills/paper-mining/SKILL.md   workflow and output contract (loaded on demand)
├── docs/DETAIL.md                 plugin detail page (behaviour, config, limits)
├── locale/{en,zh}.json            titles and descriptions for the plugin manager
└── icon.svg                       icon
```

About 3,000 lines, zero runtime dependencies.

## Development and testing

The repository root (the directory above this one) holds the dev scripts and fixtures. **Run these from the root**:

```bash
# syntax check every module
for f in dsh-paper-miner/index.js dsh-paper-miner/lib/*.js dsh-paper-miner/lib/pdf/*.js; do node --check "$f"; done

# parsing only: pages, lines, token estimate, per-line coordinates
node tools/extract-test.mjs test/fixtures/figures.pdf 40 1

# section segmentation
node tools/paper-test.mjs test/fixtures/twocol.pdf

# full pipeline, including cache hits and retrieval
node tools/brief-test.mjs test/fixtures/figures.pdf 2200 "latency overhead"

# layout debugging: raw runs / assembled lines
node tools/runs-dump.mjs test/fixtures/twocol.pdf 1 500 530
node tools/lines-dump.mjs test/fixtures/twocol.pdf 1
```

Fixtures live in `test/fixtures/`: `figures.pdf` (8 pages, single column, tables + TikZ figures), `twocol.pdf` (4 pages, two column), `mathheavy.pdf` (4 pages, maths-heavy with theorem proofs). After touching parsing or segmentation, run all three and confirm:

1. The title is right, and captions are not swallowed (`Table 1:` should appear under `FLOATS`)
2. Two-column pages do not interleave left and right
3. `COUNT tables=/figures=/refs≈` matches the paper
4. The brief's token count has not crept up

After changing plugin code, re-activate it so DSH loads the new modules:

```
plugin_manager action=set_plugin target=include:paper-miner enabled=false
plugin_manager action=set_plugin target=include:paper-miner enabled=true
```

## Known limitations

- **Text-layer PDFs only.** Scanned or image-only papers are not OCRed; the call fails with a clear message instead of returning an empty summary. Encrypted PDFs are refused outright.
- **Hand-written parser.** Column detection, de-hyphenation and word spacing are heuristics: formulas get scattered into the prose, rotated tables and side notes can be misordered, and on a real paper about 1.7% of glyphs (mostly fi/fl ligatures) fail to decode.
- **Selection, not rewriting.** A contribution that exists only in a figure can be missed, and the brief is trimmed to its budget — whatever was dropped is listed in `omitted`.
- **Gap signals are rule-derived.** They describe coverage, not novelty or correctness, and must be checked before use.
- **Unusual templates.** AASTeX and similar classes can leak line numbers or running headers into the body text.

## Status

No licence declared (`private: true`; intended for one machine's profile). Before distributing, add a LICENSE, give `name` a real scope, and review the `files` packing list.
