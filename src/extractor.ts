import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

export interface ExtractResult {
  title: string;
  html: string;
  links: string[];
  strategy: 'selector' | 'readability' | 'fallback';
  navSection?: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readabilityRel = path.join('node_modules', '@mozilla', 'readability', 'Readability.js');
const READABILITY_JS = existsSync(path.join(HERE, readabilityRel))
  ? path.join(HERE, readabilityRel)
  : path.resolve(HERE, '..', readabilityRel);

/**
 * Extract with selectors first. If result is too thin, fall back to Mozilla Readability.
 */
export async function extract(
  page: Page,
  contentSelectors: string[],
  navSelectors: string[],
): Promise<ExtractResult> {
  const primary = await extractBySelectors(page, contentSelectors, navSelectors);
  const textLen = primary.html.replace(/<[^>]+>/g, '').trim().length;
  if (textLen >= 250) return primary;

  // Fallback: inject Readability and re-parse
  try {
    await page.addScriptTag({ path: READABILITY_JS });
    const reader = await page.evaluate(() => {
      // @ts-ignore
      const R = (window as any).Readability;
      if (!R) return null;
      try {
        const doc = document.cloneNode(true) as Document;
        // @ts-ignore
        const article = new R(doc).parse();
        if (!article) return null;
        return { title: article.title || document.title, html: article.content || '' };
      } catch { return null; }
    });
    if (reader && (reader.html || '').length > primary.html.length) {
      return { title: reader.title, html: reader.html, links: primary.links, strategy: 'readability' };
    }
  } catch { /* ignore */ }

  return { ...primary, strategy: primary.strategy || 'fallback' };
}

async function extractBySelectors(
  page: Page,
  contentSelectors: string[],
  navSelectors: string[],
): Promise<ExtractResult> {
  return await page.evaluate(
    ({ contentSelectors, navSelectors }) => {
      // ---- noise filter ----------------------------------------------------
      const NOISE_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG',
        'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FORM', 'BUTTON'];
      const NOISE_CLASS_RE = /(^|\s)(header|footer|nav|sidebar|toolbar|topbar|banner|breadcrumb|pagination|toc|feedback|edit|comment|menu|dropdown|userbox|account|chat|skiplink|announcement)(\s|$|[-_])/i;
      const NOISE_ROLE_RE = /^(navigation|banner|contentinfo|complementary|toolbar|search|dialog)$/i;

      const isNoise = (el: Element): boolean => {
        if (NOISE_TAGS.includes(el.tagName)) return true;
        const role = el.getAttribute('role') || '';
        if (NOISE_ROLE_RE.test(role)) return true;
        const cls = el.getAttribute('class') || '';
        if (NOISE_CLASS_RE.test(cls)) return true;
        const id = el.id || '';
        if (NOISE_CLASS_RE.test(id)) return true;
        const aria = el.getAttribute('aria-label') || '';
        if (NOISE_ROLE_RE.test(aria)) return true;
        return false;
      };

      const stripNoise = (root: Element) => {
        const all = Array.from(root.querySelectorAll('*'));
        for (const el of all) if (isNoise(el)) el.remove();
      };

      // ---- score a candidate as "article-likely" --------------------------
      const scoreEl = (el: Element): number => {
        const text = (el.textContent || '').trim();
        if (text.length < 80) return 0;
        const paras = el.querySelectorAll('p').length;
        const heads = el.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
        const codes = el.querySelectorAll('pre,code').length;
        const lists = el.querySelectorAll('ul,ol').length;
        const links = el.querySelectorAll('a').length;
        const linkDensity = links / Math.max(1, text.length / 100);
        return (
          text.length * 0.1 +
          paras * 30 +
          heads * 20 +
          codes * 25 +
          lists * 10 -
          linkDensity * 50
        );
      };

      // ---- pick root -------------------------------------------------------
      const looksLoading = (el: Element): boolean => {
        const t = (el.textContent || '').trim();
        if (t.length < 200 && /loading|加载中/i.test(t)) return true;
        return false;
      };
      const pickContent = (): Element | null => {
        // explicit selectors first
        for (const sel of contentSelectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          if (looksLoading(el)) continue;
          if ((el.textContent || '').trim().length > 120) return el;
        }
        // else: scan all candidates, score, pick best
        const candidates = Array.from(document.querySelectorAll(
          'article, main, section, [role=main], .markdown, .markdown-body, .content, .prose, [class*="article" i], [class*="content" i]',
        ));
        let best: Element | null = null;
        let bestScore = 0;
        for (const el of candidates) {
          if (isNoise(el) || looksLoading(el)) continue;
          const s = scoreEl(el);
          if (s > bestScore) { bestScore = s; best = el; }
        }
        return best || document.body;
      };

      const root = pickContent()!;
      const clone = root.cloneNode(true) as HTMLElement;
      stripNoise(clone);

      // drop empty wrappers (purely whitespace)
      clone.querySelectorAll('div,span').forEach(el => {
        if (!el.textContent?.trim() && el.children.length === 0) el.remove();
      });

      // ---- collect links ---------------------------------------------------
      const urlSet = new Set<string>();
      const addFrom = (scope: ParentNode, sel: string) => {
        scope.querySelectorAll<HTMLAnchorElement>(sel).forEach(a => {
          const href = a.getAttribute('href');
          if (!href) return;
          try {
            const abs = new URL(href, location.href).toString();
            if (abs.startsWith('http')) urlSet.add(abs);
          } catch { /* ignore */ }
        });
      };
      for (const s of navSelectors) addFrom(document, s);
      addFrom(root, 'a');

      // ---- title: prefer H1 inside content, fall back to document.title ----
      const h1El = root.querySelector('h1') || document.querySelector('h1');
      const h1Text = h1El ? (h1El.textContent || '').trim() : '';
      const docTitle = (document.title || '').replace(/\s+\|\s+.*$/, '').trim();
      const title = h1Text || docTitle;

      // ---- nav section: find which sidebar group this page belongs to ------
      let navSection = '';
      try {
        const curPath = location.pathname.replace(/\.html?$/, '').replace(/\/$/, '');
        const navAreas = document.querySelectorAll('nav, aside, [role=navigation]');
        for (const nav of navAreas) {
          const links = nav.querySelectorAll('a');
          let activeLink: Element | null = null;
          for (const a of links) {
            if (a.classList.contains('active') || a.classList.contains('selected') ||
                a.classList.contains('current') || a.getAttribute('aria-current') === 'page') {
              activeLink = a;
              break;
            }
          }
          if (!activeLink) {
            for (const a of links) {
              const href = (a.getAttribute('href') || '').replace(/\.html?$/, '').replace(/\/$/, '');
              try {
                const resolved = new URL(href, location.href).pathname.replace(/\.html?$/, '').replace(/\/$/, '');
                if (resolved === curPath) { activeLink = a; break; }
              } catch { /* ignore */ }
            }
          }
          if (!activeLink) continue;

          // Walk up from activeLink to find the section heading
          let el: Element | null = activeLink;
          while (el && el !== nav) {
            el = el.parentElement;
            if (!el) break;
            // Pattern 1: <details><summary>Section</summary>...<a>active</a>...</details>
            if (el.tagName === 'DETAILS') {
              const sum = el.querySelector(':scope > summary');
              if (sum) { navSection = (sum.textContent || '').trim(); break; }
            }
            // Pattern 2: <li class="expanded/open"><span/a>Section</span><ul>...<a>active</a>...</ul></li>
            if (el.tagName === 'LI') {
              const firstChild = el.querySelector(':scope > span, :scope > a, :scope > div > span, :scope > div > a');
              const sub = el.querySelector(':scope > ul, :scope > ol, :scope > div > ul');
              if (firstChild && sub && sub.contains(activeLink)) {
                const txt = (firstChild.textContent || '').trim();
                if (txt && txt !== (activeLink.textContent || '').trim()) {
                  navSection = txt; break;
                }
              }
            }
            // Pattern 3: sibling heading before a list — <h3>Section</h3><ul>...<a>active</a>...</ul>
            if ((el.tagName === 'UL' || el.tagName === 'OL') && el.previousElementSibling) {
              const prev = el.previousElementSibling;
              if (/^H[1-6]$/.test(prev.tagName) || prev.classList.contains('heading') ||
                  prev.classList.contains('title') || prev.getAttribute('role') === 'heading') {
                navSection = (prev.textContent || '').trim(); break;
              }
            }
            // Pattern 4: parent div/section with a heading child that is not the link itself
            if (el.tagName === 'DIV' || el.tagName === 'SECTION') {
              const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .heading, :scope > [role=heading]');
              const list = el.querySelector(':scope > ul, :scope > ol, :scope > nav, :scope > div > ul');
              if (heading && list && list.contains(activeLink)) {
                const txt = (heading.textContent || '').trim();
                if (txt) { navSection = txt; break; }
              }
            }
          }
          if (navSection) break;
        }
      } catch { /* ignore */ }

      return {
        title,
        html: clone.outerHTML,
        links: Array.from(urlSet),
        strategy: 'selector' as const,
        navSection: navSection || undefined,
      };
    },
    { contentSelectors, navSelectors },
  );
}

