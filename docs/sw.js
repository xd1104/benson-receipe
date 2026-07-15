/* Recipe Book service worker
 * - App shell: cache-first
 * - Recipe data (GET /api/recipes, /api/recipes/:id): network-first, fall back to cache
 * - Images (/images/...): cache-first, fall back to network
 * - Write requests (POST/PUT/DELETE) and other APIs: network-only; on failure
 *   return a clear offline JSON so the UI can show a helpful message.
 * Goal: with only a phone and no connection to the host PC, the user can still
 * SEE recipes and images that were loaded before.
 */
const SHELL_CACHE = 'recipe-shell-v12';
const DATA_CACHE = 'recipe-data-v12';
const IMG_CACHE = 'recipe-img-v12';
const KEEP = [SHELL_CACHE, DATA_CACHE, IMG_CACHE];

// Relative paths so the app works both at localhost root and under a GitHub
// Pages sub-path (e.g. /benson-receipe/). They resolve against the SW scope.
const BASE = new URL('./', self.location).pathname; // e.g. "/" or "/benson-receipe/"
const SHELL = [
  BASE,
  BASE + 'index.html',
  BASE + 'styles.css',
  BASE + 'app.js',
  BASE + 'manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/icon-maskable-512.png',
  BASE + 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

function offlineJson() {
  return new Response(JSON.stringify({ ok: false, code: 'offline', message: '目前離線或連不到食譜伺服器。' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// network-first: try network, cache good GET responses, fall back to cache
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy));
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineJson();
  }
}

// cache-first: serve cache, otherwise fetch and cache
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy));
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through

  // Images: cache-first
  if (url.pathname.startsWith('/images/') && req.method === 'GET') {
    e.respondWith(cacheFirst(req, IMG_CACHE));
    return;
  }

  // Recipe data reads: network-first with cache fallback
  const isRecipeRead = req.method === 'GET' && (url.pathname === '/api/recipes' || url.pathname.startsWith('/api/recipes/') || url.pathname === '/api/tags');
  if (isRecipeRead) {
    e.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // Other API calls (writes, ai-organize, import, export...): network-only,
  // clear offline response on failure. Never cached.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => offlineJson()));
    return;
  }

  // App shell: cache-first, fall back to network, then to index.html
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((res) => {
          if (res.ok && req.method === 'GET') {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(BASE + 'index.html'))
    )
  );
});
