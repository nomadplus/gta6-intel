const CACHE = 'black-monday-web-iphone-preview-v0.4.3';
const RUNTIME_CACHE = 'black-monday-web-runtime-v0.4.3';
const SHELL = ['./', './index.html', './styles.css', './app.bundle.js', './manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => ![CACHE, RUNTIME_CACHE].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, cacheName, { forceReload = false } = {}) {
  try {
    const response = await fetch(request, forceReload ? { cache: 'reload' } : undefined);
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || ['.iso', '.cso', '.chd', '.isz', '.bin', '.7z'].some(ext => url.pathname.toLowerCase().endsWith(ext))) return;

  const isRuntime = url.pathname.endsWith('/runtime/Play.js')
    || url.pathname.endsWith('/runtime/Play.wasm')
    || url.pathname.includes('/extractor/')
    || url.pathname.includes('.worker.');

  event.respondWith(networkFirst(event.request, isRuntime ? RUNTIME_CACHE : CACHE, { forceReload: isRuntime }));
});
