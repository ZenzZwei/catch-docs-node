#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runCrawl, runLogin } from './crawler.js';
import { startServer } from './server.js';

const program = new Command();
program
  .name('catchdocs')
  .description('Crawl login-protected wiki/docs sites into a Markdown tree for AI use.')
  .version('0.1.0');

program
  .command('init')
  .description('Create a default catchdocs.config.json in the current directory.')
  .action(async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = path.resolve(here, '..', 'catchdocs.config.example.json');
    const dst = path.resolve('catchdocs.config.json');
    try { await fs.access(dst); console.error('catchdocs.config.json already exists'); process.exit(1); } catch {}
    const raw = await fs.readFile(src, 'utf-8');
    await fs.writeFile(dst, raw, 'utf-8');
    console.log('Created catchdocs.config.json');
  });

program
  .command('login')
  .description('Open a browser to establish a persistent login session.')
  .option('-c, --config <file>', 'config file', 'catchdocs.config.json')
  .option('-u, --url <url>', 'URL to open for login')
  .action(async (opts) => {
    const cfg = await loadConfig(opts.config);
    if (opts.url) cfg.startUrls = [opts.url];
    await runLogin(cfg);
  });

program
  .command('crawl')
  .description('Crawl start URLs and export Markdown.')
  .option('-c, --config <file>', 'config file', 'catchdocs.config.json')
  .option('-u, --url <url...>', 'override startUrls')
  .option('-o, --output <dir>', 'override output dir')
  .option('--max-pages <n>', 'override maxPages', (v) => parseInt(v, 10))
  .option('--max-depth <n>', 'override maxDepth', (v) => parseInt(v, 10))
  .option('--headless', 'run headless')
  .action(async (opts) => {
    const cfg = await loadConfig(opts.config);
    if (opts.url?.length) cfg.startUrls = opts.url;
    if (opts.output) cfg.output = opts.output;
    if (Number.isFinite(opts.maxPages)) cfg.maxPages = opts.maxPages;
    if (Number.isFinite(opts.maxDepth)) cfg.maxDepth = opts.maxDepth;
    if (opts.headless) cfg.headless = true;
    await runCrawl(cfg);
  });

program
  .command('serve')
  .description('Start local Web UI for configuration, login and crawl.')
  .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 5174)
  .option('--no-open', 'do not open browser automatically')
  .option('--no-app-mode', 'open in regular browser tab instead of app window')
  .action((opts) => {
    startServer(opts.port, opts.open !== false, opts.appMode !== false);
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
