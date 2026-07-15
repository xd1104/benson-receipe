'use strict';

/*
 * Recipe Book — local Node server (zero external deps)
 * - Serves the PWA from ./public
 * - Stores recipes as markdown-with-frontmatter in ./data/recipes
 * - Stores images (base64 upload) in ./data/images
 * - Holds imported .txt files in ./data/imports for AI cleanup
 * - "AI organize" endpoint drives the local `claude` CLI
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const RECIPES_DIR = path.join(DATA_DIR, 'recipes');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const IMPORTS_DIR = path.join(DATA_DIR, 'imports');
const TAGS_FILE = path.join(DATA_DIR, 'tags.json');

const DEFAULT_TAGS = ['家常菜', '湯品', '麵食', '飯類', '甜點', '快速料理', '宴客菜'];

const PORT = process.env.PORT || 3517;

for (const d of [DATA_DIR, RECIPES_DIR, IMAGES_DIR, IMPORTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function slugify(str) {
  const base = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'recipe';
}

function safeName(name) {
  // keep only a basename, strip any path traversal
  return path.basename(String(name || '')).replace(/[^\w.\-一-鿿]+/g, '_');
}

// Atomic write: write to a private temp file, then rename over the target.
// rename() on the same volume is atomic, so a crash mid-write never leaves a
// half-written target file. On failure we clean up our own temp file.
async function atomicWrite(file, data, encoding) {
  const tmp = file + '.tmp~' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    if (encoding) await fsp.writeFile(tmp, data, encoding);
    else await fsp.writeFile(tmp, data); // Buffer path
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* auto-sync to GitHub (debounced git add/commit/push)                 */
/* ------------------------------------------------------------------ */
const AUTO_SYNC = process.env.AUTO_SYNC !== '0';
let syncEnabled = false; // set true at startup if an origin remote exists
let syncBranch = 'main';
let syncTimer = null;
let syncing = false;
let syncPending = false;

function gitCmd(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(((stderr || stdout || err.message) + '').slice(0, 400)));
      else resolve((stdout || '') + '');
    });
  });
}

function scheduleSync() {
  if (!AUTO_SYNC || !syncEnabled) return;
  syncPending = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 2500); // debounce bursts of saves
}

// Pull remote before pushing so a phone's changes are merged in and the push
// stays fast-forwardable. Same-file conflicts (rare — recipes are per-file)
// auto-resolve in favour of the local PC copy (the declared "true copy"),
// and are logged. Different-file changes always merge cleanly.
async function pullRemote(tag) {
  try {
    await gitCmd(['pull', '--no-edit', '--no-rebase', '-X', 'ours', 'origin', syncBranch]);
    console.log('[sync] ' + tag + ' pull ok');
  } catch (e) {
    console.error('[sync] ' + tag + ' pull failed (continuing):', e.message);
  }
}

async function runSync() {
  if (syncing) return; // a run is in progress; syncPending will re-trigger
  syncing = true;
  syncPending = false;
  try {
    await gitCmd(['add', '-A']);
    const status = await gitCmd(['status', '--porcelain']);
    if (status.trim()) {
      await gitCmd(['commit', '-m', 'auto: sync recipe data ' + new Date().toISOString()]);
    }
    await pullRemote('pre-push'); // merge phone changes before pushing
    await gitCmd(['push', 'origin', 'HEAD']);
    console.log('[sync] pushed to GitHub');
  } catch (e) {
    // Never let sync failures affect the user's save; just log.
    console.error('[sync] failed:', e.message);
  } finally {
    syncing = false;
    if (syncPending) scheduleSync();
  }
}

