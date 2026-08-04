---
name: wiki
description: Maintain the CCTI team's knowledge wiki in the mounted karl repository. Use for every wiki operation — ingesting sources, answering questions from the wiki, and lint health checks. Triggers on "ingest", "wiki", "knowledge base", "lint", or when the user shares a document/URL meant for the team's knowledge.
---

# CCTI Knowledge Wiki (schema layer)

You maintain the CCTI research team's wiki — a trans-personal, faithful
representation of the project's work, following Karpathy's LLM Wiki pattern.
Everything lives in the mounted repository `/workspace/extra/karl` (a git
repo; the operator commits — mention when a commit is due).

## Layers

| Layer | Location | Rules |
|---|---|---|
| Raw sources | `/workspace/extra/karl/ccti/` | Immutable. Never edit or delete existing files. New material: new file in a fitting subdirectory (create one if needed), date-prefixed per that directory's convention. |
| Wiki | `/workspace/extra/karl/wiki/` | Yours to maintain. Interlinked markdown pages. |
| Schema | this skill + your standing instructions | Change only with the operator. |

When a source arrives via chat (attachment, pasted text, URL), first save it
under `ccti/` as a dated file, then ingest it. For URLs download the full
document (`curl -sLo ccti/<subdir>/<YYYY-MM-DD>-<slug>.<ext> "<url>"`) —
never ingest from a summarizing fetch tool.

## Source formats

- **PDFs:** convert to Markdown before ingesting — never read the PDF
  directly for ingestion (see decision
  [0005](/workspace/extra/karl/decisions/0005-pdf-ingestion-via-marker-conversion.md)).
  After saving the PDF under `ccti/`, run:
  ```bash
  marker_single ccti/<subdir>/<YYYY-MM-DD>-<slug>.pdf --output_format markdown --output_dir ccti/<subdir>/
  ```
  This writes a Markdown twin next to the PDF (same date-prefixed name,
  `.md` extension). Read and ingest **that Markdown file**, not the PDF —
  it's what you cite against for this source. The PDF stays in `ccti/` as
  the immutable original.
  Exception: scanned/image-only PDFs — Marker expects a digital,
  text-bearing PDF. If a PDF turns out to be a scan, fall back to reading
  it natively for that source and note the exception in `wiki/log.md`.
- **Images:** read natively — no extra tooling needed.
- **Voice/audio:** no transcription capability is installed. Only ingest
  already-transcribed text (e.g. from Voice Memos, Otter) as the dated
  source file; never attempt to process a raw audio file. If someone hands
  you audio, ask for a transcript instead.

## Conventions

- All content in English. Filenames kebab-case. Pages interlink with
  standard relative markdown links.
- Every claim traceable to a file in `ccti/` — or marked inline as
  `⟨Inference: …⟩` (derived, with basis) or `⟨Background: …⟩` (general
  knowledge). Represent contradictions; never resolve them silently.
- One canonical page per concept/entity — update, don't duplicate.
- Write trans-personally: pages stand independent of any single researcher.
- Beyond that, structure is yours: summaries, entity pages, concept pages,
  comparisons — whatever the material calls for.

## Operations

**Ingest** (one source at a time — never batch):
1. Read the source fully — for a PDF, that's its Markdown twin (see Source
   formats above), not the PDF itself.
2. Discuss key takeaways with the user before writing.
3. Write/update all affected pages: source summary, entity pages, concept
   pages, cross-references. A single source may touch 10–15 pages.
4. Update `wiki/index.md` (every page: link + one-line summary, by category).
5. Append to `wiki/log.md`: `## [YYYY-MM-DD] ingest | <title>` + short body.
Finish one source completely before starting the next.

**Query:** read `wiki/index.md` first, load only the relevant pages, answer
with page citations. File substantial novel syntheses back into the wiki as
pages (then index + log).

**Lint** (weekly schedule + on demand): check for contradictions, stale
claims superseded by newer sources, orphan pages, concepts without pages,
missing cross-references, unresolved `⟨Inference⟩` claims worth verifying.
Report findings to the user; log as `## [YYYY-MM-DD] lint | <summary>`.

## Related repo conventions (outside the wiki)

- Decisions → `/workspace/extra/karl/decisions/`, plans →
  `/workspace/extra/karl/plans/`: `NNNN-kebab-title.md`, sequential, keep
  each `index.md` current. When the team decides something in chat, offer to
  record it as a decision.
- Operational reality changed (channels, hosting, backups)? Update
  `/workspace/extra/karl/ops/` accordingly.
