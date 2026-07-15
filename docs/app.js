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

const LocalStore = {
  readonly: false,
  async listRecipes() { const { data } = await api('api/recipes'); return (data && data.recipes) || []; },
  async getTags() { const { data } = await api('api/tags'); return (data && data.tags) || []; },
  imageUrl(f) { return 'images/' + encodeURIComponent(f); },
};

const GitHubStore = {
  readonly: true,
  rawBase: `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}`,
  async listRecipes() {
    const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/data/recipes?ref=${GH.branch}`;
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('GitHub API ' + res.status);
    const files = await res.json();
    const mds = (Array.isArray(files) ? files : []).filter((f) => f.name.endsWith('.md'));
    const out = [];
    for (const f of mds) {
      try {
        const txt = await fetch(f.download_url).then((r) => r.text());
        out.push(parseRecipeMarkdown(f.name.replace(/\.md$/, ''), txt));
      } catch { /* skip one bad file */ }
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  },
  async getTags() {
    try {
      const r = await fetch(this.rawBase + '/data/tags.json');
      if (r.ok) { const a = await r.json(); if (Array.isArray(a)) return a; }
    } catch { /* ignore */ }
    return [];
  },
  imageUrl(f) { return this.rawBase + '/data/images/' + encodeURIComponent(f); },
};

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
  const { ok, data } = await api('api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (ok && data.ok) {
    availableTags = data.tags;
    selectedTags.add(name);
    $('#f-newtag').value = '';
    renderTagChips();
    renderFilterBar();
    toast('已新增並選取標籤');
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
  const { ok, data } = await api('api/tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  if (ok && data.ok) { availableTags = data.tags; $('#tagmgr-new').value = ''; renderTagMgr(); toast('已新增標籤'); }
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
      const { ok, data } = await api('api/tags', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: orig, to }),
      });
      if (ok && data.ok) {
        availableTags = data.tags;
        if (selectedTags.has(orig)) { selectedTags.delete(orig); selectedTags.add(to); }
        await loadRecipes();
        renderTagMgr();
        toast('已改名，更新 ' + data.recipesUpdated + ' 道食譜');
      } else {
        toast((data && data.message) || '改名失敗');
      }
    });
    $('.tm-del', row).addEventListener('click', async () => {
      if (!confirm('刪除標籤「' + orig + '」？用到它的食譜會一併移除此標籤。')) return;
      const { ok, data } = await api('api/tags/' + encodeURIComponent(orig), { method: 'DELETE' });
      if (ok && data.ok) {
        availableTags = data.tags;
        selectedTags.delete(orig);
        await loadRecipes();
        renderTagMgr();
        toast('已刪除，更新 ' + data.recipesUpdated + ' 道食譜');
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
  const src = row._imageDataUrl ? row._imageDataUrl : row._image ? STORE.imageUrl(row._image) : '';
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
        ? `<img class="thumb" src="${STORE.imageUrl(r.image)}" alt="${esc(r.title)}" />`
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
  if (r.image) { cover.src = STORE.imageUrl(r.image); cover.classList.remove('hidden'); }
  else { cover.src = ''; cover.classList.add('hidden'); }
  $('#reader-tags').innerHTML = (r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  $('#reader-ings').innerHTML =
    (r.ingredients || []).map((i) => `<li>${esc(i)}</li>`).join('') || '<li class="muted">（尚未填食材）</li>';
  $('#reader-steps').innerHTML =
    (r.steps || [])
      .map((s) => {
        const text = typeof s === 'string' ? s : s && s.text ? s.text : '';
        const image = typeof s === 'object' && s && s.image ? s.image : '';
        const img = image ? `<img class="reader-step-img" src="${STORE.imageUrl(image)}" alt="步驟圖" />` : '';
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
    prev.src = '/images/' + encodeURIComponent(r.image);
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

  const { ok, data } = await api('api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!ok || !data || !data.ok) {
    const msg = (data && data.message) || '儲存失敗，請稍後再試。';
    return toast('儲存失敗：' + msg);
  }
  toast('已儲存');
  closeEditor();
  await loadRecipes();
});

$('#editor-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('確定刪除這道食譜？')) return;
  const { ok } = await api('api/recipes/' + encodeURIComponent(editingId), { method: 'DELETE' });
  if (!ok) return toast('刪除失敗');
  toast('已刪除');
  closeEditor();
  await loadRecipes();
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

/* ---------- read-only mode (GitHub Pages) ---------- */
function applyReadonlyMode() {
  if (!STORE.readonly) return;
  document.body.classList.add('readonly');
  // hide every write entry point
  const hide = (sel) => { const el = $(sel); if (el) el.classList.add('hidden'); };
  hide('#btn-new');
  hide('#reader-edit');
  const importTab = $('.tab[data-view="import"]');
  if (importTab) importTab.classList.add('hidden');
  const note = $('#readonly-note');
  if (note) note.classList.remove('hidden');
  // if somehow on the import view, force back to list
  switchView('list');
}

/* ---------- boot ---------- */
(async function boot() {
  applyReadonlyMode();
  await loadTags();
  renderFilterBar();
  await loadRecipes();
})();
