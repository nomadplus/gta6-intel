const CACHE = 'black-monday-web-iphone-preview-v0.3.3';
const RUNTIME_CACHE = 'black-monday-web-runtime-v0.3.3';
const SHELL = ['./', './index.html', './styles.css', './app.bundle.js', './manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![CACHE, RUNTIME_CACHE].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || ['.iso', '.cso', '.chd', '.isz', '.bin'].some(ext => url.pathname.toLowerCase().endsWith(ext))) return;
  const isRuntime = url.pathname.endsWith('/runtime/Play.js') || url.pathname.endsWith('/runtime/Play.wasm') || url.pathname.includes('.worker.');
  if (isRuntime) {
    event.respondWith(caches.match(event.request).then(async hit => {
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) (await caches.open(RUNTIME_CACHE)).put(event.request, response.clone());
      return response;
    }));
    return;
  }
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
});
