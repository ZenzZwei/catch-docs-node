import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext } from 'playwright';
import pLimit from 'p-limit';
import type { CatchDocsConfig, PageRecord } from './types.js';
import {
  normalizeUrl,
  isSameOrigin,
  urlToRelPath,
  matchAny,
  sleep,
  sha256,
} from './utils.js';
import { extract, extractSidebarLinks } from './extractor.js';
import { createConverter, htmlToMarkdown } from './converter.js';
import { localizeAssets } from './assets.js';
import { writeMarkdown, writeSummary } from './writer.js';
import { ManifestStore } from './manifest.js';
import { discoverSite, buildDisallowRegexes } from './sitemap.js';

export async function launchContext(cfg: CatchDocsConfig): Promise<BrowserContext> {
  const profile = path.resolve(cfg.profileDir);
  await fs.mkdir(profile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: cfg.browserChannel,
    headless: cfg.headless,
    viewport: { width: 1440, height: 900 },
  });
  // tsx/esbuild injects __name() helper into evaluate callbacks; polyfill it in the page.
  await ctx.addInitScript(() => {
    // @ts-ignore
    if (typeof (globalThis as any).__name !== 'function') {
      // @ts-ignore
      (globalThis as any).__name = (fn: any, _n?: string) => fn;
    }
  });
  return ctx;
}

export type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const defaultLogger: Logger = (level, msg) => {
  if (level === 'warn' || level === 'error') console.warn(msg);
  else console.log(msg);
};

export interface RunOptions {
  log?: Logger;
  signal?: AbortSignal;
}

