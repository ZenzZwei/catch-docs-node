import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { sha8 } from './utils.js';

const EXT_FROM_CT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/avif': '.avif',
};

/**
 * Download assets referenced in html using the same authenticated context.
 * Mutates the html string by rewriting src to relative local paths.
 */
export async function localizeAssets(
  ctx: BrowserContext,
  html: string,
  pageUrl: string,
  mdFileAbs: string,
  assetsRoot: string,
): Promise<string> {
  const imgRegex = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  const seen = new Map<string, string>();
  const tasks: Promise<void>[] = [];

  const rewritten = html.replace(imgRegex, (tag, src: string) => {
    let abs: string;
    try { abs = new URL(src, pageUrl).toString(); } catch { return tag; }
    if (abs.startsWith('data:')) return tag;

    let rel = seen.get(abs);
    if (!rel) {
      const name = sha8(abs);
      const tmpAbs = path.join(assetsRoot, name);
      tasks.push(downloadOne(ctx, abs, tmpAbs).then((finalAbs) => {
        if (finalAbs) {
          const relPath = path.relative(path.dirname(mdFileAbs), finalAbs).replace(/\\/g, '/');
          seen.set(abs, relPath);
        }
      }));
      rel = abs; // placeholder; real value patched in pass 2
      seen.set(abs, abs);
    }
    return tag.replace(src, `__ASSET__${sha8(abs)}__`);
  });

  await Promise.all(tasks);

  // Pass 2: replace placeholders
  return rewritten.replace(/__ASSET__([0-9a-f]{8})__/g, (_m, token) => {
    for (const [absUrl, localRel] of seen) {
      if (sha8(absUrl) === token && localRel !== absUrl) return localRel;
    }
    return _m;
  });
}

async function downloadOne(
  ctx: BrowserContext,
  url: string,
  destNoExt: string,
): Promise<string | null> {
  try {
    const resp = await ctx.request.get(url, { timeout: 30_000 });
    if (!resp.ok()) return null;
    const ct = (resp.headers()['content-type'] || '').split(';')[0].trim();
    const ext = EXT_FROM_CT[ct] || path.extname(new URL(url).pathname) || '.bin';
    const finalAbs = destNoExt + ext;
    await fs.mkdir(path.dirname(finalAbs), { recursive: true });
    await fs.writeFile(finalAbs, await resp.body());
    return finalAbs;
  } catch {
    return null;
  }
}
