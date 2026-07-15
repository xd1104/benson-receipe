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
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}

/* ---------- state ---------- */
let recipes = [];
let editingId = null;
let pendingImageDataUrl = null; // set when user picks a new image

/* ---------- view switching ---------- */
function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'import') loadImports();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

/* ---------- recipe list ---------- */
async function loadRecipes() {
  const { ok, data } = await api('/api/recipes');
  if (!ok) return toast('讀取食譜失敗');
  recipes = data.recipes || [];
  renderRecipes();
}

function renderRecipes() {
  const q = $('#search').value.trim().toLowerCase();
  const grid = $('#recipe-grid');
  const filtered = recipes.filter((r) => {
    if (!q) return true;
    const hay = (r.title + ' ' + (r.tags || []).join(' ') + ' ' + (r.ingredients || []).join(' ')).toLowerCase();
    return hay.includes(q);
  });
  $('#empty-hint').classList.toggle('hidden', recipes.length !== 0);
  grid.innerHTML = filtered
    .map((r) => {
      const thumb = r.image
        ? `<img class="thumb" src="/images/${encodeURIComponent(r.image)}" alt="${esc(r.title)}" />`
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
  $$('.recipe-card', grid).forEach((c) => c.addEventListener('click', () => openEditor(c.dataset.id)));
}

$('#search').addEventListener('input', renderRecipes);

/* ---------- editor modal ---------- */
function openEditor(id) {
  editingId = id || null;
  pendingImageDataUrl = null;
  const r = id ? recipes.find((x) => x.id === id) : null;
  $('#editor-title').textContent = r ? '編輯食譜' : '新增食譜';
  $('#f-title').value = r ? r.title : '';
  $('#f-tags').value = r ? (r.tags || []).join(', ') : '';
  $('#f-ingredients').value = r ? (r.ingredients || []).join('\n') : '';
  $('#f-steps').value = r ? (r.steps || []).join('\n') : '';
  $('#f-notes').value = r ? r.notes || '' : '';
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

$('#f-image').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = reader.result;
    const prev = $('#f-img-preview');
    prev.src = reader.result;
    prev.classList.remove('hidden');
    $('#f-img-clear').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

$('#f-img-clear').addEventListener('click', () => {
  pendingImageDataUrl = '__CLEAR__';
  $('#f-img-preview').src = '';
  $('#f-img-preview').classList.add('hidden');
  $('#f-img-clear').classList.add('hidden');
  $('#f-image').value = '';
});

function linesToArray(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

$('#editor-save').addEventListener('click', async () => {
  const title = $('#f-title').value.trim();
  if (!title) return toast('請輸入標題');
  const existing = editingId ? recipes.find((x) => x.id === editingId) : null;
  const payload = {
    id: editingId || undefined,
    title,
    tags: $('#f-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
    ingredients: linesToArray($('#f-ingredients').value),
    steps: linesToArray($('#f-steps').value),
    notes: $('#f-notes').value.trim(),
    image: existing ? existing.image : '',
  };
  if (pendingImageDataUrl === '__CLEAR__') payload.image = '';
  else if (pendingImageDataUrl) payload.imageDataUrl = pendingImageDataUrl;

  const { ok, data } = await api('/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!ok || !data.ok) return toast('儲存失敗');
  toast('已儲存');
  closeEditor();
  await loadRecipes();
});

$('#editor-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('確定刪除這道食譜？')) return;
  const { ok } = await api('/api/recipes/' + encodeURIComponent(editingId), { method: 'DELETE' });
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
  const { ok, data } = await api('/api/import', {
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
  const { ok, data } = await api('/api/imports');
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
  await api('/api/imports/' + encodeURIComponent(id), { method: 'DELETE' });
  loadImports();
}

async function aiOrganize(id, el) {
  const slot = $('.ai-slot', el);
  const btn = $('.btn-ai', el);
  btn.disabled = true;
  btn.textContent = '整理中…';
  slot.innerHTML = '<div class="ai-result">正在請 AI 整理，請稍候（可能要幾十秒）…</div>';
  const { data } = await api('/api/ai-organize', {
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
    // open editor prefilled with AI result (as a new recipe)
    openEditor(null);
    $('#editor-title').textContent = 'AI 整理結果（確認後儲存）';
    $('#f-title').value = r.title || '';
    $('#f-tags').value = (r.tags || []).join(', ');
    $('#f-ingredients').value = (r.ingredients || []).join('\n');
    $('#f-steps').value = (r.steps || []).join('\n');
    $('#f-notes').value = r.notes || '';
    switchView('list');
  });
}

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* ---------- boot ---------- */
loadRecipes();
