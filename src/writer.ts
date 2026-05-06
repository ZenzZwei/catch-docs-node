import fs from 'node:fs/promises';
import path from 'node:path';
import type { PageRecord } from './types.js';

export interface WriteInput {
  url: string;
  title: string;
  markdown: string;
  relPath: string;       // relative to outputRoot
  outputRoot: string;
  depth: number;
  breadcrumbs: string[];
  navSection?: string;
}

export async function writeMarkdown(input: WriteInput): Promise<string> {
  const abs = path.join(input.outputRoot, 'docs', input.relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const lines = [
    '---',
    `title: ${yaml(input.title)}`,
  ];
  if (input.navSection) {
    lines.push(`nav_section: ${yaml(input.navSection)}`);
  }
  lines.push(
    `source_url: ${input.url}`,
    `path: ${input.relPath.replace(/\\/g, '/')}`,
    `breadcrumbs: [${input.breadcrumbs.map(yaml).join(', ')}]`,
    `fetched_at: ${new Date().toISOString()}`,
    '---',
    '',
    '',
  );

  await fs.writeFile(abs, lines.join('\n') + input.markdown, 'utf-8');
  return abs;
}

function yaml(s: string): string {
  // simple single-line yaml string
  const safe = (s || '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  return `"${safe}"`;
}

export async function writeSummary(
  outputRoot: string,
  records: PageRecord[],
): Promise<void> {
  const sorted = [...records].sort((a, b) => a.path.localeCompare(b.path));

  // Group by navSection
  const sectioned = new Map<string, PageRecord[]>();
  const unsectioned: PageRecord[] = [];
  for (const r of sorted) {
    if (r.navSection) {
      let list = sectioned.get(r.navSection);
      if (!list) { list = []; sectioned.set(r.navSection, list); }
      list.push(r);
    } else {
      unsectioned.push(r);
    }
  }

  const lines: string[] = ['# Summary', ''];

  for (const [section, pages] of sectioned) {
    lines.push(`## ${escapeMd(section)}`, '');
    for (const r of pages) {
      const link = r.path.replace(/\\/g, '/');
      lines.push(`- [${escapeMd(r.title || link)}](docs/${link})`);
    }
    lines.push('');
  }

  if (unsectioned.length) {
    if (sectioned.size > 0) lines.push('## Other', '');
    for (const r of unsectioned) {
      const link = r.path.replace(/\\/g, '/');
      lines.push(`- [${escapeMd(r.title || link)}](docs/${link})`);
    }
    lines.push('');
  }

  await fs.writeFile(path.join(outputRoot, 'SUMMARY.md'), lines.join('\n'), 'utf-8');
}

function escapeMd(s: string): string {
  return s.replace(/[\[\]]/g, '\\$&');
}
