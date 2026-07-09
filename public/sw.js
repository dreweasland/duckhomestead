/**
 * Duck Homestead service worker — the install-to-homescreen shell.
 *
 * Strategy, deliberately minimal (the game is a single page + hashed assets):
 *  - Navigations: network-first, falling back to the cached shell — updates
 *    arrive on the next online load, and the installed app still boots with
 *    no connection (the sim is fully client-side; the save is localStorage).
 *  - /assets/ and /icons/: cache-first — Vite content-hashes /assets/, so a
 *    cached file is immutable by construction.
 * Bump VERSION to invalidate every cache (activate sweeps old ones).
 */
const VERSION = 'v1';
const SHELL_CACHE = `homestead-shell-${VERSION}`;
const ASSET_CACHE = `homestead-assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add('/'))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('homestead-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App shell: network-first so deploys land, cache fallback so offline boots.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Hashed assets + icons: immutable, cache-first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(req, copy));
            return res;
          }),
      ),
    );
  }
});