async function initSync() {
  if (!AUTO_SYNC) { console.log('[sync] disabled (AUTO_SYNC=0)'); return; }
  try {
    const url = (await gitCmd(['remote', 'get-url', 'origin'])).trim();
    if (!url) throw new Error('no origin');
    try { syncBranch = (await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main'; } catch { syncBranch = 'main'; }
    syncEnabled = true;
    console.log('[sync] enabled -> ' + url + ' (' + syncBranch + ')');
    // On startup, pull once so the PC picks up recipes added from a phone.
    await pullRemote('startup');
  } catch {
    console.log('[sync] no git remote "origin"; auto-push disabled');
  }
}

/* ------------------------------------------------------------------ */
/* recipe (markdown + frontmatter) serialization                       */
/* ------------------------------------------------------------------ */

function toFrontmatterValue(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => JSON.stringify(String(x))).join(', ') + ']';
  return JSON.stringify(String(v == null ? '' : v));
}

function recipeToMarkdown(r) {
  const fm = [];
  fm.push('---');
  fm.push('title: ' + toFrontmatterValue(r.title || ''));
  fm.push('tags: ' + toFrontmatterValue(r.tags || []));
  fm.push('createdAt: ' + toFrontmatterValue(r.createdAt || new Date().toISOString()));
  fm.push('updatedAt: ' + toFrontmatterValue(new Date().toISOString()));
  fm.push('image: ' + toFrontmatterValue(r.image || ''));
  fm.push('---');
  fm.push('');
  fm.push('# ' + (r.title || '未命名食譜'));
  fm.push('');
  fm.push('## 食材');
  fm.push('');
  for (const ing of r.ingredients || []) fm.push('- ' + ing);
  fm.push('');
  fm.push('## 步驟');
  fm.push('');
  (r.steps || []).forEach((s, i) => {
    const text = typeof s === 'string' ? s : s && s.text ? s.text : '';
    const img = typeof s === 'string' ? '' : s && s.image ? s.image : '';
    fm.push(`${i + 1}. ${text}`);
    if (img) fm.push(`   ![step](images/${img})`);
  });
  fm.push('');
  if (r.notes && String(r.notes).trim()) {
    fm.push('## 備註');
    fm.push('');
    fm.push(String(r.notes).trim());
    fm.push('');
  }
  return fm.join('\n');
}

function parseFrontmatterLine(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  let raw = line.slice(idx + 1).trim();
  let value;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  } else {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.replace(/^["']|["']$/g, '');
    }
  }
  return [key, value];
}

function markdownToRecipe(id, text) {
  const r = { id, title: '', tags: [], createdAt: '', updatedAt: '', image: '', ingredients: [], steps: [], notes: '' };
  let body = text;
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const parsed = parseFrontmatterLine(line);
      if (!parsed) continue;
      const [k, v] = parsed;
      if (k in r) r[k] = v;
    }
    body = text.slice(fmMatch[0].length);
  }
  // parse sections
  const lines = body.split('\n');
  let section = null;
  const notesBuf = [];
  for (const line of lines) {
    const h = /^##\s+(.+)$/.exec(line.trim());
    if (h) {
      const name = h[1].trim();
      if (name === '食材') section = 'ing';
      else if (name === '步驟') section = 'steps';
      else if (name === '備註') section = 'notes';
      else section = null;
      continue;
    }
    if (section === 'ing') {
      const m = /^\s*-\s+(.*)$/.exec(line);
      if (m && m[1].trim()) r.ingredients.push(m[1].trim());
    } else if (section === 'steps') {
      const imgRe = /!\[[^\]]*\]\(\s*(?:\.?\/)?images\/([^)\s]+)\s*\)/;
      const sm = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (sm) {
        let t = sm[1].trim();
        let img = '';
        const inl = imgRe.exec(t);
        if (inl) { img = decodeURIComponent(inl[1]); t = t.replace(inl[0], '').trim(); }
        if (t || img) r.steps.push({ text: t, image: img });
      } else {
        const im = imgRe.exec(line);
        if (im && r.steps.length) r.steps[r.steps.length - 1].image = decodeURIComponent(im[1]);
      }
    } else if (section === 'notes') {
      notesBuf.push(line);
    }
  }
  r.notes = notesBuf.join('\n').trim();
  return r;
}

