'use strict';

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    return { ok: false, status: 0, offline: true, data: { ok: false, code: 'offline', message: '連不到食譜伺服器（可能離線，或那台電腦沒開機）。' } };
  }
  const ct = res.headers.get('content-type') || '';
  let data;
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

// Downscale an image file to a data URL (JPEG). Longest edge ~maxEdge px.
function resizeImage(file, maxEdge = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      reject(new Error('unsupported'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // flatten transparency so JPEG isn't black
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(new Error('encode'));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function imgErrorMsg(err) {
  const k = err && err.message;
  if (k === 'unsupported') return '不支援的檔案格式，請選圖片檔（JPG/PNG 等）。';
  if (k === 'decode') return '圖片讀取失敗，可能檔案毀損。';
  if (k === 'read') return '無法讀取檔案。';
  return '圖片處理失敗，請換一張試試。';
}

/* ================================================================== */
/* DataStore — abstracts where recipe data comes from.                */
/*   LocalStore : the local Node /api (full read+write) on localhost. */
/*   GitHubStore: read-only, straight from the public GitHub repo, so */
/*                phones can browse via GitHub Pages with no key.      */
/*   Auto-selected by hostname; ?store=github forces GitHub for tests.*/
/* ================================================================== */
const GH = { owner: 'xd1104', repo: 'benson-receipe', branch: 'main' };
const IS_LOCAL = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
const FORCE_GH = /[?&]store=github\b/.test(location.search);

// Client-side mirror of the server's markdownToRecipe (used by GitHubStore).
function parseRecipeMarkdown(id, text) {
  const r = { id, title: '', tags: [], createdAt: '', updatedAt: '', image: '', ingredients: [], steps: [], notes: '' };
  text = String(text).replace(/\r\n/g, '\n'); // tolerate CRLF line endings
  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let raw = line.slice(idx + 1).trim();
      let val;
      if (raw.startsWith('[') && raw.endsWith(']')) {
        try { val = JSON.parse(raw); } catch { val = raw.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean); }
      } else {
        try { val = JSON.parse(raw); } catch { val = raw.replace(/^["']|["']$/g, ''); }
      }
      if (key in r) r[key] = val;
    }
    body = text.slice(fm[0].length);
  }
  let section = null;
  const notesBuf = [];
  const imgRe = /!\[[^\]]*\]\(\s*(?:\.?\/)?images\/([^)\s]+)\s*\)/;
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line.trim());
    if (h) {
      const name = h[1].trim();
      section = name === '食材' ? 'ing' : name === '步驟' ? 'steps' : name === '備註' ? 'notes' : null;
      continue;
    }
    if (section === 'ing') {
      const m = /^\s*-\s+(.*)$/.exec(line);
      if (m && m[1].trim()) r.ingredients.push(m[1].trim());
    } else if (section === 'steps') {
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

/* --- shared serialization (mirror of server) --- */
function slugify(str) {
  const base = String(str || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'recipe';
}
function fmValue(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => JSON.stringify(String(x))).join(', ') + ']';
  return JSON.stringify(String(v == null ? '' : v));
}
function recipeToMarkdownFE(r) {
  const L = [];
  L.push('---');
  L.push('title: ' + fmValue(r.title || ''));
  L.push('tags: ' + fmValue(r.tags || []));
  L.push('createdAt: ' + fmValue(r.createdAt || new Date().toISOString()));
  L.push('updatedAt: ' + fmValue(new Date().toISOString()));
  L.push('image: ' + fmValue(r.image || ''));
  L.push('---');
  L.push('');
  L.push('# ' + (r.title || '未命名食譜'));
  L.push('');
  L.push('## 食材');
  L.push('');
  for (const ing of r.ingredients || []) L.push('- ' + ing);
  L.push('');
  L.push('## 步驟');
  L.push('');
  (r.steps || []).forEach((s, i) => {
    const text = typeof s === 'string' ? s : s && s.text ? s.text : '';
    const img = typeof s === 'string' ? '' : s && s.image ? s.image : '';
    L.push(`${i + 1}. ${text}`);
    if (img) L.push(`   ![step](images/${img})`);
  });
  L.push('');
  if (r.notes && String(r.notes).trim()) {
    L.push('## 備註');
    L.push('');
    L.push(String(r.notes).trim());
    L.push('');
  }
  return L.join('\n');
}
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function normalizeSteps(steps) {
  const out = [];
  for (const s of steps || []) {
    const text = (typeof s === 'string' ? s : s && s.text ? s.text : '').trim();
    const image = typeof s === 'object' && s ? s.image || '' : '';
    const imageDataUrl = typeof s === 'object' && s ? s.imageDataUrl : undefined;
    out.push({ text, image, imageDataUrl });
  }
  return out;
}

// Images uploaded this session: filename -> dataURL. Lets us show a just-saved
// image instantly (optimistic) before the CDN/API has it.
const localImageCache = {};
function displayImageUrl(filename) {
  if (!filename) return '';
  if (localImageCache[filename]) return localImageCache[filename];
  return STORE.imageUrl(filename);
}

/* --- GitHub PAT (shared key), stored only in this browser --- */
const TOKEN_KEY = 'recipe_gh_pat';
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch {} }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }

