import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runCrawl, runLogin, type Logger } from './crawler.js';
import type { CatchDocsConfig } from './types.js';
import { HistoryStore, newHistoryId, type HistoryEntry } from './history.js';
import { DEFAULTS } from './config.js';

import { existsSync } from 'node:fs';

let IS_SEA = false;
try { IS_SEA = !!(globalThis as any).process?.versions?.sea; } catch { /* not SEA */ }

const HERE = IS_SEA ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));

function resolveDir(name: string): string {
  const sameLevel = path.join(HERE, name);
  if (existsSync(sameLevel)) return sameLevel;
  return path.resolve(HERE, '..', name);
}

const WEB_DIR = resolveDir('web');
const NODE_MODULES = resolveDir('node_modules');
const CONFIG_FILE = path.resolve('catchdocs.config.json');
const HISTORY_FILE = path.resolve('.catchdocs', 'history.json');

interface Job {
  kind: 'crawl' | 'login';
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  logs: string[];
  abort: AbortController;
  subscribers: Set<http.ServerResponse>;
  result?: any;
  error?: string;
}

let currentJob: Job | null = null;

function broadcast(job: Job, line: string): void {
  job.logs.push(line);
  if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
  const msg = `data: ${JSON.stringify({ line })}\n\n`;
  for (const res of job.subscribers) {
    try { res.write(msg); } catch { /* client gone */ }
  }
}