async function listRecipes() {
  const files = (await fsp.readdir(RECIPES_DIR)).filter((f) => f.endsWith('.md'));
  const out = [];
  for (const f of files) {
    try {
      const text = await fsp.readFile(path.join(RECIPES_DIR, f), 'utf8');
      out.push(markdownToRecipe(f.replace(/\.md$/, ''), text));
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

/* ------------------------------------------------------------------ */
/* tags storage + cascade                                              */
/* ------------------------------------------------------------------ */

async function readTags() {
  try {
    const raw = await fsp.readFile(TAGS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map((x) => String(x)).filter(Boolean);
  } catch {
    /* missing or bad -> seed */
  }
  await writeTags(DEFAULT_TAGS);
  return DEFAULT_TAGS.slice();
}

async function writeTags(list) {
  const clean = [];
  for (const t of list) {
    const s = String(t).trim();
    if (s && !clean.includes(s)) clean.push(s);
  }
  await atomicWrite(TAGS_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

// apply a transform to every recipe's tags array and rewrite changed files
async function updateRecipesTags(transform) {
  const files = (await fsp.readdir(RECIPES_DIR)).filter((f) => f.endsWith('.md'));
  let changed = 0;
  for (const f of files) {
    const id = f.replace(/\.md$/, '');
    let recipe;
    try {
      recipe = markdownToRecipe(id, await fsp.readFile(path.join(RECIPES_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    const before = JSON.stringify(recipe.tags || []);
    const next = transform(recipe.tags || []);
    if (JSON.stringify(next) !== before) {
      recipe.tags = next;
      // preserve createdAt already in recipe object
      await atomicWrite(path.join(RECIPES_DIR, f), recipeToMarkdown(recipe), 'utf8');
      changed++;
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* claude CLI resolver + AI organize                                   */
/* ------------------------------------------------------------------ */

let CLAUDE_EXE_CACHE = null;
function resolveClaudeExe() {
  if (CLAUDE_EXE_CACHE) return CLAUDE_EXE_CACHE;
  const candidates = [];
  // 1) explicit override
  if (process.env.CLAUDE_EXE) candidates.push(process.env.CLAUDE_EXE);
  // 2) derive from npm prefix
  try {
    const prefix = execFileSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', shell: true }).trim();
    if (prefix) {
      candidates.push(path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    }
  } catch {
    /* ignore */
  }
  // 3) parse `where claude` output (the .cmd points at the real exe dir)
  try {
    const out = execFileSync('where', ['claude'], { encoding: 'utf8', shell: true });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      const dir = path.dirname(p);
      candidates.push(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    }
  } catch {
    /* ignore */
  }
  // 4) common default
  candidates.push(
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  );

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        CLAUDE_EXE_CACHE = c.replace(/\\/g, '/'); // forward slashes, bypass cmd.exe
        return CLAUDE_EXE_CACHE;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function buildOrganizePrompt(rawText) {
  return [
    '你是一個食譜整理助手。以下是一段雜亂的食譜文字，請把它整理成一份結構化食譜。',
    '只輸出一個 JSON 物件，不要有任何其他文字、不要用 markdown code fence 包起來。',
    'JSON schema 如下：',
    '{"title": "菜名字串", "tags": ["標籤"], "ingredients": ["食材一份量", "..."], "steps": ["步驟一", "..."], "notes": "補充說明或空字串"}',
    'ingredients 每一項請包含份量（若原文有）。steps 每一項是一個動作步驟，不要加編號前綴。',
    '請用繁體中文。以下是原始文字：',
    '"""',
    rawText,
    '"""',
  ].join('\n');
}

function runClaudeOrganize(rawText) {
  return new Promise((resolve) => {
    const exe = resolveClaudeExe();
    if (!exe) {
      resolve({ ok: false, code: 'no_cli', message: '找不到 claude CLI 執行檔（claude.exe）。請確認已安裝 Claude Code。' });
      return;
    }
    const prompt = buildOrganizePrompt(rawText);
    const args = ['-p', prompt, '--output-format', 'json'];
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(exe, args, { shell: false, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: 'spawn_error', message: 'CLI 啟動失敗：' + e.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, code: 'timeout', message: 'AI 整理逾時（120 秒）。' });
    }, 120000);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'spawn_error', message: 'CLI 執行錯誤：' + e.message });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const combined = (stdout + '\n' + stderr);
      if (/not logged in|please run.*login|invalid api key/i.test(combined)) {
        resolve({
          ok: false,
          code: 'not_logged_in',
          message: 'AI 目前未登入。請在一般 PowerShell 執行一次 `claude` 完成登入後再試。',
        });
        return;
      }
      if (exitCode !== 0) {
        resolve({
          ok: false,
          code: 'nonzero_exit',
          message: 'AI CLI 以非零狀態結束（' + exitCode + '）。訊息：' + (stderr || stdout).slice(0, 500),
        });
        return;
      }
      // parse the outer CLI JSON envelope, then the .result payload
      let resultText = stdout.trim();
      try {
        const env = JSON.parse(stdout);
        if (env && typeof env.result === 'string') resultText = env.result.trim();
        else if (env && env.result) resultText = JSON.stringify(env.result);
      } catch {
        /* stdout wasn't the envelope; use raw */
      }
      const recipe = extractRecipeJson(resultText);
      if (!recipe) {
        resolve({
          ok: false,
          code: 'parse_error',
          message: 'AI 有回覆但無法解析成食譜結構。',
          raw: resultText.slice(0, 1000),
        });
        return;
      }
      resolve({ ok: true, recipe });
    });
  });
}

function extractRecipeJson(text) {
  if (!text) return null;
  let t = text.trim();
  // strip code fences if present
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  // find first { ... last }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const jsonStr = t.slice(first, last + 1);
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  return {
    title: String(obj.title || '').trim(),
    tags: Array.isArray(obj.tags) ? obj.tags.map((x) => String(x)) : [],
    ingredients: Array.isArray(obj.ingredients) ? obj.ingredients.map((x) => String(x)) : [],
    steps: Array.isArray(obj.steps) ? obj.steps.map((x) => String(x)) : [],
    notes: String(obj.notes || '').trim(),
  };
}

/* ------------------------------------------------------------------ */
/* route handlers                                                      */
/* ------------------------------------------------------------------ */

async function saveImageDataUrl(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return '';
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
  const buf = Buffer.from(m[3], 'base64');
  const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  await atomicWrite(path.join(IMAGES_DIR, name), buf);
  return name;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // GET /api/recipes
  if (p === '/api/recipes' && method === 'GET') {
    return sendJson(res, 200, { recipes: await listRecipes() });
  }

  // POST /api/recipes  (create or update)
  if (p === '/api/recipes' && method === 'POST') {
    const body = await readJson(req);
    const now = new Date().toISOString();
    let id = body.id ? safeName(body.id) : '';
    let image = body.image || '';
    if (body.imageDataUrl) {
      const saved = await saveImageDataUrl(body.imageDataUrl);
      if (saved) image = saved;
    }
    let createdAt = now;
    if (id) {
      // preserve original createdAt on update
      try {
        const existing = markdownToRecipe(id, await fsp.readFile(path.join(RECIPES_DIR, id + '.md'), 'utf8'));
        createdAt = existing.createdAt || now;
      } catch {
        /* new file with provided id */
      }
    } else {
      id = Date.now().toString(36) + '-' + slugify(body.title);
    }
    // steps may be strings (legacy / AI) or objects {text, image?, imageDataUrl?}
    const steps = [];
    for (const s of Array.isArray(body.steps) ? body.steps : []) {
      const text = (typeof s === 'string' ? s : s && s.text ? s.text : '').trim();
      let stepImg = typeof s === 'string' ? '' : s && s.image ? s.image : '';
      if (s && typeof s === 'object' && s.imageDataUrl) {
        const saved = await saveImageDataUrl(s.imageDataUrl);
        if (saved) stepImg = saved;
      }
      if (text || stepImg) steps.push({ text, image: stepImg });
    }
    const recipe = {
      id,
      title: body.title || '未命名食譜',
      tags: Array.isArray(body.tags) ? body.tags : [],
      ingredients: Array.isArray(body.ingredients) ? body.ingredients.filter((x) => String(x).trim()) : [],
      steps,
      notes: body.notes || '',
      image,
      createdAt,
    };
    await atomicWrite(path.join(RECIPES_DIR, id + '.md'), recipeToMarkdown(recipe), 'utf8');
    scheduleSync();
    return sendJson(res, 200, { ok: true, recipe: markdownToRecipe(id, await fsp.readFile(path.join(RECIPES_DIR, id + '.md'), 'utf8')) });
  }

  // GET /api/recipes/:id  and DELETE
  const single = /^\/api\/recipes\/([^/]+)$/.exec(p);
  if (single) {
    const id = safeName(decodeURIComponent(single[1]));
    const file = path.join(RECIPES_DIR, id + '.md');
    if (method === 'GET') {
      try {
        const text = await fsp.readFile(file, 'utf8');
        return sendJson(res, 200, { recipe: markdownToRecipe(id, text) });
      } catch {
        return sendJson(res, 404, { error: 'not found' });
      }
    }
    if (method === 'DELETE') {
      try {
        await fsp.unlink(file);
      } catch {
        /* already gone */
      }
      scheduleSync();
      return sendJson(res, 200, { ok: true });
    }
  }

  // GET /api/tags
  if (p === '/api/tags' && method === 'GET') {
    return sendJson(res, 200, { tags: await readTags() });
  }

  // POST /api/tags  { name }  -> add a tag option
  if (p === '/api/tags' && method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, message: '標籤名稱不可為空。' });
    const tags = await readTags();
    if (tags.includes(name)) return sendJson(res, 200, { ok: true, tags, note: 'exists' });
    tags.push(name);
    const saved = await writeTags(tags);
    scheduleSync();
    return sendJson(res, 200, { ok: true, tags: saved });
  }

  // PUT /api/tags  { from, to }  -> rename option + cascade to recipes
  if (p === '/api/tags' && method === 'PUT') {
    const body = await readJson(req);
    const from = String(body.from || '').trim();
    const to = String(body.to || '').trim();
    if (!from || !to) return sendJson(res, 400, { ok: false, message: '缺少原名稱或新名稱。' });
    let tags = await readTags();
    if (!tags.includes(from)) return sendJson(res, 404, { ok: false, message: '找不到該標籤。' });
    tags = tags.map((t) => (t === from ? to : t));
    const saved = await writeTags(tags); // writeTags dedupes if `to` already existed
    const changed = await updateRecipesTags((rt) => {
      const mapped = rt.map((t) => (t === from ? to : t));
      const uniq = [];
      for (const t of mapped) if (!uniq.includes(t)) uniq.push(t);
      return uniq;
    });
    scheduleSync();
    return sendJson(res, 200, { ok: true, tags: saved, recipesUpdated: changed });
  }

  // DELETE /api/tags/:name  -> remove option + strip from all recipes
  const tagSingle = /^\/api\/tags\/([^/]+)$/.exec(p);
  if (tagSingle && method === 'DELETE') {
    const name = decodeURIComponent(tagSingle[1]).trim();
    let tags = await readTags();
    tags = tags.filter((t) => t !== name);
    const saved = await writeTags(tags);
    const changed = await updateRecipesTags((rt) => rt.filter((t) => t !== name));
    scheduleSync();
    return sendJson(res, 200, { ok: true, tags: saved, recipesUpdated: changed });
  }

  // POST /api/import  { files: [{name, content}] }
  if (p === '/api/import' && method === 'POST') {
    const body = await readJson(req);
    const saved = [];
    for (const f of body.files || []) {
      const name = safeName(f.name || ('import-' + Date.now() + '.txt'));
      const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const stored = stamp + '__' + name;
      await atomicWrite(path.join(IMPORTS_DIR, stored), String(f.content || ''), 'utf8');
      saved.push({ id: stored, name, size: Buffer.byteLength(String(f.content || ''), 'utf8') });
    }
    return sendJson(res, 200, { ok: true, imported: saved });
  }

  // GET /api/imports
  if (p === '/api/imports' && method === 'GET') {
    const files = (await fsp.readdir(IMPORTS_DIR)).filter((f) => !f.startsWith('.') && !f.includes('.tmp~'));
    const out = [];
    for (const f of files) {
      const content = await fsp.readFile(path.join(IMPORTS_DIR, f), 'utf8');
      out.push({ id: f, name: f.split('__').slice(1).join('__') || f, preview: content.slice(0, 160), size: Buffer.byteLength(content, 'utf8') });
    }
    return sendJson(res, 200, { imports: out });
  }

  // DELETE /api/imports/:id
  const impSingle = /^\/api\/imports\/([^/]+)$/.exec(p);
  if (impSingle && method === 'DELETE') {
    const id = safeName(decodeURIComponent(impSingle[1]));
    try { await fsp.unlink(path.join(IMPORTS_DIR, id)); } catch {}
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/ai-organize  { text } or { importId }
  if (p === '/api/ai-organize' && method === 'POST') {
    const body = await readJson(req);
    let text = body.text || '';
    if (!text && body.importId) {
      try {
        text = await fsp.readFile(path.join(IMPORTS_DIR, safeName(body.importId)), 'utf8');
      } catch {
        return sendJson(res, 404, { ok: false, code: 'import_missing', message: '找不到該匯入檔。' });
      }
    }
    if (!text.trim()) return sendJson(res, 400, { ok: false, code: 'empty', message: '沒有可整理的文字。' });
    const result = await runClaudeOrganize(text);
    return sendJson(res, result.ok ? 200 : 200, result);
  }

  // GET /api/export  -> single JSON backup with every recipe + image (base64) + tags
  if (p === '/api/export' && method === 'GET') {
    const recipeFiles = (await fsp.readdir(RECIPES_DIR)).filter((f) => f.endsWith('.md'));
    const recipesOut = [];
    for (const f of recipeFiles) {
      recipesOut.push({ filename: f, content: await fsp.readFile(path.join(RECIPES_DIR, f), 'utf8') });
    }
    const imageFiles = (await fsp.readdir(IMAGES_DIR)).filter((f) => !f.startsWith('.') && !f.includes('.tmp~'));
    const imagesOut = [];
    for (const f of imageFiles) {
      const buf = await fsp.readFile(path.join(IMAGES_DIR, f));
      imagesOut.push({ filename: f, base64: buf.toString('base64') });
    }
    const backup = {
      app: 'recipe-book',
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      tags: await readTags(),
      recipes: recipesOut,
      images: imagesOut,
    };
    const body = JSON.stringify(backup);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="recipe-backup-' + stamp + '.json"',
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  // POST /api/restore  { backup }  -> write recipes + images + tags back (atomic, merge)
  if (p === '/api/restore' && method === 'POST') {
    const body = await readJson(req);
    const backup = body.backup || body;
    if (!backup || backup.app !== 'recipe-book' || !Array.isArray(backup.recipes)) {
      return sendJson(res, 400, { ok: false, message: '這不是有效的食譜備份檔。' });
    }
    let recipeCount = 0;
    let imageCount = 0;
    for (const img of backup.images || []) {
      const name = safeName(img.filename || '');
      if (!name || typeof img.base64 !== 'string') continue;
      await atomicWrite(path.join(IMAGES_DIR, name), Buffer.from(img.base64, 'base64'));
      imageCount++;
    }
    for (const rec of backup.recipes) {
      const name = safeName(rec.filename || '');
      if (!name.endsWith('.md') || typeof rec.content !== 'string') continue;
      await atomicWrite(path.join(RECIPES_DIR, name), rec.content, 'utf8');
      recipeCount++;
    }
    if (Array.isArray(backup.tags)) await writeTags(backup.tags);
    scheduleSync();
    return sendJson(res, 200, { ok: true, recipeCount, imageCount });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // images live under /data/images
  if (rel.startsWith('/images/')) {
    const file = path.join(IMAGES_DIR, safeName(rel.slice('/images/'.length)));
    return streamFile(res, file);
  }

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  return streamFile(res, file);
}

function streamFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!res.headersSent) {
      if (/payload too large/i.test(msg)) {
        sendJson(res, 413, { ok: false, code: 'too_large', message: '檔案太大，超過伺服器上限（圖片會自動壓縮，若仍過大請換小一點的圖）。' });
      } else if (e instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, code: 'bad_json', message: '請求格式錯誤。' });
      } else {
        sendJson(res, 500, { ok: false, code: 'server_error', message: '伺服器錯誤：' + msg });
      }
    } else res.end();
  }
});

server.listen(PORT, () => {
  const exe = resolveClaudeExe();
  console.log('Recipe Book server running at http://localhost:' + PORT);
  console.log('Data dir: ' + DATA_DIR);
  console.log('claude CLI: ' + (exe || 'NOT FOUND (AI organize will report this)'));
  initSync();
});