const LocalStore = {
  local: true,
  canWrite() { return true; },
  async listRecipes() { const { data } = await api('api/recipes'); return (data && data.recipes) || []; },
  async getTags() { const { data } = await api('api/tags'); return (data && data.tags) || []; },
  imageUrl(f) { return 'images/' + encodeURIComponent(f); },
  async saveRecipe(payload) {
    const { ok, data } = await api('api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!ok || !data || !data.ok) throw uiError((data && data.message) || '儲存失敗');
    return data.recipe;
  },
  async deleteRecipe(id) {
    const { ok } = await api('api/recipes/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!ok) throw uiError('刪除失敗');
  },
  async addTag(name) {
    const { ok, data } = await api('api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!ok || !data || !data.ok) throw uiError((data && data.message) || '新增標籤失敗');
    return data.tags;
  },
  async renameTag(from, to) {
    const { ok, data } = await api('api/tags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
    if (!ok || !data || !data.ok) throw uiError((data && data.message) || '改名失敗');
    return data;
  },
  async deleteTag(name) {
    const { ok, data } = await api('api/tags/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!ok || !data || !data.ok) throw uiError('刪除標籤失敗');
    return data;
  },
};

function uiError(message) { const e = new Error(message); e.userMessage = message; return e; }

const GitHubStore = {
  local: false,
  rawBase: `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}`,
  apiBase: `https://api.github.com/repos/${GH.owner}/${GH.repo}`,
  canWrite() { return !!getToken(); },
  imageUrl(f) { return this.rawBase + '/data/images/' + encodeURIComponent(f); },

  async listRecipes() {
    const hasKey = this.canWrite();
    // listing itself: authenticated when we have a key (fresher, higher rate limit)
    const res = await this._ghFetch(this.apiBase + '/contents/data/recipes?ref=' + GH.branch, {}, hasKey);
    const files = await res.json();
    const mds = (Array.isArray(files) ? files : []).filter((f) => f.name.endsWith('.md'));
    const out = [];
    for (const f of mds) {
      try {
        let txt;
        if (hasKey) {
          // fresh content via Contents API (bypasses the raw CDN cache)
          const r = await this._ghFetch(f.url, {}, true);
          const j = await r.json();
          txt = j.content ? new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))) : '';
        } else {
          // anonymous: raw CDN + cache-buster keyed on the blob sha so edits show promptly
          const bust = (f.download_url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(f.sha);
          txt = await fetch(f.download_url + bust).then((r) => r.text());
        }
        out.push(parseRecipeMarkdown(f.name.replace(/\.md$/, ''), txt));
      } catch { /* skip one bad file */ }
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  },
  async getTags() {
    // prefer the API (fresh) when authenticated, else raw CDN
    try {
      if (this.canWrite()) {
        const f = await this._getFile('data/tags.json');
        if (f) { const a = JSON.parse(f.text); if (Array.isArray(a)) return a; }
      } else {
        const r = await fetch(this.rawBase + '/data/tags.json');
        if (r.ok) { const a = await r.json(); if (Array.isArray(a)) return a; }
      }
    } catch { /* ignore */ }
    return [];
  },

  /* ---- write helpers (Contents API) ---- */
  _ghFetch(url, opts, needAuth) {
    const headers = Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, (opts && opts.headers) || {});
    if (needAuth) {
      const token = getToken();
      if (!token) return Promise.reject(uiError('尚未設定 GitHub 金鑰。'));
      headers.Authorization = 'token ' + token;
    }
    return fetch(url, Object.assign({}, opts, { headers })).then((res) => {
      if (res.ok) return res;
      return res.json().catch(() => ({})).then((body) => {
        const err = uiError(this._msgForStatus(res.status, body));
        err.status = res.status;
        throw err;
      });
    }, () => { throw uiError('目前離線或連不到 GitHub。'); });
  },
  _msgForStatus(status, body) {
    if (status === 401) return 'GitHub 金鑰無效或已過期，請到「設定」重新貼上金鑰。';
    if (status === 403) return 'GitHub 金鑰權限不足：需 fine-grained PAT，授權此 repo，Contents 設為 Read and write。';
    if (status === 404) return '找不到資源（可能路徑錯或金鑰未授權此 repo）。';
    if (status === 409) return '資料版本衝突（有其他人剛改過），請重試。';
    if (status === 422) return 'GitHub 拒絕此次寫入（' + ((body && body.message) || '格式問題') + '）。';
    return 'GitHub 錯誤 ' + status + '：' + ((body && body.message) || '');
  },
  async _getFile(pathRel) {
    // returns {sha, text} or null (404)
    try {
      const res = await this._ghFetch(this.apiBase + '/contents/' + pathRel + '?ref=' + GH.branch, {}, this.canWrite());
      const j = await res.json();
      const text = j.content ? new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))) : '';
      return { sha: j.sha, text };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  async _putFile(pathRel, contentB64, message, sha) {
    const body = { message, content: contentB64, branch: GH.branch };
    if (sha) body.sha = sha;
    try {
      const res = await this._ghFetch(this.apiBase + '/contents/' + pathRel, { method: 'PUT', body: JSON.stringify(body) }, true);
      return res.json();
    } catch (e) {
      if (e.status === 409) {
        // sha went stale — refetch latest sha and retry once (last-write-wins)
        const cur = await this._getFile(pathRel);
        body.sha = cur ? cur.sha : undefined;
        const res2 = await this._ghFetch(this.apiBase + '/contents/' + pathRel, { method: 'PUT', body: JSON.stringify(body) }, true);
        return res2.json();
      }
      throw e;
    }
  },
  async _deleteFile(pathRel, sha, message) {
    const body = JSON.stringify({ message, sha, branch: GH.branch });
    await this._ghFetch(this.apiBase + '/contents/' + pathRel, { method: 'DELETE', body }, true);
  },
  async _uploadImage(dataUrl) {
    const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/i.exec(dataUrl || '');
    if (!m) throw uiError('圖片格式不支援。');
    const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await this._putFile('data/images/' + name, m[3], 'mobile: upload image ' + name, null);
    localImageCache[name] = dataUrl; // show instantly before the CDN/API has it
    return name;
  },

  async saveRecipe(payload) {
    // resolve cover image
    let image = payload.image || '';
    if (payload.imageDataUrl) image = await this._uploadImage(payload.imageDataUrl);
    // resolve step images
    const steps = [];
    for (const s of normalizeSteps(payload.steps)) {
      let img = s.image || '';
      if (s.imageDataUrl) img = await this._uploadImage(s.imageDataUrl);
      if (s.text || img) steps.push({ text: s.text, image: img });
    }
    // id + createdAt + existing sha
    let id = payload.id || '';
    let createdAt = new Date().toISOString();
    let sha = null;
    if (id) {
      const existing = await this._getFile('data/recipes/' + id + '.md');
      if (existing) { sha = existing.sha; const parsed = parseRecipeMarkdown(id, existing.text); if (parsed.createdAt) createdAt = parsed.createdAt; }
    } else {
      id = Date.now().toString(36) + '-' + slugify(payload.title);
    }
    const recipe = {
      id,
      title: payload.title || '未命名食譜',
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      ingredients: (payload.ingredients || []).filter((x) => String(x).trim()),
      steps,
      notes: payload.notes || '',
      image,
      createdAt,
    };
    const md = recipeToMarkdownFE(recipe);
    if (GH_DEBUG) console.log('[GitHubStore] PUT data/recipes/' + id + '.md', { hasSha: !!sha, bytes: md.length, steps: steps.length });
    await this._putFile('data/recipes/' + id + '.md', b64EncodeUtf8(md), 'mobile: save ' + recipe.title, sha);
    return recipe;
  },
  async deleteRecipe(id) {
    const f = await this._getFile('data/recipes/' + id + '.md');
    if (f) await this._deleteFile('data/recipes/' + id + '.md', f.sha, 'mobile: delete ' + id);
  },
  async _saveTags(list) {
    const clean = [];
    for (const t of list) { const s = String(t).trim(); if (s && !clean.includes(s)) clean.push(s); }
    const f = await this._getFile('data/tags.json');
    await this._putFile('data/tags.json', b64EncodeUtf8(JSON.stringify(clean, null, 2)), 'mobile: update tags', f ? f.sha : null);
    return clean;
  },
  async _writeRecipeObject(r) {
    // re-serialize a full recipe object and PUT (fetch fresh sha by id)
    const existing = await this._getFile('data/recipes/' + r.id + '.md');
    const md = recipeToMarkdownFE(r);
    await this._putFile('data/recipes/' + r.id + '.md', b64EncodeUtf8(md), 'mobile: update tags on ' + r.title, existing ? existing.sha : null);
  },
  async addTag(name) {
    const tags = await this.getTags();
    if (!tags.includes(name)) tags.push(name);
    return this._saveTags(tags);
  },
  async renameTag(from, to) {
    const tags = (await this.getTags()).map((t) => (t === from ? to : t));
    const saved = await this._saveTags(tags);
    let recipesUpdated = 0;
    for (const r of await this.listRecipes()) {
      if ((r.tags || []).includes(from)) {
        const uniq = [];
        for (const t of r.tags.map((t) => (t === from ? to : t))) if (!uniq.includes(t)) uniq.push(t);
        r.tags = uniq;
        await this._writeRecipeObject(r);
        recipesUpdated++;
      }
    }
    return { tags: saved, recipesUpdated };
  },
  async deleteTag(name) {
    const saved = await this._saveTags((await this.getTags()).filter((t) => t !== name));
    let recipesUpdated = 0;
    for (const r of await this.listRecipes()) {
      if ((r.tags || []).includes(name)) {
        r.tags = r.tags.filter((t) => t !== name);
        await this._writeRecipeObject(r);
        recipesUpdated++;
      }
    }
    return { tags: saved, recipesUpdated };
  },
};

const GH_DEBUG = /[?&]ghdebug\b/.test(location.search);
const STORE = IS_LOCAL && !FORCE_GH ? LocalStore : GitHubStore;

/* ---------- state ---------- */
let recipes = [];
let availableTags = [];
let selectedTags = new Set();
let editingId = null;
let pendingImageDataUrl = null; // dataURL, or '__CLEAR__', or null
let activeFilter = null; // null = 全部, otherwise a tag string

/* ---------- view switching ---------- */
function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'import') loadImports();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

/* ---------- tags ---------- */
async function loadTags() {
  try {
    availableTags = await STORE.getTags();
  } catch {
    availableTags = [];
  }
}

function renderTagChips() {
  const c = $('#f-tags-chips');
  c.innerHTML = availableTags
    .map((t) => `<button type="button" class="chip${selectedTags.has(t) ? ' selected' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`)
    .join('');
  $$('.chip', c).forEach((ch) =>
    ch.addEventListener('click', () => {
      const t = ch.dataset.tag;
      if (selectedTags.has(t)) selectedTags.delete(t);
      else selectedTags.add(t);
      ch.classList.toggle('selected');
    })
  );
}

// quick-add tag from the editor
$('#f-newtag-btn').addEventListener('click', quickAddTag);
$('#f-newtag').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quickAddTag(); } });
async function quickAddTag() {
  const name = $('#f-newtag').value.trim();
  if (!name) return;
  try {
    availableTags = await STORE.addTag(name);
    selectedTags.add(name);
    $('#f-newtag').value = '';
    renderTagChips();
    renderFilterBar();
    toast('已新增並選取標籤');
  } catch (e) {
    toast('新增標籤失敗：' + (e.userMessage || e.message || ''));
  }
}