function broadcastStatus(job: Job): void {
  const msg = `event: status\ndata: ${JSON.stringify({ status: job.status, result: job.result, error: job.error })}\n\n`;
  for (const res of job.subscribers) {
    try { res.write(msg); } catch { /* */ }
  }
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_SIZE) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function loadConfigFile(): Promise<CatchDocsConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // Remove null/undefined values so they don't override defaults
    for (const key of Object.keys(parsed)) {
      if (parsed[key] == null) delete parsed[key];
    }
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveConfigFile(cfg: CatchDocsConfig): Promise<void> {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ---- file tree helpers --------------------------------------------------
async function walk(dir: string, base = dir): Promise<any> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const items: any[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (e.isDirectory()) {
      items.push({ type: 'dir', name: e.name, path: rel, children: await walk(abs, base) });
    } else if (e.name.endsWith('.md')) {
      items.push({ type: 'file', name: e.name, path: rel });
    }
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return items;
}

// ---- routes -------------------------------------------------------------
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  // API
  if (p === '/api/config' && method === 'GET') {
    try { return sendJson(res, 200, await loadConfigFile()); }
    catch (e: any) { return sendJson(res, 404, { error: e.message }); }
  }
  if (p === '/api/config' && method === 'POST') {
    const body = await readJsonBody(req);
    await saveConfigFile(body);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/job' && method === 'GET') {
    return sendJson(res, 200, currentJob ? {
      kind: currentJob.kind,
      status: currentJob.status,
      startedAt: currentJob.startedAt,
      endedAt: currentJob.endedAt,
      logs: currentJob.logs.slice(-500),
      result: currentJob.result,
      error: currentJob.error,
    } : null);
  }
  if (p === '/api/job/stream' && method === 'GET') {
    if (!currentJob) return sendJson(res, 404, { error: 'no job' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    for (const line of currentJob.logs.slice(-500)) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
    res.write(`event: status\ndata: ${JSON.stringify({ status: currentJob.status })}\n\n`);
    currentJob.subscribers.add(res);
    req.on('close', () => { currentJob?.subscribers.delete(res); });
    return;
  }
  if (p === '/api/job/cancel' && method === 'POST') {
    if (!currentJob || currentJob.status !== 'running') return sendJson(res, 400, { error: 'no running job' });
    currentJob.abort.abort();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/crawl' && method === 'POST') {
    if (currentJob?.status === 'running') return sendJson(res, 409, { error: 'another job is running' });
    const cfg = await loadConfigFile();
    startJob('crawl', cfg, (log, signal) => runCrawl(cfg, { log, signal }));
    return sendJson(res, 202, { ok: true });
  }
  if (p === '/api/login' && method === 'POST') {
    if (currentJob?.status === 'running') return sendJson(res, 409, { error: 'another job is running' });
    const cfg = await loadConfigFile();
    startJob('login', cfg, async (log, signal) => { await runLogin(cfg, { log, signal }); });
    return sendJson(res, 202, { ok: true });
  }
  if (p === '/api/tree' && method === 'GET') {
    const cfg = await loadConfigFile().catch(() => ({ output: './output' } as any));
    const outDir = path.resolve(cfg.output || './output');
    return sendJson(res, 200, await walk(outDir).catch(() => []));
  }
  if (p === '/api/file' && method === 'GET') {
    const q = url.searchParams.get('path') || '';
    const cfg = await loadConfigFile().catch(() => ({ output: './output' } as any));
    const root = path.resolve(cfg.output || './output');
    const abs = path.resolve(root, q);
    if (!abs.toLowerCase().startsWith(root.toLowerCase())) return sendJson(res, 400, { error: 'path escape' });
    try {
      const content = await fs.readFile(abs, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    } catch (e: any) {
      return sendJson(res, 404, { error: e.message });
    }
  }

  // ---- history ----------------------------------------------------------
  if (p === '/api/history' && method === 'GET') {
    const hs = new HistoryStore(HISTORY_FILE);
    return sendJson(res, 200, await hs.list());
  }

  // ---- profiles ---------------------------------------------------------
  if (p === '/api/profiles' && method === 'GET') {
    const root = process.cwd();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const profiles = entries
      .filter(e => e.isDirectory() && /^\.profile(-.+)?$/.test(e.name))
      .map(e => ({ name: e.name.replace(/^\.profile-?/, '') || 'default', dir: './' + e.name }));
    return sendJson(res, 200, profiles);
  }
  if (p === '/api/profiles' && method === 'POST') {
    const body = await readJsonBody(req);
    const name = (body.name || '').trim().replace(/[^a-z0-9_-]/gi, '');
    const dir = name ? `./.profile-${name}` : './.profile';
    await fs.mkdir(path.resolve(dir), { recursive: true });
    // also set as active in config
    const cfg = await loadConfigFile().catch(() => null);
    if (cfg) { cfg.profileDir = dir; await saveConfigFile(cfg); }
    return sendJson(res, 200, { name: name || 'default', dir });
  }

  // ---- directory browser --------------------------------------------------
  if (p === '/api/browse' && method === 'GET') {
    const dir = url.searchParams.get('dir') || process.cwd();
    const abs = path.resolve(dir);
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const parent = path.dirname(abs);
      return sendJson(res, 200, { current: abs, parent: parent !== abs ? parent : null, dirs });
    } catch (e: any) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // ---- vendor libs -------------------------------------------------------
  if (p.startsWith('/vendor/marked')) {
    const src = path.join(NODE_MODULES, 'marked', 'lib', 'marked.umd.js');
    try {
      const data = await fs.readFile(src);
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'max-age=86400' });
      res.end(data);
      return;
    } catch { res.writeHead(404); res.end('marked not found'); return; }
  }
  if (p.startsWith('/vendor/purify')) {
    const src = path.join(NODE_MODULES, 'dompurify', 'dist', 'purify.min.js');
    try {
      const data = await fs.readFile(src);
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'max-age=86400' });
      res.end(data);
      return;
    } catch { res.writeHead(404); res.end('dompurify not found'); return; }
  }

  // static
  if (method === 'GET') {
    let file = p === '/' ? '/index.html' : p;
    const abs = path.resolve(WEB_DIR, '.' + file);
    if (!abs.toLowerCase().startsWith(WEB_DIR.toLowerCase())) { res.writeHead(400); res.end('bad path'); return; }
    try {
      const data = await fs.readFile(abs);
      const ct = file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.js') ? 'application/javascript'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
      return;
    } catch {
      res.writeHead(404); res.end('not found'); return;
    }
  }

  res.writeHead(405); res.end('method not allowed');
}

