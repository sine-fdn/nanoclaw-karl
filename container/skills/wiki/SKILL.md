---
name: wiki
description: Maintain this group's persistent knowledge wiki, following Karpathy's LLM Wiki pattern. Use for every wiki operation — ingesting sources, answering questions from the wiki, and lint health checks. Triggers on "ingest", "wiki", "knowledge base", "lint", or when the user shares a document/URL meant for the wiki.
---

# Wiki (schema layer)

You maintain a persistent knowledge wiki for this group, following
Karpathy's LLM Wiki pattern. This file is the generic schema — the
operations, conventions, and source-format handling that apply regardless
of domain. **This group's own standing instructions define the specifics**
(wiki root path, raw-sources path, domain, and any extra conventions) —
read those first; they take precedence over anything generic here.

## Layers

| Layer | Rules |
|---|---|
| Raw sources | Immutable. Never edit or delete existing files. New material: new file in a fitting subdirectory (create one if needed), date-prefixed per that directory's convention. |
| Wiki | Yours to maintain. Interlinked markdown pages. |
| Schema | This skill + this group's standing instructions. Change only with the operator. |

When a source arrives via chat (attachment, pasted text, URL), first save it
under the raw-sources path as a dated file, then ingest it. For URLs
download the full document instead of relying on a summarizing fetch tool:

```bash
curl -sLo <sources-dir>/<subdir>/<YYYY-MM-DD>-<slug>.<ext> "<url>"
```

If the source is a webpage rather than a downloadable file, use
`agent-browser` (if installed) or fetch tooling to extract the full text —
not just a summary.

## Source formats

- **PDFs:** convert to Markdown before ingesting — never read the PDF
  directly for ingestion. After saving the PDF under the raw-sources path,
  run:
  ```bash
  marker_single <sources-dir>/<subdir>/<YYYY-MM-DD>-<slug>.pdf --output_format markdown --output_dir <sources-dir>/<subdir>/
  ```
  (requires Marker installed in the container image — see the project's
  `INSTALL_MARKER` build flag). This writes a Markdown twin next to the PDF
  (same date-prefixed name, `.md` extension). Read and ingest **that
  Markdown file**, not the PDF — it's what you cite against for this
  source. The PDF stays in the raw-sources path as the immutable original.
  Exception: scanned/image-only PDFs — Marker expects a digital,
  text-bearing PDF. If a PDF turns out to be a scan, fall back to reading
  it natively for that source and note the exception in `wiki/log.md`.
- **Images:** read natively — no extra tooling needed.
- **Voice/audio:** unless a transcription capability is installed for this
  group, only ingest already-transcribed text (e.g. from Voice Memos,
  Otter) as the dated source file; never attempt to process a raw audio
  file. If someone hands you audio, ask for a transcript instead.

## Conventions (defaults — this group's standing instructions may override)

- Filenames kebab-case. Pages interlink with standard relative markdown
  links.
- Every claim traceable to a file in the raw-sources path — or marked
  inline as `⟨Inference: …⟩` (derived, with basis) or `⟨Background: …⟩`
  (general knowledge). Represent contradictions; never resolve them
  silently.
- One canonical page per concept/entity — update, don't duplicate.
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

**Lint** (on a schedule if configured, and on demand): check for
contradictions, stale claims superseded by newer sources, orphan pages,
concepts without pages, missing cross-references, unresolved
`⟨Inference⟩` claims worth verifying. Report findings to the user; log as
`## [YYYY-MM-DD] lint | <summary>`.
