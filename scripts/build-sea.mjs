import { build } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DIST = 'dist';
const BUNDLE = path.join(DIST, 'catchdocs.cjs');
const SEA_CONFIG = path.join(DIST, 'sea-config.json');
const SEA_BLOB = path.join(DIST, 'sea-prep.blob');
const OUT_EXE = path.join(DIST, 'CatchDocs.exe');

fs.mkdirSync(DIST, { recursive: true });

// Step 1: Bundle with esbuild
console.log('[1/4] Bundling with esbuild...');
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: BUNDLE,
  external: ['playwright', 'playwright-core'],
  define: {
    'import.meta.url': '__filename',
  },
  banner: {
    js: `
      const __importMetaUrl = require('url').pathToFileURL(__filename).href;
      const { createRequire: __createRequire } = require('module');
      const require = __createRequire(__importMetaUrl);
    `,
  },
});
console.log(`  -> ${BUNDLE}`);

// Step 2: Copy web/ and node_modules/playwright to dist/
console.log('[2/4] Copying assets...');
fs.cpSync('web', path.join(DIST, 'web'), { recursive: true });

// Copy vendor libs needed by web UI
const vendorDest = path.join(DIST, 'node_modules');
const copyVendor = (pkg, files) => {
  for (const f of files) {
    const src = path.join('node_modules', pkg, f);
    const dst = path.join(vendorDest, pkg, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(src)) fs.cpSync(src, dst);
  }
};
copyVendor('marked', ['lib/marked.umd.js']);
copyVendor('dompurify', ['dist/purify.min.js']);
copyVendor('@mozilla/readability', ['Readability.js', 'Readability-readerable.js']);

// Copy playwright (needed at runtime for browser automation)
console.log('  Copying playwright...');
fs.cpSync('node_modules/playwright', path.join(vendorDest, 'playwright'), {
  recursive: true,
  filter: (src) => !src.includes('.cache') && !src.includes('driver'),
});
fs.cpSync('node_modules/playwright-core', path.join(vendorDest, 'playwright-core'), {
  recursive: true,
  filter: (src) => !src.includes('.cache') && !src.includes('driver'),
});

// Copy config example
fs.copyFileSync('catchdocs.config.example.json', path.join(DIST, 'catchdocs.config.example.json'));

console.log('  -> dist/web/, dist/node_modules/');

// Step 3: Generate SEA blob
console.log('[3/4] Generating SEA blob...');
const seaConfig = {
  main: BUNDLE,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2));
execSync(`node --build-sea ${SEA_CONFIG}`, { stdio: 'inherit' });

// Step 4: Create executable
console.log('[4/4] Creating executable...');
const nodePath = process.execPath;
fs.copyFileSync(nodePath, OUT_EXE);

try {
  execSync(`npx postject "${OUT_EXE}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, {
    stdio: 'inherit',
  });
} catch {
  console.error('postject failed — install it with: npm install -D postject');
  process.exit(1);
}

const sizeMB = (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1);
console.log(`\nDone! ${OUT_EXE} (${sizeMB} MB)`);
console.log('Distribute the entire dist/ folder:');
console.log('  dist/CatchDocs.exe');
console.log('  dist/web/');
console.log('  dist/node_modules/ (playwright + vendor libs)');
console.log('  dist/catchdocs.config.example.json');