/* ---------- tag manager ---------- */
$('#f-managetags-btn').addEventListener('click', openTagMgr);
$('#tagmgr-close').addEventListener('click', closeTagMgr);
$('#tagmgr-done').addEventListener('click', closeTagMgr);
$('#tagmgr').addEventListener('click', (e) => { if (e.target.id === 'tagmgr') closeTagMgr(); });
$('#tagmgr-add').addEventListener('click', tagMgrAdd);
$('#tagmgr-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tagMgrAdd(); } });

function openTagMgr() { renderTagMgr(); $('#tagmgr').classList.remove('hidden'); }
function closeTagMgr() { $('#tagmgr').classList.add('hidden'); renderTagChips(); renderFilterBar(); }

async function tagMgrAdd() {
  const name = $('#tagmgr-new').value.trim();
  if (!name) return;
  try {
    availableTags = await STORE.addTag(name);
    $('#tagmgr-new').value = '';
    renderTagMgr();
    toast('已新增標籤');
  } catch (e) {
    toast('新增標籤失敗：' + (e.userMessage || e.message || ''));
  }
}

function renderTagMgr() {
  const list = $('#tagmgr-list');
  if (!availableTags.length) {
    list.innerHTML = '<p class="muted">還沒有標籤，用下方新增。</p>';
    return;
  }
  list.innerHTML = availableTags
    .map(
      (t) => `<div class="tagmgr-row" data-tag="${esc(t)}">
        <input class="tm-input" type="text" value="${esc(t)}" />
        <button class="btn btn-ghost tm-rename" type="button">改名</button>
        <button class="btn btn-danger tm-del" type="button">刪除</button>
      </div>`
    )
    .join('');
  $$('.tagmgr-row', list).forEach((row) => {
    const orig = row.dataset.tag;
    $('.tm-rename', row).addEventListener('click', async () => {
      const to = $('.tm-input', row).value.trim();
      if (!to || to === orig) return;
      const btn = $('.tm-rename', row);
      btn.disabled = true;
      try {
        const data = await STORE.renameTag(orig, to);
        availableTags = data.tags;
        if (selectedTags.has(orig)) { selectedTags.delete(orig); selectedTags.add(to); }
        applyTagRenameLocal(orig, to); // optimistic
        renderRecipes();
        renderFilterBar();
        renderTagMgr();
        toast('已改名，更新 ' + data.recipesUpdated + ' 道食譜');
      } catch (e) {
        btn.disabled = false;
        toast('改名失敗：' + (e.userMessage || e.message || ''));
      }
    });
    $('.tm-del', row).addEventListener('click', async () => {
      if (!confirm('刪除標籤「' + orig + '」？用到它的食譜會一併移除此標籤。')) return;
      const btn = $('.tm-del', row);
      btn.disabled = true;
      try {
        const data = await STORE.deleteTag(orig);
        availableTags = data.tags;
        selectedTags.delete(orig);
        applyTagDeleteLocal(orig); // optimistic
        renderRecipes();
        renderFilterBar();
        renderTagMgr();
        toast('已刪除，更新 ' + data.recipesUpdated + ' 道食譜');
      } catch (e) {
        btn.disabled = false;
        toast('刪除失敗：' + (e.userMessage || e.message || ''));
      }
    });
  });
}

/* ---------- row-list editor (ingredients / steps) ---------- */
function listEl(kind) { return kind === 'ing' ? $('#f-ingredients-list') : $('#f-steps-list'); }

function renderRows(kind, values) {
  const list = listEl(kind);
  list.innerHTML = '';
  (values || []).forEach((v) => addRow(kind, v));
  if (!(values || []).length) addRow(kind, ''); // start with one empty row
  renumber(kind);
}

function addRow(kind, value) {
  const list = listEl(kind);
  const isStep = kind === 'step';
  const text = typeof value === 'string' ? value : value && value.text ? value.text : '';
  const image = typeof value === 'object' && value ? value.image || '' : '';

  const row = document.createElement('div');
  row.className = 'row-item' + (isStep ? ' step' : '');
  const marker = isStep ? '<span class="row-num"></span>' : '<span class="row-bullet">•</span>';
  const imgBtn = isStep
    ? `<label class="row-btn img" title="加圖片">🖼️<input class="row-imgfile" type="file" accept="image/*" hidden /></label>`
    : '';
  row.innerHTML = `${marker}
    <input class="row-text" type="text" placeholder="${isStep ? '這一步做什麼…' : '食材與份量…'}" />
    ${imgBtn}
    <button type="button" class="row-btn up" title="上移">▲</button>
    <button type="button" class="row-btn down" title="下移">▼</button>
    <button type="button" class="row-btn del" title="刪除">✕</button>
    ${isStep ? '<div class="step-thumb-wrap hidden"><img class="step-thumb" alt="步驟圖" /><button type="button" class="btn btn-ghost step-thumb-del">移除圖片</button></div>' : ''}`;
  $('.row-text', row).value = text;

  if (isStep) {
    row._image = image; // existing filename
    row._imageDataUrl = null; // newly picked dataURL
    updateStepThumb(row);
    $('.row-imgfile', row).addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await resizeImage(file);
        row._imageDataUrl = dataUrl;
        row._image = '';
        updateStepThumb(row);
      } catch (err) {
        toast(imgErrorMsg(err));
        e.target.value = '';
      }
    });
    $('.step-thumb-del', row).addEventListener('click', () => {
      row._image = ''; row._imageDataUrl = null; $('.row-imgfile', row).value = ''; updateStepThumb(row);
    });
  }

  $('.up', row).addEventListener('click', () => {
    const prev = row.previousElementSibling;
    if (prev) { list.insertBefore(row, prev); renumber(kind); }
  });
  $('.down', row).addEventListener('click', () => {
    const next = row.nextElementSibling;
    if (next) { list.insertBefore(next, row); renumber(kind); }
  });
  $('.del', row).addEventListener('click', () => { row.remove(); renumber(kind); });
  list.appendChild(row);
  renumber(kind);
}

