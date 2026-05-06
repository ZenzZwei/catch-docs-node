import fs from 'node:fs/promises';
import path from 'node:path';
import type { CatchDocsConfig } from './types.js';

export const DEFAULTS: CatchDocsConfig = {
  startUrls: [],
  output: './output',
  profileDir: './.profile',
  browserChannel: 'msedge',
  headless: false,
  concurrency: 3,
  requestDelayMs: 500,
  maxPages: 500,
  maxDepth: 6,
  sameOriginOnly: true,
  scope: 'sidebar',
  includePatterns: [],
  excludePatterns: [],
  contentSelectors: ['main', 'article', '[role=main]', '.markdown-body'],
  navSelectors: ['nav a', 'aside a', '[role=navigation] a'],
  waitForSelector: null,
  downloadAssets: true,
  useSitemap: false,
  respectRobots: true,
};

export async function loadConfig(file: string): Promise<CatchDocsConfig> {
  const abs = path.resolve(file);
  const raw = await fs.readFile(abs, 'utf-8');
  const parsed = JSON.parse(raw);
  return { ...DEFAULTS, ...parsed };
}
