import TurndownService from 'turndown';
// @ts-ignore - no types shipped
import { gfm } from 'turndown-plugin-gfm';

export function createConverter(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  });
  td.use(gfm);

  // Keep <details>/<summary> verbatim
  td.keep(['details', 'summary']);

  // Strip script/style/noscript entirely
  td.remove(['script', 'style', 'noscript', 'iframe']);

  // Preserve code block languages from class="language-xxx"
  td.addRule('fencedCodeWithLang', {
    filter: (node) =>
      node.nodeName === 'PRE' && !!node.firstChild && node.firstChild.nodeName === 'CODE',
    replacement: (_content, node) => {
      const code = (node as HTMLElement).querySelector('code');
      const text = code?.textContent ?? '';
      const cls = code?.getAttribute('class') ?? '';
      const m = cls.match(/language-([\w+-]+)/);
      const lang = m ? m[1] : '';
      return `\n\n\`\`\`${lang}\n${text.replace(/\n$/, '')}\n\`\`\`\n\n`;
    },
  });

  return td;
}

export function htmlToMarkdown(td: TurndownService, html: string): string {
  return td.turndown(html).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