export async function extractSidebarLinks(
  page: Page,
  navSelectors: string[],
): Promise<string[]> {
  return page.evaluate((navSels) => {
    const curPath = location.pathname.replace(/\.html?$/, '').replace(/\/$/, '');
    const candidates: Array<{ urls: string[]; score: number }> = [];

    const navAreas = document.querySelectorAll('nav, aside, [role=navigation]');
    for (const nav of navAreas) {
      const cls = (nav.className || '').toLowerCase();

      // Skip top navbar
      if (cls.includes('navbar')) continue;

      const links = nav.querySelectorAll('a');
      if (links.length === 0) continue;

      // Skip "In This Article" — most links are anchor links to the same page
      const anchorCount = Array.from(links).filter(a =>
        (a.getAttribute('href') || '').includes('#')
      ).length;
      if (anchorCount > links.length * 0.6) continue;

      // Find active link
      let activeLink: HTMLAnchorElement | null = null;
      for (const a of links) {
        if (a.classList.contains('active') || a.classList.contains('selected') ||
            a.classList.contains('current') || a.getAttribute('aria-current') === 'page') {
          activeLink = a;
          break;
        }
      }
      if (!activeLink) {
        for (const a of links) {
          const href = (a.getAttribute('href') || '').replace(/\.html?$/, '').replace(/\/$/, '');
          try {
            const resolved = new URL(href, location.href).pathname.replace(/\.html?$/, '').replace(/\/$/, '');
            if (resolved === curPath) { activeLink = a; break; }
          } catch { /* ignore */ }
        }
      }
      if (!activeLink) continue;

      // Walk up from active link to find the enclosing list
      let container: Element | null = activeLink;
      while (container && container !== nav) {
        container = container.parentElement;
        if (!container) break;
        if (container.tagName === 'UL' || container.tagName === 'OL') break;
      }
      if (!container || container === nav) container = nav;

      // Collect page links (skip anchors)
      const urls: string[] = [];
      container.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        try {
          const abs = new URL(href, location.href);
          if (abs.origin === location.origin) urls.push(abs.toString());
        } catch { /* ignore */ }
      });

      if (urls.length === 0) continue;

      // Score: prefer sidebar-like class names, penalize large link counts (top nav)
      let score = 0;
      if (cls.includes('sidebar') || cls.includes('sidetoc') || cls.includes('toc') || cls.includes('side-nav'))
        score += 100;
      if (nav.tagName === 'ASIDE') score += 50;
      if (urls.length <= 20) score += 30;
      if (urls.length > 50) score -= 50;

      candidates.push({ urls, score });
    }

    // Pick the highest-scoring nav area
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].urls;
    }

    // Fallback: explicit navSelectors
    const fallback: string[] = [];
    for (const sel of navSels) {
      document.querySelectorAll<HTMLAnchorElement>(sel).forEach(a => {
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        try {
          const abs = new URL(href, location.href);
          if (abs.origin === location.origin) fallback.push(abs.toString());
        } catch { /* ignore */ }
      });
    }
    return fallback;
  }, navSelectors);
}
