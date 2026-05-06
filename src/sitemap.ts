import type { BrowserContext } from 'playwright';
import { normalizeUrl } from './utils.js';

export interface SiteMeta {
  sitemapUrls: string[];
  disallow: string[];
}

interface SiteMetaInternal extends SiteMeta {
  sitemapsFromRobots?: string[];
}

/**
 * Fetch /sitemap.xml and /robots.txt for the origin using authenticated context.
 * Returns URLs discovered and Disallow rules (applied to any User-agent).
 */
export async function discoverSite(ctx: BrowserContext, origin: string): Promise<SiteMeta> {
  const result: SiteMetaInternal = { sitemapUrls: [], disallow: [] };

  // robots.txt -----------------------------------------------------------
  try {
    const r = await ctx.request.get(`${origin}/robots.txt`, { timeout: 10_000 });
    if (r.ok()) {
      const text = await r.text();
      parseRobots(text, result, origin);
    }
  } catch { /* ignore */ }

  // sitemap from robots first, else default location
  const seeds = new Set<string>(
    result.sitemapsFromRobots || [`${origin}/sitemap.xml`],
  );
  delete result.sitemapsFromRobots;
  const seen = new Set<string>();

  for (const sm of seeds) {
    await fetchSitemap(ctx, sm, result, seen);
  }

  return result;
}

function parseRobots(text: string, result: SiteMetaInternal, origin: string): void {
  const sitemaps: string[] = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      applies = val === '*' || /catchdocs/i.test(val);
    } else if (key === 'disallow' && applies && val) {
      result.disallow.push(val);
    } else if (key === 'sitemap') {
      sitemaps.push(val);
    }
  }
  if (sitemaps.length) result.sitemapsFromRobots = sitemaps;
}

async function fetchSitemap(
  ctx: BrowserContext,
  url: string,
  out: SiteMeta,
  seen: Set<string>,
  depth = 0,
): Promise<void> {
  if (depth > 3 || seen.has(url)) return;
  seen.add(url);
  try {
    const r = await ctx.request.get(url, { timeout: 15_000 });
    if (!r.ok()) return;
    const text = await r.text();
    // crude but robust: pull all <loc>...</loc>
    const locs = Array.from(text.matchAll(/<loc>([^<]+)<\/loc>/gi)).map(m => m[1].trim());
    if (/<sitemapindex/i.test(text)) {
      for (const child of locs) await fetchSitemap(ctx, child, out, seen, depth + 1);
    } else {
      for (const u of locs) out.sitemapUrls.push(normalizeUrl(u));
    }
  } catch { /* ignore */ }
}

export function buildDisallowRegexes(disallow: string[], origin: string): string[] {
  // Convert robots Disallow path rules to URL regex patterns.
  return disallow.map(rule => {
    // Escape but keep * and $ semantics
    const escaped = rule
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    // Anchor to origin; rule matches path prefix
    return `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${escaped}`;
  });
}
