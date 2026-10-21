# Bibliography for Paper 1 — what was found, what was built

## What was there

Paper 1 had **no bibliography**. Not a thin one — none:

- zero `\cite{}` commands anywhere in `chapters/p1-*.tex`
- no `.bib` file, no `\bibliography`, no bibliography package in `main.tex`
- instead, 18 `\subsection{References}` blocks, one per chapter

Those 18 blocks were not 18 different lists. They were **the same three lines
copied verbatim into every chapter**: the Zenodo monograph, the Pellis viXra
preprint, and the Sherbon HAL preprint. Three preprints, zero peer-reviewed
sources, repeated 18 times.

The same block appears in **38 files across the whole compendium**, so Papers 2
and 3 carry the identical hole — 20 files still do, see *Remaining work*.

Meanwhile the prose cited real literature properly — Rissanen, Barron/Rissanen/Yu,
Grünwald, Chaitin, PDG, CODATA, Planck, Udrescu & Tegmark, Angelis et al. — but
only as inline text. None of it was in any list.

Appendix D held a source list where **all nine URLs were empty**
(`- PDG 2024 Physical Constants table: URL:` with nothing after). That template
was never filled in. It has been replaced by real citations.

## What was built

`references.bib` — 14 entries. Every one verified, none typed from memory:

| Source | How verified |
|---|---|
| Rissanen 1978, Barron–Rissanen–Yu 1998, Benjamini–Hochberg 1995, PDG 2024 | Crossref, plus cross-check against the already-audited bibliography of the Pellis–Vasilev–Olsen short paper |
| Angelis et al. 2023, Udrescu & Tegmark 2020, CODATA 2022, Planck 2018 VI | Crossref API, by DOI or exact-title query |
| Grünwald 2007, Chaitin 1987, Olsen 2006 | books; publisher, year, ISBN |
| Pellis viXra, Sherbon HAL, Vasilev Zenodo | marked **preprint / self-published** in a `note` field |

Two Crossref queries initially returned **wrong** matches — CODATA *2014* and
Planck *2015* — from fuzzy bibliographic search. Both were re-queried by exact
title and DOI. Do not trust a single fuzzy Crossref hit for these.

The three non-peer-reviewed sources carry an explicit note. They are the claims
*under test*, not supporting evidence, and the file says so. Do not silently
upgrade them to journal status.

## Changes to the chapters

- 18 duplicated `\subsection{References}` blocks removed.
- **34 citations** inserted into the prose (28 in pass 1, 6 in pass 2), via
  `cite_p1.pl` and `cite_p1_pass2.pl` — kept in the tree so the conversion is
  reproducible and reviewable rather than a mystery diff.
- Appendix D's hollow URL list replaced with real citations.
- `main.tex`: added `\usepackage[numbers,sort&compress]{natbib}`,
  `\bibliographystyle{plainnat}`, `\bibliography{references}`.

## Verification

All 9 citation keys used in Paper 1 resolve against `references.bib`
(set difference used-minus-defined is empty). A minimal document citing all 14
entries compiles with **0 BibTeX warnings** and renders every entry with its
DOI.

## The compendium now builds — it never did before

`tectonic main.tex` now produces a **139-page PDF** with the bibliography
typeset at the end. Before this work it did not compile at all.

The source is ASCII-flattened mathematics from a PDF/markdown conversion, and
it carried five distinct classes of fatal error. `mathcheck.pl` reports the
first two; all are fixed by `mathfix.pl` plus a few hand edits:

| Class | Count | Example |
|---|---|---|
| line ends mid-math, span runs on and dies at the paragraph break | 23 | `...also uses $\varphi` |
| `^` / `_` in text mode | 103 | `R^+`, `F^*(theta)` |
| double-escaped underscore — `\\` is a line break, `_` then bare | 2 | `\texttt{uio\\_out}` |
| markdown `#` table header turned into `\section{}` inside `tabular` | 2 | `\section{\& Item \& Required Answer \\}` |
| stray closing brace from a mangled superscript | 1 | `{0,1}D}` was `{0,1}^D` |

`mathfix.pl` closes the open spans and escapes the stray `^`/`_`. It does **not**
reconstruct the intended mathematics: the goal was a document that builds, not
one that is typeset correctly.

**That distinction matters.** The conversion damage is still there and still
visible in the output — `$\in$fty` where `infty` was meant (the letters "in"
became the set-membership symbol), `muT(x)`, `lambda^*L`, `alpha-1`. Rendering
the flattened notation properly is a separate and much larger job.

### One correction made during this work

The first version of `mathfix.pl` recognised only `$...$` as math and so
escaped the `^` inside `\ensuremath{{}^{2}}` in `main.tex`, breaking all
thirteen Unicode superscript definitions (⁻ ⁺ ⁰ ¹ … ⁿ). They would have
rendered as a literal caret. Reverted; `main.tex` now differs from the
bibliography commit by nothing. The `equation` and `align` environments were
checked and were never touched.

## Remaining work

1. **Repair the flattened mathematics.** The document compiles but much of its
   notation is wrong in the output. This is the large remaining task.
2. **Unicode characters silently dropped.** The build warns on `…`, `⟂`, `≲`,
   `ℚ` — absent from the `ec-lmr10` font and missing from the
   `\newunicodechar` table in `main.tex`. They vanish from the PDF without an
   error.
3. **20 files in Papers 2 and 3** still carry the three-preprint boilerplate.
   `references.bib` already covers the shared sources; the same scripts
   generalise.
4. **436 placeholders** (`\_\_C0\_\_`, `\_\_M0\_\_`, …) across 17 files,
   including the CRediT table in `frontmatter/fm-02-attribution.tex`. They now
   print literally into the PDF.
5. Decide **Catalog42 vs Catalog15** — the compendium says Catalog42
   throughout; the short paper says Catalog15.