function updateStepThumb(row) {
  const wrap = $('.step-thumb-wrap', row);
  if (!wrap) return;
  const img = $('.step-thumb', row);
  const src = row._imageDataUrl ? row._imageDataUrl : row._image ? displayImageUrl(row._image) : '';
  const imgBtn = $('.row-btn.img', row);
  if (src) {
    img.src = src;
    wrap.classList.remove('hidden');
    if (imgBtn) imgBtn.classList.add('has-img');
  } else {
    img.src = '';
    wrap.classList.add('hidden');
    if (imgBtn) imgBtn.classList.remove('has-img');
  }
}

function renumber(kind) {
  const rows = $$('.row-item', listEl(kind));
  rows.forEach((r, i) => {
    if (kind === 'step') { const n = $('.row-num', r); if (n) n.textContent = i + 1 + '.'; }
    $('.up', r).disabled = i === 0;
    $('.down', r).disabled = i === rows.length - 1;
  });
}

function collectRows(kind) {
  if (kind !== 'step') {
    return $$('.row-item .row-text', listEl(kind)).map((i) => i.value.trim()).filter(Boolean);
  }
  return $$('.row-item', listEl('step'))
    .map((row) => {
      const text = $('.row-text', row).value.trim();
      const step = { text, image: row._image || '' };
      if (row._imageDataUrl) step.imageDataUrl = row._imageDataUrl;
      return step;
    })
    .filter((s) => s.text || s.image || s.imageDataUrl);
}

