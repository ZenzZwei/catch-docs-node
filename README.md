# CatchDocs

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)

> Crawl login-protected documentation sites and export them as a clean Markdown tree — ready for Copilot, Claude, RAG pipelines, or any AI workflow.

## What It Does

CatchDocs turns internal wikis and docs (eng.ms, Confluence, Docusaurus, MkDocs, DocFX, GitBook, etc.) into neatly organized `.md` files that mirror the original URL structure. It uses a real browser with your login session — no credential hacking, no SSO bypass, no UA spoofing. If you can see it in a browser, CatchDocs can grab it.

## Features

| | Feature | Description |
|---|---|---|
| **Auth** | Persistent login | Playwright persistent profile — log in once via SSO/AAD, stay authenticated across runs |
| **Extract** | Smart content detection | CSS selector chain + heuristic scoring; falls back to Mozilla Readability |
| **SPA** | SPA-aware | Waits for real content to render (not just `Loading...` spinners) |
| **Convert** | HTML → Markdown | Turndown + GFM plugin; preserves code blocks, tables, `<details>` |
| **Assets** | Image localization | Downloads images to `_assets/`, rewrites links to relative paths |
| **Incremental** | SHA-256 dedup | Skips unchanged pages on re-crawl |
| **Scope** | Flexible targeting | `single` page / `sidebar` (auto-detect parent path) / `custom` regex patterns |
| **Sitemap** | sitemap.xml support | Optionally parse sitemap (with recursive sitemap-index) to discover URLs |
| **Robots** | robots.txt compliance | Optionally respect `Disallow` rules |
| **Profiles** | Multi-account | Separate browser profiles for different accounts/sites |
| **History** | Task history | Persistent log of all crawl/login tasks |
| **UI** | Local Web UI | Single-file, no-framework UI on `localhost:5174` with SSE real-time logs, Markdown preview, dark mode |
| **Control** | Cancellable | Gracefully stop any running crawl from the UI |

## Quick Start

### From Release (recommended)

