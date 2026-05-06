import fs from 'node:fs/promises';
import path from 'node:path';
import type { Manifest, PageRecord } from './types.js';
import { normalizeUrl } from './utils.js';

export class ManifestStore {
  private data: Manifest;
  constructor(private file: string) {
    this.data = { version: 1, updatedAt: new Date().toISOString(), pages: {} };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      this.data = JSON.parse(raw);
      if (!this.data.pages) this.data.pages = {};
    } catch {
      // first run
    }
  }

  get(url: string): PageRecord | undefined {
    return this.data.pages[normalizeUrl(url)];
  }

  set(rec: PageRecord): void {
    this.data.pages[normalizeUrl(rec.url)] = rec;
  }

  async save(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  allPages(): PageRecord[] {
    return Object.values(this.data.pages);
  }
}