$('#f-add-ing').addEventListener('click', () => addRow('ing', ''));
$('#f-add-step').addEventListener('click', () => addRow('step', ''));

/* ---------- recipe list ---------- */
async function loadRecipes() {
  try {
    recipes = await STORE.listRecipes();
  } catch (e) {
    toast('讀取食譜失敗' + (STORE.readonly ? '（GitHub 讀取問題）' : ''));
    recipes = recipes || [];
  }
  renderRecipes();
}

function renderFilterBar() {
  const bar = $('#filter-bar');
  // if the active filter tag no longer exists, reset to 全部
  if (activeFilter && !availableTags.includes(activeFilter)) activeFilter = null;
  const opts = [{ label: '全部', value: null }].concat(availableTags.map((t) => ({ label: t, value: t })));
  bar.innerHTML = opts
    .map((o) => `<button type="button" class="chip filter-chip${o.value === activeFilter ? ' selected' : ''}" data-val="${o.value === null ? '' : esc(o.value)}">${esc(o.label)}</button>`)
    .join('');
  $$('.filter-chip', bar).forEach((ch) =>
    ch.addEventListener('click', () => {
      activeFilter = ch.dataset.val === '' ? null : ch.dataset.val;
      renderFilterBar();
      renderRecipes();
    })
  );
}

/* optimistic in-memory updates — reflect a successful write immediately,
   without waiting for a (possibly CDN-stale) re-fetch */
