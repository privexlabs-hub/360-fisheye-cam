// Offline support: cache the app shell on install, everything else
// (models, WebAssembly, video library) the first time it is used.
const VERSION = 'v3';
const CACHE = `360cam-${VERSION}`;
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/main.js', 'js/renderer.js', 'js/shaders.js', 'js/effects.js', 'js/tracking.js',
  'js/camera.js', 'js/recorder.js', 'js/media.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('360cam-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Network first for the app shell so updates arrive; cache first for big static assets.
  const big = /\/(vendor|models|icons)\//.test(new URL(req.url).pathname);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (big) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
