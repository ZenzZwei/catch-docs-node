export type CrawlScope = 'single' | 'sidebar' | 'custom';

export interface CatchDocsConfig {
  startUrls: string[];
  output: string;
  profileDir: string;
  browserChannel: 'msedge' | 'chrome' | 'chromium';
  headless: boolean;
  concurrency: number;
  requestDelayMs: number;
  maxPages: number;
  maxDepth: number;
  sameOriginOnly: boolean;
  /** 抓取范围：single=仅当前页；sidebar=起始URL所在目录及其子页；custom=使用 includePatterns */
  scope: CrawlScope;
  includePatterns: string[];
  excludePatterns: string[];
  contentSelectors: string[];
  navSelectors: string[];
  waitForSelector: string | null;
  downloadAssets: boolean;
  /** 从 /sitemap.xml 发现额外链接 */
  useSitemap: boolean;
  /** 遵守 /robots.txt 的 Disallow 规则 */
  respectRobots: boolean;
}

export interface PageRecord {
  url: string;
  path: string;           // relative md path in output
  title: string;
  hash: string;           // sha256 of markdown body
  fetchedAt: string;      // ISO
  depth: number;
  navSection?: string;    // sidebar/nav group this page belongs to
}

export interface Manifest {
  version: 1;
  updatedAt: string;
  pages: Record<string, PageRecord>; // keyed by normalized url
}
