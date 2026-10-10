<div align="center">

<img src="assets/logo.svg" width="96" height="96" alt="TriOffice logo">

# TriOffice

**A dependency-free, browser-native open-source office suite**

Writer · Sheet · Deck — open a tab and start working. Your data never leaves your machine.

[中文说明](./README.md) · [Architecture](./docs/ARCHITECTURE.md) · [File format](./docs/FORMAT.md) · [Functions](./docs/FUNCTIONS.md) · [Shortcuts](./docs/KEYBINDINGS.md) · [Roadmap](./docs/ROADMAP.md)

</div>

---

## What it is

TriOffice is a small office suite that uses **zero third-party libraries**. It ships three apps:

| App | Comparable to | Highlights |
| --- | --- | --- |
| **Writer** | Word | Rich text, headings, lists & checklists, quotes, code blocks, tables, images; export **Markdown / HTML / plain text / PDF** |
| **Sheet** | Excel | Cell grid with **202 spreadsheet functions**, cross-sheet refs, merges, freeze panes, sorting, fill handle, SVG charts; import/export **CSV / XLSX** |
| **Deck** | PowerPoint | Drag-and-drop slides (text, images, shapes, lines), 5 themes, speaker notes, fullscreen presenting; export a **standalone HTML deck** |

There are **no dependencies, no bundler, no backend**. The source itself is native ES modules that run
straight in the browser; `npm start` is a 30-line static file server. `npm run build` produces
**a single self-contained HTML file** that works fully offline.

## Quick start

```bash
git clone <this repo>
cd trioffice
npm start          # zero-dependency local static server
```

Open the printed URL (default <http://127.0.0.1:5173>).

**Prefer a single offline file?**

```bash
npm run build      # writes dist/triooffice.html (~600 KB, all CSS/JS inlined)
```

Copy that one file anywhere and open it — no network needed.
For deployment, `dist/index.html` plus `dist/src/` is a ready-to-serve static site.

## Highlights

- **Unified `.trio` file format** — plain UTF-8 JSON, human-readable, diffable. Spec: [docs/FORMAT.md](./docs/FORMAT.md)
- **Local-first storage** — documents live in IndexedDB; nothing is uploaded, there is no account, no telemetry
- **202 functions** — aggregation, text, date, lookup, logical, dynamic arrays, financial, engineering, info. See [docs/FUNCTIONS.md](./docs/FUNCTIONS.md)
- **Self-written engines** — formula evaluator (tokenizer → parser → lazy evaluator with cycle detection),
  ZIP writer/reader (store + deflate), minimal XML parser, and an ESM bundler used only by the build script
- **Bilingual UI** (中文 / English), light & dark themes, keyboard-first workflow
- **Task templates** — meeting notes, weekly report, budget, task tracker, project report
- **Tests without a browser** — `node --test`, 98 cases covering the formula engine, XLSX round-trips,
  Markdown round-trips, ZIP/XML, storage, plus a tiny **DOM shim** that actually mounts the workbench and all
  three apps and clicks every toolbar button (catching TDZ / typo crashes that static analysis can't see),
  and static consistency checks (imports resolve, i18n keys exist, icons exist, CSS classes exist)

## Project layout

```
index.html                single page entry
src/core/                 dom, ui, idb, store, format (.trio), zip, xml, history, router, i18n
src/apps/writer/          document editor + markdown.js (pure md <-> html)
src/apps/sheet/           address, value, formula, functions, workbook, grid, chart, xlsx
src/apps/deck/            themes, render, index
src/shell/                home view, app frame, templates
src/styles/               plain CSS (base/shell/writer/sheet/deck)
tests/                    node:test suites
scripts/                  serve, build (custom bundler), make-examples, make-docs, set-repo
docs/                     architecture, format, functions, keybindings, roadmap
examples/                 sample .trio / .xlsx / .csv / .md / .html files
```

## Development

```bash
npm start                      # dev server
npm test                       # run all tests
npm run build                  # build dist/ and the single-file edition
node scripts/make-examples.mjs # regenerate examples/
node scripts/make-docs.mjs     # regenerate docs/FUNCTIONS.md from the function registry
```

## Honest limitations

TriOffice is intentionally lightweight — it is **not** a byte-compatible replacement for Office:

- No `.docx` / `.pptx` import or export (use `.md` / `.html` / `.trio`)
- XLSX covers values, formulas, number formats, column widths, merges and freeze panes;
  **charts are not written into XLSX**, and pivot tables / macros are out of scope
- The formula engine covers 202 common functions, not every edge case of array broadcasting
- Sheets are capped at 5000 rows × 200 columns
- No collaboration, cloud sync, comments, or track changes; PDF export goes through the browser's print dialog
- The rich text editor relies on `document.execCommand`, a legacy-but-still-shipping API

If you need those guarantees, look at [ONLYOFFICE](https://github.com/ONLYOFFICE),
[LibreOffice](https://github.com/LibreOffice/core) or [Univer](https://github.com/dream-num/univer).
TriOffice aims to be **small enough to read, good enough to use**.

## Publish your own copy

CI is already wired up (`.github/workflows/ci.yml` runs tests and a build on every push/PR).

```bash
node scripts/set-repo.mjs <your-github-username>   # replaces the OWNER placeholder and adds a CI badge
git add -A && git commit -m "chore: initial commit"
git remote add origin git@github.com:<your-github-username>/trioffice.git
git push -u origin main
```

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © TriOffice contributors
