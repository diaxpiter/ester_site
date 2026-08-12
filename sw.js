// Ester PWA service worker.
// Goal: make the portal installable + fast, WITHOUT breaking Firebase.
// Strategy: only touch same-origin GET requests. Firestore/Auth/Google Fonts
// (cross-origin) pass straight through, untouched, so live data is never stale.
const CACHE = 'ester-v15';
const SHELL = [
  'portal.html',
  'index.html',
  'images/icons/fav.ico',
  'images/icons/icone_admin.png',
  'images/icons/icone_portal.png',
  'css/portal.css',
  'css/index.css',
  'js/core.js',
  'js/contract-template.js',
  'js/client-dashboard.js',
  'js/admin-finance.js',
  'js/admin-debts-agenda.js',
  'js/admin-clients.js',
  'js/admin-leads.js',
  'js/app.js'
];

self.addEventListener('install', (e) => {
  // Static assets carry a 7-day Cache-Control (firebase.json) — a plain
  // caches.addAll(SHELL) still respects that HTTP cache, so a version bump
  // could silently re-precache a still-"fresh" stale file. {cache:'reload'}
  // forces a real network fetch here, so every CACHE bump is guaranteed to
  // pick up whatever was just deployed.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => fetch(url, { cache: 'reload' }).then((res) => c.put(url, res)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never cache writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // let Firebase/fonts pass through

  // HTML: network-first (always try fresh), fall back to cache when offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match(url.pathname.indexOf('portal') !== -1 ? 'portal.html' : 'index.html')))
    );
    return;
  }

  // Static assets (images/css/js): cache-first for speed, update in background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
