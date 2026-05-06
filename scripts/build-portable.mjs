import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const DIST = 'dist';
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// Step 1: Bundle to single JS file
console.log('[1/3] Bundling with esbuild...');
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(DIST, 'catchdocs.js'),
  external: ['playwright', 'playwright-core'],
  banner: {
    js: 'const __bundled_import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__bundled_import_meta_url',
  },
});

// Step 2: Write a CJS package.json so Node doesn't treat .js as ESM
fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify({ type: 'commonjs' }));

// Step 3: Copy assets
console.log('[2/3] Copying assets...');
fs.cpSync('web', path.join(DIST, 'web'), { recursive: true });
fs.copyFileSync('catchdocs.config.example.json', path.join(DIST, 'catchdocs.config.example.json'));

const vendorDest = path.join(DIST, 'node_modules');
fs.mkdirSync(vendorDest, { recursive: true });

const copyPkg = (pkg, files) => {
  for (const f of files) {
    const src = path.join('node_modules', pkg, f);
    const dst = path.join(vendorDest, pkg, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(src)) fs.cpSync(src, dst);
  }
};
copyPkg('marked', ['lib/marked.umd.js']);
copyPkg('dompurify', ['dist/purify.min.js']);
copyPkg('@mozilla/readability', ['Readability.js', 'Readability-readerable.js']);

// Launcher scripts
console.log('[3/3] Creating launchers...');
fs.writeFileSync(path.join(DIST, 'CatchDocs.bat'), [
  '@echo off',
  'title CatchDocs',
  '"%~dp0node\\node.exe" "%~dp0catchdocs.js" serve %*',
  'if errorlevel 1 (',
  '  echo.',
  '  echo [Error] CatchDocs failed to start. Make sure the node\\ folder is present.',
  '  pause',
  ')',
].join('\r\n') + '\r\n');

fs.writeFileSync(path.join(DIST, 'catchdocs.sh'), [
  '#!/usr/bin/env bash',
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'NODE="$DIR/node/bin/node"',
  '[ -x "$NODE" ] || NODE=node',
  'exec "$NODE" "$DIR/catchdocs.js" serve "$@"',
].join('\n') + '\n', { mode: 0o755 });

console.log('\nDone! Portable build in dist/');
console.log('Next: CI will add node/ binary and playwright/ to complete the package.');