function upsertRecipeLocal(recipe) {
  if (!recipe || !recipe.id) return;
  const i = recipes.findIndex((x) => x.id === recipe.id);
  if (i >= 0) recipes[i] = recipe;
  else recipes.push(recipe);
  recipes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  renderRecipes();
}
function removeRecipeLocal(id) {
  recipes = recipes.filter((x) => x.id !== id);
  renderRecipes();
}
function applyTagRenameLocal(from, to) {
  recipes.forEach((r) => {
    if ((r.tags || []).includes(from)) {
      const uniq = [];
      r.tags.map((t) => (t === from ? to : t)).forEach((t) => { if (!uniq.includes(t)) uniq.push(t); });
      r.tags = uniq;
    }
  });
}
function applyTagDeleteLocal(name) {
  recipes.forEach((r) => { if (r.tags) r.tags = r.tags.filter((t) => t !== name); });
}

function renderRecipes() {
  const q = $('#search').value.trim().toLowerCase();
  const grid = $('#recipe-grid');
  const filtered = recipes.filter((r) => {
    if (activeFilter && !(r.tags || []).includes(activeFilter)) return false;
    if (!q) return true;
    const hay = (r.title + ' ' + (r.tags || []).join(' ') + ' ' + (r.ingredients || []).join(' ')).toLowerCase();
    return hay.includes(q);
  });
  $('#empty-hint').classList.toggle('hidden', recipes.length !== 0);
  grid.innerHTML = filtered
    .map((r) => {
      const thumb = r.image
        ? `<img class="thumb" src="${displayImageUrl(r.image)}" alt="${esc(r.title)}" />`
        : `<div class="thumb placeholder">🍲</div>`;
      const tags = (r.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      return `<article class="recipe-card" data-id="${esc(r.id)}">
        ${thumb}
        <div class="body">
          <h3>${esc(r.title)}</h3>
          <div class="meta">${(r.ingredients || []).length} 種食材 · ${(r.steps || []).length} 步驟</div>
          <div>${tags}</div>
        </div>
      </article>`;
    })
    .join('');
  $$('.recipe-card', grid).forEach((c) => c.addEventListener('click', () => openReader(c.dataset.id)));
}
$('#search').addEventListener('input', renderRecipes);

/* ---------- reading mode ---------- */
let readerId = null;
function openReader(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  readerId = id;
  $('#reader-title').textContent = r.title || '未命名食譜';
  const cover = $('#reader-cover');
  if (r.image) { cover.src = displayImageUrl(r.image); cover.classList.remove('hidden'); }
  else { cover.src = ''; cover.classList.add('hidden'); }
  $('#reader-tags').innerHTML = (r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  $('#reader-ings').innerHTML =
    (r.ingredients || []).map((i) => `<li>${esc(i)}</li>`).join('') || '<li class="muted">（尚未填食材）</li>';
  $('#reader-steps').innerHTML =
    (r.steps || [])
      .map((s) => {
        const text = typeof s === 'string' ? s : s && s.text ? s.text : '';
        const image = typeof s === 'object' && s && s.image ? s.image : '';
        const img = image ? `<img class="reader-step-img" src="${displayImageUrl(image)}" alt="步驟圖" />` : '';
        return `<li><div class="reader-step-text">${esc(text)}</div>${img}</li>`;
      })
      .join('') || '<li class="muted">（尚未填步驟）</li>';
  const notesWrap = $('#reader-notes-wrap');
  if (r.notes && String(r.notes).trim()) {
    $('#reader-notes').textContent = r.notes;
    notesWrap.classList.remove('hidden');
  } else {
    notesWrap.classList.add('hidden');
  }
  $('#reader').classList.remove('hidden');
}
function closeReader() { $('#reader').classList.add('hidden'); readerId = null; }
$('#reader-close').addEventListener('click', closeReader);
$('#reader').addEventListener('click', (e) => { if (e.target.id === 'reader') closeReader(); });
$('#reader-edit').addEventListener('click', () => { const id = readerId; closeReader(); openEditor(id); });

/* ---------- editor modal ---------- */
function ensureTagsAvailable(tags) {
  // make sure a recipe's existing tags show as options even if not in tags.json
  (tags || []).forEach((t) => { if (!availableTags.includes(t)) availableTags.push(t); });
}

function fillEditor(data) {
  $('#f-title').value = data.title || '';
  selectedTags = new Set(data.tags || []);
  ensureTagsAvailable(data.tags || []);
  renderTagChips();
  renderRows('ing', data.ingredients || []);
  renderRows('step', data.steps || []);
  $('#f-notes').value = data.notes || '';
  $('#f-newtag').value = '';
}

function openEditor(id) {
  editingId = id || null;
  pendingImageDataUrl = null;
  const r = id ? recipes.find((x) => x.id === id) : null;
  $('#editor-title').textContent = r ? '編輯食譜' : '新增食譜';
  fillEditor(r || {});
  const prev = $('#f-img-preview');
  if (r && r.image) {
    prev.src = displayImageUrl(r.image);
    prev.classList.remove('hidden');
    $('#f-img-clear').classList.remove('hidden');
  } else {
    prev.src = '';
    prev.classList.add('hidden');
    $('#f-img-clear').classList.add('hidden');
  }
  $('#editor-delete').classList.toggle('hidden', !id);
  $('#f-image').value = '';
  $('#editor').classList.remove('hidden');
}

function closeEditor() {
  $('#editor').classList.add('hidden');
  editingId = null;
  pendingImageDataUrl = null;
}

$('#btn-new').addEventListener('click', () => openEditor(null));
$('#editor-close').addEventListener('click', closeEditor);
$('#editor-cancel').addEventListener('click', closeEditor);
$('#editor').addEventListener('click', (e) => { if (e.target.id === 'editor') closeEditor(); });

$('#f-image').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file);
    pendingImageDataUrl = dataUrl;
    const prev = $('#f-img-preview');
    prev.src = dataUrl;
    prev.classList.remove('hidden');
    $('#f-img-clear').classList.remove('hidden');
  } catch (err) {
    toast(imgErrorMsg(err));
    e.target.value = '';
  }
});