1. Download the zip for your platform from [Releases](https://github.com/ZenzZwei/catch-docs-node/releases)
2. Extract and double-click `CatchDocs.bat` (Windows) or run `./catchdocs.sh` (macOS/Linux)
3. A desktop window opens — no installation needed

### From Source

```bash
git clone https://github.com/ZenzZwei/catch-docs-node.git
cd CatchDocs
npm install
npx playwright install chromium   # first time only
npm run serve                     # opens Web UI at http://localhost:5174
```

### Usage

1. **Paste a URL** — any documentation site you can access in a browser
2. **Log in** (if needed) — click "Browser Login", complete sign-in in the popup, then close it
3. **Choose scope** — single page, sidebar (auto-detect), or custom regex
4. **Crawl** — hit "Start" and watch real-time logs in the task panel
5. **Browse output** — switch to the Output tab to preview rendered Markdown

No configuration file needed — just paste a URL and go. Advanced users can tweak settings in the "Advanced Options" panel or edit `catchdocs.config.json` directly.

### Output Structure

```
output/
├── docs/
│   └── wiki.example.com/
│       └── docs/
│           └── product/
│               ├── intro.md
│               └── api/
│                   └── reference.md
├── _assets/
│   └── <sha>.png
├── _meta/
│   └── manifest.json
└── SUMMARY.md
```

## CLI

```bash
npx tsx src/cli.ts init              # generate catchdocs.config.json
npx tsx src/cli.ts login             # open browser for login
npx tsx src/cli.ts crawl             # start crawling
npx tsx src/cli.ts serve             # launch Web UI (app window mode)
npx tsx src/cli.ts serve --no-app-mode  # open in regular browser tab
npx tsx src/cli.ts serve --no-open   # launch without opening browser
```

## Build & Distribution

```bash
npm run bundle    # portable build → dist/ (requires Node.js on target machine)
npm run pack      # SEA build → dist/CatchDocs.exe (standalone, no Node.js needed)
```

To create a GitHub Release, push a version tag:

```bash
git tag v0.1.0
git push --tags
# → GitHub Actions builds for Windows/macOS/Linux and creates a Release
```

## Configuration

All options go in `catchdocs.config.json` (see `catchdocs.config.example.json`):

| Field | Type | Default | Description |
|---|---|---|---|
| `startUrls` | string[] | `[]` | Entry point URLs |
| `output` | string | `./output` | Output directory |
| `profileDir` | string | `./.profile` | Browser session directory |
| `browserChannel` | string | `msedge` | `chrome` / `msedge` / `chromium` |
| `headless` | bool | `false` | Headless mode (login requires `false`) |
| `concurrency` | number | `3` | Parallel page limit |
| `requestDelayMs` | number | `500` | Delay between requests (ms) |
| `maxPages` | number | `500` | Max pages to crawl |
| `maxDepth` | number | `6` | Link-follow depth |
| `sameOriginOnly` | bool | `true` | Stay on same origin |
| `scope` | string | `custom` | `single` / `sidebar` / `custom` |
| `includePatterns` | string[] | `[]` | URL include regexes (for `custom`/`sidebar`) |
| `excludePatterns` | string[] | `[]` | URL exclude regexes |
| `contentSelectors` | string[] | — | CSS selectors for main content (tried in order) |
| `navSelectors` | string[] | — | CSS selectors for link discovery |
| `waitForSelector` | string | `null` | Extra selector to wait for before extraction |
| `downloadAssets` | bool | `true` | Download and localize images |
| `useSitemap` | bool | `false` | Parse sitemap.xml for URL discovery |
| `respectRobots` | bool | `true` | Obey robots.txt Disallow rules |

## Scope Modes

| Mode | Follows Links | Behavior |
|---|---|---|
| `single` | No | Only crawl the start URLs; ignores `includePatterns` |
| `sidebar` | Yes | Auto-generates regex from parent path of start URL + `includePatterns` |
| `custom` | Yes | Entirely controlled by `includePatterns` |

## Architecture

```
┌──────────────┐         ┌───────────────────────────────┐
│  web/index   │  HTTP   │    src/server.ts (Node http)  │
│  (Single-    │ ──────► │  /api/config /api/crawl /...  │
│   page UI)   │   SSE   │  /api/job/stream (live logs)  │
└──────────────┘       ▲ └──────────────┬────────────────┘
                       │                │ spawn
                       └───── logs ─────┤
                                        ▼
                         ┌─────────────────────────────┐
                         │  src/crawler.ts              │
                         │   ├─ launchContext (Playwright)│
                         │   ├─ discoverSite (sitemap)   │
                         │   ├─ queue loop   (p-limit)   │
                         │   ├─ extract      (DOM→text)  │
                         │   ├─ converter    (turndown)  │
                         │   ├─ localizeAssets (images)  │
                         │   ├─ writer       (md files)  │
                         │   └─ manifest     (SHA-256)   │
                         └─────────────────────────────┘
```

## Content Extraction Pipeline

1. **Selector-based** — iterates `contentSelectors`, skips noise elements (`nav`, `footer`, `sidebar`, `toc`, `menu`, `breadcrumb`, `toolbar`, `pagination`)
2. **Heuristic scoring** — if selectors miss, scans `article`/`main`/`section`/`.markdown`/`.content` and picks the block with the most text
3. **Readability fallback** — if extracted text < 250 chars, re-parses with Mozilla Readability
4. **Link discovery** — collects links from `navSelectors` + all `<a>` tags in content; deduplicates and enqueues
5. **Markdown conversion** — Turndown + GFM plugin; preserves code language hints, `<details>`/`<summary>` blocks

## Tech Stack

- **Runtime**: Node.js 18+ / TypeScript 5
- **Browser automation**: Playwright (Chromium, Chrome, or Edge channel)
- **HTML → Markdown**: Turndown + turndown-plugin-gfm
- **Content extraction**: @mozilla/readability (injected into page)
- **Markdown preview**: marked
- **CLI**: Commander
- **Concurrency**: p-limit
- **Server**: Native Node.js `http` + SSE — no Express, no Vite, no frontend framework

## Security & Compliance

- **Authorized crawling only** — only crawl sites you have permission to access.
- **Never share your profile directory** — it contains your login session, cookies, and tokens.
- **Respect site ToS** — if a site prohibits automated access, consult the site owner first.
- **Adjustable rate limiting** — `requestDelayMs` defaults to 250ms; increase for large sites.

## License

MIT