function startJob(
  kind: 'crawl' | 'login',
  cfg: CatchDocsConfig,
  runner: (log: Logger, signal: AbortSignal) => Promise<any>,
): void {
  const job: Job = {
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    logs: [],
    abort: new AbortController(),
    subscribers: new Set(),
  };
  currentJob = job;

  const historyId = newHistoryId();
  const hs = new HistoryStore(HISTORY_FILE);
  const historyEntry: HistoryEntry = {
    id: historyId,
    kind,
    status: 'running',
    startUrls: cfg.startUrls || [],
    scope: cfg.scope || 'custom',
    output: cfg.output || './output',
    startedAt: job.startedAt,
  };
  hs.append(historyEntry).catch(() => {});

  const log: Logger = (level, msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    broadcast(job, line);
    if (level === 'warn' || level === 'error') console.warn(line);
    else console.log(line);
  };

  runner(log, job.abort.signal)
    .then((r) => { job.status = job.abort.signal.aborted ? 'cancelled' : 'done'; job.result = r; })
    .catch((e) => { job.status = 'error'; job.error = e?.message ?? String(e); log('error', `[fatal] ${job.error}`); })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      hs.update(historyId, {
        status: job.status,
        endedAt: job.endedAt,
        processed: job.result?.processed,
        error: job.error,
      }).catch(() => {});
      broadcastStatus(job);
      for (const res of job.subscribers) { try { res.end(); } catch {} }
      job.subscribers.clear();
    });
}

function findPortProcess(port: number): { pid: string; name: string } | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' });
      const match = out.trim().split('\n')[0]?.match(/(\d+)\s*$/);
      if (!match) return null;
      const pid = match[1];
      const name = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' })
        .trim().split(',')[0]?.replace(/"/g, '') || 'unknown';
      return { pid, name };
    } else {
      const out = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf-8' }).trim();
      const pid = out.split('\n')[0];
      if (!pid) return null;
      const name = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf-8' }).trim() || 'unknown';
      return { pid, name };
    }
  } catch { return null; }
}

function killProcess(pid: string): boolean {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

export function startServer(port = 5174, openBrowser = true, appMode = true): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      try { sendJson(res, 500, { error: e?.message ?? 'internal' }); } catch {}
    });
  });

  server.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') { console.error(err); process.exit(1); }

    const proc = findPortProcess(port);
    console.error(`\n  Port ${port} is already in use.`);
    if (proc) {
      console.error(`  Process: ${proc.name} (PID ${proc.pid})`);
    }
    const ans = await askUser('\n  Kill the existing process and restart? (y/n) ');
    if (ans === 'y' || ans === 'yes') {
      if (proc && killProcess(proc.pid)) {
        console.log(`  Killed PID ${proc.pid}. Restarting...\n`);
        setTimeout(() => server.listen(port), 500);
      } else {
        console.error('  Failed to kill process. Try manually or use a different port: --port 5175');
        process.exit(1);
      }
    } else {
      console.log('  Aborted. Use --port <n> to specify a different port.');
      process.exit(0);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  CatchDocs UI  ${url}\n`);
    if (openBrowser) {
      if (appMode) openAppWindow(url);
      else openUrl(url);
    }
  });
  return server;
}

function openAppWindow(url: string): void {
  const chromePaths: Record<string, string[]> = {
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    linux: ['microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'],
  };

  const args = [`--app=${url}`, '--window-size=1200,800'];
  const candidates = chromePaths[process.platform] || chromePaths.linux;

  for (const browser of candidates) {
    try {
      spawn(browser, args, { detached: true, stdio: 'ignore' }).unref();
      return;
    } catch { continue; }
  }
  openUrl(url);
}

function openUrl(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* ignore */ }
}
