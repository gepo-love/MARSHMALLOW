const TRIAL_BUILD = '181337';
const CACHE_NAME = `web-trial-v${TRIAL_BUILD}`;
const CORE_FILES = [
  './',
  './index.html',
  './manifest.json',
  './js/boot.js',
  './css/variables.css',
  './css/global.css',
  './css/components.css',
  './css/home.css',
  './css/home-album.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('web-trial-v') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_LOGIN_BOOTSTRAP'
    || event.data?.type === 'ACTIVATE_CONFIRMED_UPDATE') {
    event.waitUntil(self.skipWaiting());
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request)) || (await cache.match('./index.html')) || Promise.reject(error);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(request);
      if (response.ok || response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (!response) throw lastError || new Error('静态资源请求失败');
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
