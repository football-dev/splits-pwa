const CACHE_NAME = 'splits-v10';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/planGenerator.js',
  './js/planStats.js',
  './js/healthSync.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    // cache: 'reload' skips the browser's HTTP cache, so a new version
    // never gets filled with stale copies of the old files.
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell; network for everything else (API calls
// to Google Health should never be served stale).
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let API calls pass straight through

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
