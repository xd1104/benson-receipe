'use strict';

/*
 * build.js — generate the GitHub Pages site (docs/) from the single frontend
 * source in public/. Run automatically by start.bat; also runnable via
 * `node build.js`. NEVER edit docs/ by hand — it is overwritten from public/.
 *
 * GitHub Pages "Deploy from branch" can only serve the repo root or /docs,
 * and it cannot serve public/. So we mirror public/ -> docs/. All frontend
 * paths are relative, so the same files work at localhost root AND under the
 * Pages sub-path https://<owner>.github.io/<repo>/.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(SRC, OUT, { recursive: true });

// .nojekyll: stop GitHub Pages' Jekyll from ignoring files it dislikes.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const count = fs.readdirSync(OUT).length;
console.log('[build] docs/ generated from public/ (' + count + ' top-level entries)');
