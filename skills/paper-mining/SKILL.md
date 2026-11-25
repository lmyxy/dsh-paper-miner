---
name: paper-mining
description: Read PDF research papers for a fraction of their prompt cost and turn them into concrete research directions. Use when the user gives a PDF paper, asks for a paper summary or reading note, asks what a paper's weaknesses or next steps are, or asks for extension/exploration ideas from one or more papers.
---

# Reading papers on a token budget

The `paper_*` tools already did the reading on the Host: PDF parsing, section
segmentation, sentence indexing and coverage checks. Your job is judgement, not
transcription. Spend tokens on reasoning about the paper, not on re-reading it.

## Token discipline

- Never open the PDF another way (`ops_read_pdf`, shell `pdftotext`) when the
  paper tools can serve it. They cache; nothing else does.
- One `paper_brief` per paper is enough for a summary and a direction list.
- Drill down only with a specific question, via `paper_find`. Use `paper_slice`
  only when exact wording, an equation's setup, or a table's numbers matter.
- Each tool result states its own cost and the full-text cost. If a draft answer
  would need more than about two drill-downs per paper, say which specific facts
  are missing instead of reading the whole section.
- For a batch, `paper_scan` every paper first and `paper_brief` only the ones
  that matter. Do not brief a paper you have already decided to skip.

## Working one paper

1. `paper_brief` — read the digest. Note the MAP/COUNT line: it tells you how
   much of the paper is experiments versus prose, and whether references
   suggest a young or mature area.
2. Identify the paper's *one* central claim. The brief's CLAIMED CONTRIBUTIONS
   are the authors' own framing; the CORE MECHANISM lines say what actually
   makes it work.
3. Check the claim against the evidence: HEADLINE EVIDENCE and the table
   captions. Ask yourself whether the numbers support the claim as worded, and
   whether the comparison baselines are the ones a reviewer would demand.
4. Read UNCOVERED ANGLES as leads, not conclusions. Each one names a coverage
   gap (single benchmark, no variance, no latency numbers, no ablation, no
   release, no limitations). One `paper_find` call per lead you intend to use.
5. Only then write.

Output in the user's language. A useful shape:

- **一句话结论** — what the paper actually establishes, with the number that
  carries it.
- **方法要点** — 3–5 bullets on the mechanism, not the prose.
- **证据强度** — baselines, datasets, ablations, variance, cost measurements;
  say explicitly what is missing.
- **可延伸方向** — 3–5 directions. For each: 起点 (paper sentence or signal),
  缺口, 具体做法, 最小验证实验, 风险或反例, 难度.
- **不该延伸的方向** — 1–2 things that look like gaps but are already settled or
  would not be publishable. This is what distinguishes a research judgement from
  a summary.

## Working several papers

Build a comparison matrix over the same four columns for every paper: problem
setting, mechanism, evidence, missing. Then look for the gap that is *shared* —
the same unmeasured thing in three papers is a stronger direction than a gap in
one. Cross-paper directions are worth more than a stacked list of per-paper
ideas; say which papers a direction would unify.

## Quality bar

- Every direction must trace to a specific sentence, caption, or signal. Quote
  the trace in one short clause; do not fabricate line numbers or citations.
- Separate the paper's claims from your inference. Write "作者称…" and "但证据
  只覆盖…" as different statements.
- Prefer directions that a single person can test in 1–3 weeks with an existing
  benchmark. Say what the baseline and the metric would be.
- Never invent citations, venues, or numbers. If a follow-up needs literature
  search, say so and list the queries to run.
- If the brief is missing something you need, ask for one more drill-down rather
  than guessing.

## When the tool cannot help

Scanned or encrypted PDFs are refused with a message. Say so plainly and ask
for a text-layer copy; do not fall back to describing the paper from its title.
