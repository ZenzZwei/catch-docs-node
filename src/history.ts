import fs from 'node:fs/promises';
import path from 'node:path';

export interface HistoryEntry {
  id: string;
  kind: 'crawl' | 'login';
  status: 'running' | 'done' | 'error' | 'cancelled';
  startUrls: string[];
  scope: string;
  output: string;
  startedAt: string;
  endedAt?: string;
  processed?: number;
  error?: string;
}

export class HistoryStore {
  private data: HistoryEntry[] = [];
  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      this.data = JSON.parse(raw);
    } catch { this.data = []; }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  async append(entry: HistoryEntry): Promise<void> {
    await this.load();
    this.data.unshift(entry);
    if (this.data.length > 100) this.data.length = 100;
    await this.save();
  }

  async update(id: string, patch: Partial<HistoryEntry>): Promise<void> {
    await this.load();
    const idx = this.data.findIndex(e => e.id === id);
    if (idx >= 0) {
      this.data[idx] = { ...this.data[idx], ...patch };
      await this.save();
    }
  }

  async list(): Promise<HistoryEntry[]> {
    await this.load();
    return this.data;
  }
}

export function newHistoryId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