$('#f-img-clear').addEventListener('click', () => {
  pendingImageDataUrl = '__CLEAR__';
  $('#f-img-preview').src = '';
  $('#f-img-preview').classList.add('hidden');
  $('#f-img-clear').classList.add('hidden');
  $('#f-image').value = '';
});

$('#editor-save').addEventListener('click', async () => {
  const title = $('#f-title').value.trim();
  if (!title) return toast('請輸入標題');
  const existing = editingId ? recipes.find((x) => x.id === editingId) : null;
  const payload = {
    id: editingId || undefined,
    title,
    tags: Array.from(selectedTags),
    ingredients: collectRows('ing'),
    steps: collectRows('step'),
    notes: $('#f-notes').value.trim(),
    image: existing ? existing.image : '',
  };
  if (pendingImageDataUrl === '__CLEAR__') payload.image = '';
  else if (pendingImageDataUrl) payload.imageDataUrl = pendingImageDataUrl;

  const btn = $('#editor-save');
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = STORE.local ? '儲存中…' : '上傳到 GitHub…';
  try {
    const saved = await STORE.saveRecipe(payload);
    toast('已儲存');
    closeEditor();
    upsertRecipeLocal(saved); // optimistic: show new content immediately
  } catch (e) {
    toast('儲存失敗：' + (e.userMessage || e.message || '請稍後再試'));
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
});

$('#editor-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('確定刪除這道食譜？')) return;
  const id = editingId;
  try {
    await STORE.deleteRecipe(id);
    toast('已刪除');
    closeEditor();
    removeRecipeLocal(id); // optimistic
  } catch (e) {
    toast('刪除失敗：' + (e.userMessage || e.message || ''));
  }
});

/* ---------- import + AI organize ---------- */
$('#txt-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  $('#import-status').textContent = '讀取 ' + files.length + ' 個檔案…';
  const payloads = [];
  for (const f of files) {
    const content = await f.text();
    payloads.push({ name: f.name, content });
  }
  const { ok, data } = await api('api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: payloads }),
  });
  e.target.value = '';
  if (!ok || !data.ok) { $('#import-status').textContent = '匯入失敗'; return; }
  $('#import-status').textContent = '已匯入 ' + data.imported.length + ' 個檔案。';
  toast('已匯入 ' + data.imported.length + ' 個檔案');
  loadImports();
});

async function loadImports() {
  const { ok, data } = await api('api/imports');
  if (!ok) return;
  const list = $('#import-list');
  const items = data.imports || [];
  if (!items.length) {
    list.innerHTML = '<p class="muted" style="text-align:center;padding:20px">目前沒有待整理的檔案。</p>';
    return;
  }
  list.innerHTML = items
    .map(
      (it) => `<div class="import-item" data-id="${esc(it.id)}">
        <div class="head">
          <span class="name">📄 ${esc(it.name)}</span>
          <span class="muted">${it.size} bytes</span>
        </div>
        <div class="preview">${esc(it.preview)}${it.size > 160 ? '…' : ''}</div>
        <div class="actions">
          <button class="btn btn-primary btn-ai">✨ AI 整理</button>
          <button class="btn btn-ghost btn-del">刪除</button>
        </div>
        <div class="ai-slot"></div>
      </div>`
    )
    .join('');
  $$('.import-item', list).forEach((el) => {
    const id = el.dataset.id;
    $('.btn-ai', el).addEventListener('click', () => aiOrganize(id, el));
    $('.btn-del', el).addEventListener('click', () => deleteImport(id));
  });
}

async function deleteImport(id) {
  await api('api/imports/' + encodeURIComponent(id), { method: 'DELETE' });
  loadImports();
}

async function aiOrganize(id, el) {
  const slot = $('.ai-slot', el);
  const btn = $('.btn-ai', el);
  btn.disabled = true;
  btn.textContent = '整理中…';
  slot.innerHTML = '<div class="ai-result">正在請 AI 整理，請稍候（可能要幾十秒）…</div>';
  const { data } = await api('api/ai-organize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ importId: id }),
  });
  btn.disabled = false;
  btn.textContent = '✨ AI 整理';
  if (!data || !data.ok) {
    const msg = (data && data.message) || 'AI 整理失敗';
    slot.innerHTML = `<div class="ai-error">⚠️ ${esc(msg)}</div>`;
    return;
  }
  const r = data.recipe;
  slot.innerHTML = `<div class="ai-result">
    <strong>${esc(r.title || '未命名')}</strong><br/>
    食材 ${r.ingredients.length} 項 · 步驟 ${r.steps.length} 步<br/>
    <button class="btn btn-primary btn-review" style="margin-top:8px">檢視 / 存成食譜</button>
  </div>`;
  $('.btn-review', slot).addEventListener('click', () => {
    openEditor(null);
    $('#editor-title').textContent = 'AI 整理結果（確認後儲存）';
    fillEditor(r);
    switchView('list');
  });
}

