import { createHash } from 'node:crypto';
import path from 'node:path';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Normalize URL: strip hash, trailing slash, default-port, lowercase host. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    // drop common tracking params
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^ref$|^source$/i.test(k)) u.searchParams.delete(k);
    }
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Turn an URL into a relative filesystem path ending with .md */
export function urlToRelPath(raw: string): string {
  const u = new URL(raw);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return path.join(u.hostname, 'index.md');
  const last = segs.pop()!;
  const safeSegs = segs.map(sanitizeSegment);
  const base = sanitizeSegment(last.replace(/\.(html?|aspx?|php)$/i, ''));
  const query = u.search ? '_' + sha8(u.search) : '';
  return path.join(u.hostname, ...safeSegs, base + query + '.md');
}

export function sanitizeSegment(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || '_';
}

export function sha8(s: string): string {
  return sha256(s).slice(0, 8);
}

export function matchAny(patterns: string[], value: string): boolean {
  return patterns.some(p => {
    try { return new RegExp(p).test(value); } catch { return value.includes(p); }
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