export async function runLogin(cfg: CatchDocsConfig, opts: RunOptions = {}): Promise<void> {
  const log = opts.log ?? defaultLogger;
  const ctx = await launchContext({ ...cfg, headless: false });
  const page = await ctx.newPage();
  const url = cfg.startUrls[0] || 'about:blank';
  log('info', `[login] opening ${url}`);
  log('info', '[login] complete sign-in in the browser, then close the window.');
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await ctx.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

export async function runCrawl(cfg: CatchDocsConfig, opts: RunOptions = {}): Promise<{ processed: number; output: string }> {
  const log = opts.log ?? defaultLogger;
  if (!cfg.startUrls?.length) throw new Error('startUrls is empty');

  // ---- apply scope -----------------------------------------------------
  const scope = cfg.scope ?? 'custom';
  let effectiveMaxDepth = cfg.maxDepth;
  let followLinks = true;
  let includePatterns: string[] = [];

  if (scope === 'single') {
    followLinks = false;
    effectiveMaxDepth = 0;
    log('info', `[scope] single page only`);
    includePatterns = [];
  } else if (scope === 'custom') {
    includePatterns = cfg.includePatterns;
    log('info', `[scope] custom (use includePatterns)`);
  }
  // sidebar scope is resolved after browser launch (needs page visit)

  const outAbs = path.resolve(cfg.output);
  await fs.mkdir(outAbs, { recursive: true });

  const manifest = new ManifestStore(path.join(outAbs, '_meta', 'manifest.json'));
  await manifest.load();

  const ctx = await launchContext(cfg);
  const td = createConverter();
  const limit = pLimit(cfg.concurrency);

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = cfg.startUrls.map(u => ({
    url: normalizeUrl(u),
    depth: 0,
  }));

  // Custom scope: auto-seed parent URLs from include patterns
  // e.g. pattern ^https://host/a/b/c(/|$) → also visit https://host/a/b/c
  if (scope === 'custom') {
    for (const pat of cfg.includePatterns) {
      const m = pat.match(/^\^?(https?:\/\/[^(\[\\*?]+?)(?:\(\/\|\$\)|\/?$)/);
      if (m) {
        const seedUrl = m[1].replace(/\\\./g, '.');
        try {
          new URL(seedUrl);
          const norm = normalizeUrl(seedUrl);
          if (norm && !queue.some(q => q.url === norm)) {
            queue.push({ url: norm, depth: 0 });
            log('info', `[scope] auto-seed from pattern: ${norm}`);
          }
        } catch { /* ignore */ }
      }
    }
  }

  // ---- sidebar: extract links from actual sidebar DOM -------------------
  if (scope === 'sidebar') {
    const seedPage = await ctx.newPage();
    try {
      const seedUrl = cfg.startUrls[0];
      log('info', `[scope] sidebar: visiting ${seedUrl} to discover navigation links...`);
      await seedPage.goto(seedUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await seedPage.waitForTimeout(1000);
      const sidebarLinks = await extractSidebarLinks(seedPage, cfg.navSelectors);

      if (sidebarLinks.length > 0) {
        for (const link of sidebarLinks) {
          const norm = normalizeUrl(link);
          if (norm && !visited.has(norm)) {
            queue.push({ url: norm, depth: 1 });
          }
        }
        followLinks = false;
        log('info', `[scope] sidebar: found ${sidebarLinks.length} links from page navigation`);
      } else {
        // Fallback: use URL path heuristic
        log('warn', `[scope] sidebar: no links found in sidebar DOM, falling back to URL path heuristic`);
        for (const raw of cfg.startUrls) {
          try {
            const u = new URL(raw);
            const segs = u.pathname.split('/').filter(Boolean);
            segs.pop();
            const parent = '/' + segs.join('/');
            const base = u.origin + parent;
            const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            includePatterns.push(`^${esc}(/|$)`);
          } catch { /* ignore */ }
        }
        includePatterns.push(...cfg.includePatterns);
      }
    } finally {
      await seedPage.close();
    }
  }
  const origins = new Set(cfg.startUrls.map(u => new URL(u).origin));

  // ---- sitemap / robots ------------------------------------------------
  let effectiveExcludes = [...cfg.excludePatterns];
  if (cfg.useSitemap || cfg.respectRobots) {
    for (const origin of origins) {
      try {
        const meta = await discoverSite(ctx, origin);
        if (cfg.respectRobots && meta.disallow.length) {
          const regs = buildDisallowRegexes(meta.disallow, origin);
          effectiveExcludes.push(...regs);
          log('info', `[robots] ${origin} +${regs.length} disallow rules`);
        }
        if (cfg.useSitemap && meta.sitemapUrls.length) {
          let added = 0;
          for (const u of meta.sitemapUrls) {
            if (!visited.has(u)) { queue.push({ url: u, depth: 1 }); added++; }
          }
          log('info', `[sitemap] ${origin} +${added} URLs`);
        }
      } catch (e: any) {
        log('warn', `[discover] ${origin} :: ${e?.message ?? e}`);
      }
    }
  }

  let processed = 0;

  const processOne = async (item: { url: string; depth: number }): Promise<void> => {
    if (opts.signal?.aborted) return;
    const { url, depth } = item;
    if (visited.has(url)) return;
    visited.add(url);

    if (processed >= cfg.maxPages) return;
    if (depth > effectiveMaxDepth) return;
    if (cfg.sameOriginOnly && ![...origins].some(o => url.startsWith(o))) return;
    if (effectiveExcludes.length && matchAny(effectiveExcludes, url)) return;
    if (includePatterns.length && !matchAny(includePatterns, url)) return;

    const page = await ctx.newPage();
    try {
      await sleep(cfg.requestDelayMs);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!resp || !resp.ok()) {
        log('warn', `[skip] ${resp?.status() ?? 'ERR'} ${url}`);
        return;
      }
      // SPA sites render content after initial HTML; wait for network to settle
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      if (cfg.waitForSelector) {
        await page.waitForSelector(cfg.waitForSelector, { timeout: 15_000 }).catch(() => {});
      }
      // Poll until the main content is actually filled (not just "Loading...").
      await page.waitForFunction(
        (selectors) => {
          const pick = () => {
            for (const s of selectors) {
              const el = document.querySelector(s);
              if (el) return el;
            }
            return document.body;
          };
          const el = pick();
          const txt = (el?.textContent || '').trim();
          if (txt.length < 200) return false;
          if (/^\s*(loading|加载中)\s*\.{0,3}\s*$/i.test(txt)) return false;
          // ensure not dominated by loading indicator
          if (/loading\.{0,3}/i.test(txt) && txt.length < 400) return false;
          return true;
        },
        cfg.contentSelectors,
        { timeout: 20_000 },
      ).catch(() => {});
      // final settle
      await page.waitForTimeout(600);

      const { title, html, links, strategy, navSection } = await extract(page, cfg.contentSelectors, cfg.navSelectors);
      const finalUrl = normalizeUrl(page.url());
      const relPath = urlToRelPath(finalUrl);
      const mdFileAbs = path.join(outAbs, relPath);

      let processedHtml = html;
      if (cfg.downloadAssets) {
        const localAssetsDir = path.join(path.dirname(mdFileAbs), 'assets');
        processedHtml = await localizeAssets(ctx, html, finalUrl, mdFileAbs, localAssetsDir);
      }
      const markdown = htmlToMarkdown(td, processedHtml);
      const hash = sha256(markdown);

      const prev = manifest.get(finalUrl);
      if (prev && prev.hash === hash) {
        log('info', `[same] ${finalUrl}`);
      } else {
        const breadcrumbs = new URL(finalUrl).pathname.split('/').filter(Boolean);
        await writeMarkdown({
          url: finalUrl,
          title,
          markdown,
          relPath,
          outputRoot: outAbs,
          depth,
          breadcrumbs,
          navSection,
        });
        const rec: PageRecord = {
          url: finalUrl,
          path: relPath,
          title,
          hash,
          fetchedAt: new Date().toISOString(),
          depth,
          navSection,
        };
        manifest.set(rec);
        log('info', `[save:${strategy}] ${relPath}  <-  ${finalUrl}`);
      }
      processed++;

      for (const raw of links) {
        if (!followLinks) break;
        const next = normalizeUrl(raw);
        if (!next || visited.has(next)) continue;
        if (cfg.sameOriginOnly && !isSameOrigin(next, url)) continue;
        queue.push({ url: next, depth: depth + 1 });
      }
    } catch (e: any) {
      log('warn', `[err ] ${url} :: ${e?.message ?? e}`);
    } finally {
      await page.close().catch(() => {});
    }
  };

  // drain queue with concurrency; keep going while new items are appended
  while (queue.length && processed < cfg.maxPages && !opts.signal?.aborted) {
    const batch = queue.splice(0, cfg.concurrency * 4);
    await Promise.all(batch.map(item => limit(() => processOne(item))));
    // Periodic save
    await manifest.save();
  }

  await manifest.save();
  await writeSummary(outAbs, manifest.allPages());
  await ctx.close();
  log('info', `\nDone. Pages saved: ${processed}. Output: ${outAbs}`);
  return { processed, output: outAbs };
}