/* ---------- backup: export / restore ---------- */
$('#btn-export').addEventListener('click', () => {
  // GET with Content-Disposition:attachment -> browser downloads the file
  $('#backup-status').textContent = '正在準備備份下載…';
  const a = document.createElement('a');
  a.href = 'api/export';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { $('#backup-status').textContent = '若沒自動下載，請檢查瀏覽器下載列。'; }, 800);
});

$('#restore-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!confirm('還原會用備份內容覆蓋同名食譜與圖片，確定要繼續？')) { e.target.value = ''; return; }
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    toast('備份檔格式錯誤，無法解析。');
    e.target.value = '';
    return;
  }
  $('#backup-status').textContent = '還原中…';
  const { ok, data } = await api('api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup }),
  });
  e.target.value = '';
  if (ok && data && data.ok) {
    $('#backup-status').textContent = '已還原 ' + data.recipeCount + ' 道食譜、' + data.imageCount + ' 張圖片。';
    toast('還原完成');
    await loadTags();
    renderFilterBar();
    await loadRecipes();
  } else {
    const msg = (data && data.message) || '還原失敗。';
    $('#backup-status').textContent = msg;
    toast('還原失敗：' + msg);
  }
});

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------- mode UI (localhost vs GitHub Pages, key vs no-key) ---------- */
function show(sel, on) { const el = $(sel); if (el) el.classList.toggle('hidden', !on); }
function applyModeUI() {
  const canWrite = STORE.canWrite();
  document.body.classList.toggle('readonly', !canWrite);
  // write entry points (new / edit / manage tags) follow canWrite
  show('#btn-new', canWrite);
  show('#reader-edit', canWrite);
  // import + AI organize are localhost-only, never on GitHub Pages
  const importTab = $('.tab[data-view="import"]');
  if (importTab) importTab.classList.toggle('hidden', !STORE.local);
  // settings (key) entry only on the GitHub/Pages build
  show('#btn-settings', !STORE.local);
  // read-only note only when the user cannot write (Pages, no key)
  show('#readonly-note', !canWrite);
  if (!STORE.local) switchView('list'); // never sit on the (hidden) import view
}

/* ---------- settings (GitHub key) ---------- */
$('#btn-settings') && $('#btn-settings').addEventListener('click', openSettings);
$('#settings-close') && $('#settings-close').addEventListener('click', closeSettings);
$('#settings') && $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
function openSettings() {
  const t = getToken();
  $('#settings-token').value = t;
  $('#settings-status').textContent = t ? '目前已設定金鑰（可編輯）。' : '尚未設定金鑰（唯讀）。';
  $('#settings').classList.remove('hidden');
}
function closeSettings() { $('#settings').classList.add('hidden'); }
$('#settings-save') && $('#settings-save').addEventListener('click', async () => {
  const t = $('#settings-token').value.trim();
  if (!t) { toast('請先貼上金鑰'); return; }
  setToken(t);
  $('#settings-status').textContent = '已儲存，重新載入中…';
  toast('金鑰已儲存');
  applyModeUI();
  await loadTags();
  renderFilterBar();
  await loadRecipes();
  closeSettings();
});
$('#settings-clear') && $('#settings-clear').addEventListener('click', async () => {
  clearToken();
  $('#settings-token').value = '';
  $('#settings-status').textContent = '已清除金鑰，回到唯讀。';
  toast('金鑰已清除');
  applyModeUI();
  await loadTags();
  renderFilterBar();
  await loadRecipes();
});

/* ---------- manual refresh ---------- */
$('#btn-refresh') && $('#btn-refresh').addEventListener('click', async () => {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '更新中…';
  try {
    await loadTags();
    renderFilterBar();
    await loadRecipes();
    toast('已更新');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

/* ---------- background scroll lock while an overlay is open ---------- */
let savedScrollY = 0;
function anyModalOpen() { return $$('.modal').some((m) => !m.classList.contains('hidden')); }
function refreshScrollLock() {
  const open = anyModalOpen();
  const locked = document.body.classList.contains('scroll-locked');
  if (open && !locked) {
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = -savedScrollY + 'px';
    document.body.classList.add('scroll-locked');
  } else if (!open && locked) {
    document.body.classList.remove('scroll-locked');
    document.body.style.top = '';
    window.scrollTo(0, savedScrollY);
  }
}
// react to any modal being shown/hidden (they toggle the .hidden class)
$$('.modal').forEach((m) => new MutationObserver(refreshScrollLock).observe(m, { attributes: true, attributeFilter: ['class'] }));

/* ---------- boot ---------- */
(async function boot() {
  applyModeUI();
  await loadTags();
  renderFilterBar();
  await loadRecipes();
})();
