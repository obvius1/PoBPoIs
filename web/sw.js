/**
 * Service Worker — zorgt voor 100% offline werking
 *
 * Strategie:
 *   Install  → enkel app shell (klein, altijd, geen toestemming nodig)
 *   Message  → grote cache (foto's + tiles) op verzoek van de app
 *              De app controleert eerst of we op WiFi zitten.
 */

const CACHE_VERSION = 'build-966f1e1e';
const CACHE_NAME = `peaks-pois-${CACHE_VERSION}`;

// App shell: klein, altijd gecached, ook op mobiele data
const PRECACHE_STATIC = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './leaflet.min.js',
  './leaflet.css',
  './manifest.webmanifest',
  './data.json',
  './map-tiles.json',
];

let _cacheJobRunning = false;

// ── Helper: stuur voortgang naar alle open tabs ───────────────────────────────

async function broadcastProgress(done, total) {
  const pct = Math.round(done / total * 100);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'CACHE_PROGRESS', done, total, pct }));
}

// ── Install: enkel app shell (snel + klein) ───────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_STATIC))
  );
  self.skipWaiting();
});

// ── Activate: oude caches opruimen ────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('peaks-pois-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Message: start grote cache op verzoek van de app ─────────────────────────

self.addEventListener('message', event => {
  if (event.data?.type === 'START_PRECACHE') {
    if (_cacheJobRunning) return; // al bezig
    _cacheJobRunning = true;
    runPrecache().finally(() => { _cacheJobRunning = false; });
  }
});

async function runPrecache() {
  const cache = await caches.open(CACHE_NAME);

  // 1. Foto's (uit data.json)
  try {
    const data = await fetch('./data.json').then(r => r.json());
    const assets = [];
    for (const poi of data.pois ?? []) {
      for (const photo of poi.photos        ?? []) assets.push(photo);
      for (const photo of poi.google_photos ?? []) assets.push(photo);
    }
    for (let i = 0; i < assets.length; i += 50) {
      const batch = assets.slice(i, i + 50);
      await Promise.allSettled(batch.map(url => cache.add(url).catch(() => {})));
    }
    console.log(`[SW] ${assets.length} foto's gecached`);
  } catch (err) {
    console.warn('[SW] Foto-caching mislukt:', err.message);
  }

  // 2. Kaarttiles (gegenereerd door build, zoom 1-17)
  try {
    const tileUrls = await fetch('./map-tiles.json').then(r => r.json());
    let tilesOk = 0, tilesDone = 0;

    for (let i = 0; i < tileUrls.length; i += 30) {
      const batch = tileUrls.slice(i, i + 30);
      const results = await Promise.allSettled(batch.map(url =>
        fetch(url, { cache: 'force-cache' })
          .then(r => r.ok ? cache.put(url, r) : null)
          .catch(() => null)
      ));
      tilesOk   += results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
      tilesDone += batch.length;
      await broadcastProgress(tilesOk, tileUrls.length);
      if (tilesDone % 300 === 0) await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[SW] ${tilesOk}/${tilesDone} tiles gecached`);
  } catch (err) {
    console.warn('[SW] Tile-caching mislukt:', err.message);
  }
}

// ── Fetch: cache-first ────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => new Response(
        '<h2>Offline</h2><p>Dit bestand is niet gecached. Verbind eerst met internet.</p>',
        { headers: { 'Content-Type': 'text/html' } }
      ));
    })
  );
});
