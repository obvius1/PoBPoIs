/**
 * Peaks of the Balkans — Offline POI Viewer
 * Vanilla JS, geen build-tooling nodig.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let allPois = [];
let filtered = [];
let activeCategory = 'all';
let searchQuery = '';
let userLat = null, userLon = null;
let activeView = 'list';  // 'list' | 'map'
let _lbPhotos = [];       // {url, source} van het huidig geopend POI (voor lightbox)
let _lbIndex  = 0;        // huidig zichtbare foto in lightbox
let _lbScale  = 1;        // zoom-niveau in lightbox
let _lbTransX = 0;        // horizontale verschuiving bij zoom
let _lbTransY = 0;        // verticale verschuiving bij zoom
let _lbSuppressClose = false; // voorkom sluiten direct na dubbeltik
let _cachedPct = 0;           // huidig cache-percentage (voor directe balk bij 4G-goedkeuring)

// Leaflet instanties
let leafletMap = null;
let userMarker = null;
let poiMarkers = [];       // { marker, poi } paren
let _detailMap = null;     // Leaflet mini-kaart in detail-venster

// ── Favorieten (localStorage) ─────────────────────────────────────────────────

let starredIds = new Set(JSON.parse(localStorage.getItem('peaks-starred') ?? '[]'));

function starKey(osmId, osmType) { return `${osmType}-${osmId}`; }
function isStarred(osmId, osmType) { return starredIds.has(starKey(osmId, osmType)); }

function saveStarred() {
  localStorage.setItem('peaks-starred', JSON.stringify([...starredIds]));
}

// ── Persoonlijke notities (localStorage) ─────────────────────────────────────

function getNoteKey(poiId) { return `peaks-note-${poiId}`; }
function getNote(poiId)    { return localStorage.getItem(getNoteKey(poiId)) ?? ''; }
function saveNote(poiId, text) {
  if (text.trim()) localStorage.setItem(getNoteKey(poiId), text);
  else             localStorage.removeItem(getNoteKey(poiId));
}

window.toggleStar = function(osmId, osmType) {
  const key = starKey(osmId, osmType);
  const nowStarred = !starredIds.has(key);
  nowStarred ? starredIds.add(key) : starredIds.delete(key);
  saveStarred();

  // Update ster-knop in open detail-venster zonder alles te her-renderen
  const btn = document.getElementById('detail-star-btn');
  if (btn) {
    btn.textContent = nowStarred ? '★' : '☆';
    btn.classList.toggle('starred', nowStarred);
    btn.title = nowStarred ? 'Verwijder uit favorieten' : 'Voeg toe aan favorieten';
  }

  // Herrender als het favorieten-filter actief is
  if (activeCategory === 'starred') applyFilters();
};

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  registerSW();
  setupOfflineBanner();

  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allPois = data.pois ?? [];
    window._routeData = data.route ?? null;
    document.getElementById('loading').style.display = 'none';
    setupViewTabs();
    setupFilters();
    applyFilters();
    setupSearch();
    setupLocate();
    setupLightbox();
    setupCachePrompt();
    setupShare();
    // Controleer hoeveel al offline gecached is (na korte delay zodat SW al actief is)
    setTimeout(checkCacheStatus, 1500);
  } catch (err) {
    document.getElementById('loading').innerHTML =
      `<div style="text-align:center;padding:40px;color:#ff6b6b">
        <div style="font-size:2rem">⚠️</div>
        <p style="margin-top:8px">Kan data.json niet laden.<br>
        Voer de build-pipeline uit eerst.</p>
        <pre style="font-size:.7rem;margin-top:8px;opacity:.6">${err.message}</pre>
      </div>`;
  }
}

// ── Service Worker registratie ────────────────────────────────────────────────

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});

  // Vraag iOS/Android om de opslag NOOIT automatisch te wissen
  if (navigator.storage?.persist) {
    navigator.storage.persist().then(granted => {
      console.log('[Storage] Persistent storage:', granted ? 'toegestaan ✅' : 'niet gegarandeerd ⚠️');
    });
  }

  // Luister naar voortgangsberichten van de SW tijdens het cachen
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'CACHE_PROGRESS') {
      showCacheStatus(event.data.pct);
    }
  });
}

// ── Verbindingstype detecteren ────────────────────────────────────────────────

function getConnectionType() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return 'unknown';
  if (conn.saveData) return 'metered';           // data-besparingsmodus aan
  const t = conn.type || '';
  if (t === 'wifi' || t === 'ethernet') return 'wifi';
  if (t === 'cellular')                 return 'cellular';
  // effectiveType als fallback (beschikbaar op Android Chrome)
  if (conn.effectiveType)               return 'cellular';
  return 'unknown';
}

// ── Start grote SW-cache (foto's + tiles) ─────────────────────────────────────

function startTileCaching() {
  const sendMsg = sw => sw?.postMessage({ type: 'START_PRECACHE' });
  if (navigator.serviceWorker.controller) {
    sendMsg(navigator.serviceWorker.controller);
  } else {
    navigator.serviceWorker.ready.then(reg => sendMsg(reg.active));
  }
}

// ── Verbindingsprompt tonen ───────────────────────────────────────────────────

function showCachePrompt() {
  const el = document.getElementById('cache-prompt');
  if (el) el.style.display = 'flex';
}

function hideCachePrompt() {
  const el = document.getElementById('cache-prompt');
  if (el) el.style.display = 'none';
}

function setupCachePrompt() {
  document.getElementById('cache-prompt-yes')?.addEventListener('click', () => {
    hideCachePrompt();
    showCacheStatus(_cachedPct); // toon balk direct, zonder te wachten op SW-bericht
    startTileCaching();
  });
  document.getElementById('cache-prompt-no')?.addEventListener('click', () => {
    hideCachePrompt();
  });
}

// ── Exporteer / Importeer favorieten & notities ───────────────────────────────

function getAllNotes() {
  const notes = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('peaks-note-')) {
      const text = localStorage.getItem(key);
      if (text?.trim()) notes[key.slice('peaks-note-'.length)] = text;
    }
  }
  return notes;
}

function showToast(msg, isError = false) {
  const el = document.getElementById('import-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? 'toast-error' : 'toast-ok';
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 4000);
}

function setupShare() {
  // ── ··· menu toggle ──
  const moreBtn      = document.getElementById('more-btn');
  const moreMenu     = document.getElementById('more-menu');
  const moreBackdrop = document.getElementById('more-backdrop');

  function openMoreMenu() {
    moreMenu.hidden     = false;
    moreBackdrop.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMoreMenu() {
    moreMenu.hidden     = true;
    moreBackdrop.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  moreBtn?.addEventListener('click', e => {
    e.stopPropagation();
    moreMenu.hidden ? openMoreMenu() : closeMoreMenu();
  });
  // Backdrop vangt tikken buiten het menu op — werkt ook op iOS Safari
  moreBackdrop?.addEventListener('click', closeMoreMenu);

  // ── Exporteer ──
  document.getElementById('export-btn')?.addEventListener('click', async () => {
    closeMoreMenu();
    const payload = {
      app:         'peaks-pois',
      version:     1,
      exported_at: new Date().toISOString(),
      starred:     [...starredIds],
      notes:       getAllNotes(),
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const date = new Date().toISOString().slice(0, 10);
    const file = new File([blob], `peaks-pois-${date}.json`, { type: 'application/json' });

    // Web Share API (iOS deelvenster → AirDrop/WhatsApp/…)
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Peaks POIs — Favorieten & Notities' });
      } catch (e) {
        if (e.name !== 'AbortError') fallbackDownload(blob, file.name);
      }
    } else {
      fallbackDownload(blob, file.name);
    }
  });

  // ── Importeer ──
  document.getElementById('import-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    closeMoreMenu();
    if (!file) return;

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      showToast('❌ Ongeldig bestand — geen geldige JSON.', true);
      return;
    }

    if (data.app !== 'peaks-pois' || data.version !== 1) {
      showToast('❌ Ongeldig bestand — niet van deze app.', true);
      return;
    }

    let addedStars = 0, mergedNotes = 0;

    // Favorieten samenvoegen (unie — idempotent)
    for (const id of data.starred ?? []) {
      if (typeof id === 'string' && !starredIds.has(id)) {
        starredIds.add(id);
        addedStars++;
      }
    }
    if (addedStars > 0) saveStarred();

    // Notities samenvoegen
    const exportDate = data.exported_at
      ? new Date(data.exported_at).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'import';

    for (const [poiId, incoming] of Object.entries(data.notes ?? {})) {
      if (!incoming?.trim()) continue;
      const existing = getNote(poiId);
      if (!existing) {
        // Nieuw — gewoon opslaan
        saveNote(poiId, incoming.trim());
        mergedNotes++;
      } else if (existing.includes(incoming.trim())) {
        // Al aanwezig (ook bij dubbel importeren) — overslaan
      } else {
        // Beide hebben een andere notitie — samenvoegen
        saveNote(poiId, `${existing}\n\n— ${exportDate} —\n${incoming.trim()}`);
        mergedNotes++;
      }
    }

    applyFilters(); // herrender lijst (badges bijwerken)

    const parts = [];
    if (addedStars > 0)  parts.push(`${addedStars} favoriet${addedStars > 1 ? 'en' : ''} toegevoegd`);
    if (mergedNotes > 0) parts.push(`${mergedNotes} notitie${mergedNotes > 1 ? 's' : ''} samengevoegd`);
    showToast(parts.length ? `✅ ${parts.join(', ')}.` : '✅ Niets nieuws — alles was al aanwezig.');
  });
}

function fallbackDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Cache-voortgang ───────────────────────────────────────────────────────────

function showCacheStatus(pct) {
  const el   = document.getElementById('cache-status');
  const fill = document.getElementById('cache-status-fill');
  const text = document.getElementById('cache-status-text');
  if (!el) return;

  el.style.display  = 'flex';
  el.style.opacity  = '1';
  fill.style.width  = `${pct}%`;

  if (pct >= 100) {
    text.textContent = '✅ Volledig offline beschikbaar';
    el.classList.add('cache-complete');
  } else {
    text.textContent = `📥 Offline data: ${pct}%`;
    el.classList.remove('cache-complete');
  }
}

async function checkCacheStatus() {
  if (!('caches' in window)) return;
  try {
    const cacheNames = await caches.keys();
    const peaksCache = cacheNames.find(n => n.startsWith('peaks-pois-'));
    if (!peaksCache) return;

    const [tileUrls, cache] = await Promise.all([
      fetch('map-tiles.json').then(r => r.json()),
      caches.open(peaksCache),
    ]);
    const cachedKeys = await cache.keys();
    const cachedSet  = new Set(cachedKeys.map(r => r.url));

    const total = tileUrls.length;
    const done  = tileUrls.filter(url => cachedSet.has(url)).length;
    const pct   = Math.round(done / total * 100);

    if (pct >= 100) {
      // Alles al gecached — toon bevestiging, geen download nodig
      showCacheStatus(100);
      return;
    }

    // Nog niet volledig gecached — check verbindingstype
    _cachedPct = pct;
    const conn = getConnectionType();
    if (conn === 'wifi') {
      // WiFi: automatisch starten
      showCacheStatus(pct);
      startTileCaching();
    } else {
      // Mobiele data of onbekend: vraag toestemming
      showCachePrompt();
    }
  } catch (_) {
    // Stil falen — niet kritiek
  }
}

// ── Offline-banner ────────────────────────────────────────────────────────────

function setupOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  function update() {
    banner.classList.toggle('show', !navigator.onLine);
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ── Filter-chips ──────────────────────────────────────────────────────────────

function setupFilters() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeCategory = chip.dataset.cat;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      applyFilters();
    });
  });
}

// ── Zoeken ────────────────────────────────────────────────────────────────────

function setupSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', () => {
    searchQuery = input.value.trim().toLowerCase();
    applyFilters();
  });
}

// ── Filter + render ───────────────────────────────────────────────────────────

function applyFilters() {
  filtered = allPois.filter(poi => {
    if (activeCategory === 'starred') {
      if (!isStarred(poi.osm_id, poi.osm_type)) return false;
    } else if (activeCategory === 'noted') {
      if (!getNote(poi.id)) return false;
    } else if (activeCategory !== 'all' && poi.category !== activeCategory) return false;
    if (searchQuery) {
      const haystack = [
        poi.name,
        poi.description_en ?? '',
        poi.description ?? '',
        ...(poi.reviews ?? []).map(r => r.text_en ?? r.text ?? ''),
      ].join(' ').toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });

  // Sorteer: als locatie bekend, op afstand; anders op km langs route
  if (userLat !== null) {
    filtered.sort((a, b) => haversine(userLat, userLon, a.lat, a.lon) - haversine(userLat, userLon, b.lat, b.lon));
  }
  // (Standaard al gesorteerd op distance_along_route_km vanuit data.json)

  renderList();
  updateMapMarkers();
  document.getElementById('stats').textContent =
    `${filtered.length} van ${allPois.length} locaties${userLat ? ' — gesorteerd op afstand van jou' : ''}`;
}

// ── POI-lijst renderen ────────────────────────────────────────────────────────

function renderList() {
  const list = document.getElementById('list');
  const noResults = document.getElementById('no-results');

  if (filtered.length === 0) {
    list.innerHTML = '';
    noResults.classList.add('show');
    return;
  }
  noResults.classList.remove('show');

  list.innerHTML = filtered.map(poi => {
    const thumb = poi.photos?.[0]
      ? `<img class="poi-thumb" src="${esc(poi.photos[0])}" loading="lazy" alt="" onerror="this.style.display='none'">`
      : `<div class="poi-thumb-placeholder">${categoryEmoji(poi.category)}</div>`;

    const topReview = poi.reviews?.[0];
    const note = getNote(poi.id);
    const snippet = activeCategory === 'noted' && note
      ? note.slice(0, 90) + (note.length > 90 ? '…' : '')
      : topReview
        ? `"${(topReview.text_en || topReview.text || '').slice(0, 90)}…"`
        : (poi.description_en || poi.description || '');

    const starsHtml = poi.rating_stars
      ? `<span class="stars">${starsString(poi.rating_stars)}</span> <span style="font-size:.75rem;color:var(--text2)">${poi.rating_stars.toFixed(1)} (${poi.review_count})</span>`
      : (poi.review_count > 0 ? `<span style="font-size:.75rem;color:var(--text2)">${poi.review_count} review${poi.review_count > 1 ? 's' : ''}</span>` : '');

    const starBadge = isStarred(poi.osm_id, poi.osm_type)
      ? `<span class="poi-star-badge" title="Favoriet">★</span>` : '';
    const noteBadge = getNote(poi.id)
      ? `<span class="poi-note-badge" title="Notitie">📝</span>` : '';

    return `
      <div class="poi-card" onclick="openDetail(${poi.osm_id},'${poi.osm_type}')">
        <div class="poi-card-inner">
          ${thumb}
          <div class="poi-info">
            <div class="poi-name">${esc(poi.name)}${starBadge}${noteBadge}</div>
            <div class="poi-meta">
              <span class="cat-badge ${poi.category}">${poiLabel(poi)}</span>
              <span class="poi-km">km ${poi.distance_along_route_km}</span>
              ${starsHtml}
            </div>
            ${snippet ? `<div class="poi-snippet">${esc(snippet)}</div>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Detail-weergave ───────────────────────────────────────────────────────────

window.openDetail = function(osmId, osmType) {
  const poi = allPois.find(p => p.osm_id == osmId && p.osm_type === osmType);
  if (!poi) return;

  const detail = document.getElementById('detail');

  // Mini-kaart — interactief Leaflet-kaartje (vervangt statisch tile-plaatje)
  const tileHtml = `<div id="detail-mini-map"></div>`;

  // Foto-carousel — combineer Mapy + Google foto's, klikbaar voor lightbox
  _lbPhotos = [
    ...(poi.photos ?? []).map((url, i) => ({ url, date: poi.photo_dates?.[i] ?? null, source: 'mapy' })),
    ...(poi.google_photos ?? []).map(url => ({ url, date: null, source: 'google' })),
  ];
  const photosHtml = _lbPhotos.length > 0
    ? `<div id="detail-photos">${_lbPhotos.map((p, i) =>
        `<div class="photo-wrap${p.source === 'google' ? ' google-photo' : ''}" onclick="openLightbox(${i})">
           <img src="${esc(p.url)}" loading="lazy" alt="" onerror="this.parentNode.style.display='none'">
           ${p.date ? `<span class="photo-date">${formatPhotoDate(p.date)}</span>` : ''}
         </div>`
      ).join('')}</div>`
    : '';

  // Beschrijving
  const desc = poi.description_en || poi.description;
  const descHtml = desc ? `<p class="detail-desc">${esc(desc)}</p>` : '';

  // Tags (website, telefoon, openingsuren, …) — interne OSM-tags weggefilterd
  const DISPLAY_TAGS = new Set(['website', 'phone', 'email', 'opening_hours', 'fee',
    'drinking_water', 'ele', 'operator', 'addr:city', 'capacity', 'access']);
  const tagEntries = Object.entries(poi.tags ?? {}).filter(([k]) => DISPLAY_TAGS.has(k));

  // Normaliseer een telefoonnummer naar enkel cijfers voor vergelijking
  function normalizePhone(s) { return s ? String(s).replace(/\D/g, '').slice(-9) : ''; }
  function normalizeUrl(s)   { return s ? String(s).replace(/^https?:\/\//i,'').replace(/\/$/,'').toLowerCase() : ''; }

  // Bestaande OSM-waarden
  const osmPhone   = poi.tags?.phone ?? poi.tags?.['contact:phone'] ?? null;
  const osmWebsite = poi.tags?.website ?? poi.tags?.['contact:website'] ?? null;

  // Extra Google-tags tonen als ze niet al in OSM zitten
  const googleExtraHtml = [
    // Telefoon
    poi.google_phone && normalizePhone(poi.google_phone) !== normalizePhone(osmPhone)
      ? `<span class="tag tag-google">📞 Tel: ${esc(poi.google_phone)} <span class="tag-google-badge">G</span></span>`
      : null,
    // Website
    poi.google_website && normalizeUrl(poi.google_website) !== normalizeUrl(osmWebsite)
      ? `<span class="tag tag-google">🌐 <a href="${esc(poi.google_website)}" target="_blank" rel="noopener">${esc(poi.google_website.replace(/^https?:\/\//i,''))}</a> <span class="tag-google-badge">G</span></span>`
      : null,
  ].filter(Boolean).join('');

  const tagsHtml = (tagEntries.length > 0 || googleExtraHtml)
    ? `<div class="tag-list">
        ${tagEntries.map(([k, v]) => `<span class="tag">${esc(tagLabel(k))}: ${esc(k === 'ele' ? v + ' m' : v)}</span>`).join('')}
        ${googleExtraHtml}
       </div>`
    : '';

  // Coördinaten-tag altijd tonen
  const coordsHtml = `<div class="tag-list">
    <span class="tag">📍 ${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}</span>
    <span class="tag">km ${poi.distance_along_route_km} langs route</span>
  </div>`;

  // Reviews — tabs voor Mapy.cz en Google
  const reviewsHtml = buildReviewsSection(poi);

  // Mapy.cz deeplink
  const mapyUrl   = poi.mapy_url ?? `https://mapy.com/en/turisticka?x=${poi.lon}&y=${poi.lat}&z=16`;
  const googleUrl = poi.google_place_id
    ? `https://www.google.com/maps/place/?q=place_id:${poi.google_place_id}`
    : `https://www.google.com/maps/search/?api=1&query=${poi.lat},${poi.lon}`;

  const openBtn = `
    <div id="open-btns">
      <a class="open-btn open-btn-mapy" href="${esc(mapyUrl)}" target="_blank" rel="noopener">
        Open op Mapy.cz
      </a>
      <a class="open-btn open-btn-google" href="${esc(googleUrl)}" target="_blank" rel="noopener">
        Open op Google Maps
      </a>
    </div>
    <p class="open-btns-note">Vereist internet</p>
  `;

  const starsHtml = poi.rating_stars
    ? `<span class="stars">${starsString(poi.rating_stars)}</span>
       <span style="font-size:.82rem;color:var(--text2)">${poi.rating_stars.toFixed(1)} / 5 · ${poi.review_count} reviews</span>
       ${poi.rating_caption ? `<span style="font-size:.78rem;color:var(--accent)">${esc(poi.rating_caption)}</span>` : ''}`
    : '';

  const poiStarred = isStarred(poi.osm_id, poi.osm_type);
  detail.innerHTML = `
    <div id="detail-back">
      <button onclick="closeDetail()" aria-label="Terug">‹</button>
      <h2>${esc(poi.name)}</h2>
      <span class="cat-badge ${poi.category}">${poiLabel(poi)}</span>
      <button id="detail-star-btn" class="${poiStarred ? 'starred' : ''}"
        onclick="toggleStar(${poi.osm_id},'${poi.osm_type}')"
        title="${poiStarred ? 'Verwijder uit favorieten' : 'Voeg toe aan favorieten'}"
        aria-label="${poiStarred ? 'Verwijder uit favorieten' : 'Voeg toe aan favorieten'}">
        ${poiStarred ? '★' : '☆'}
      </button>
    </div>

    ${tileHtml}
    ${photosHtml}

    <div id="detail-info">
      <div class="detail-meta">
        ${starsHtml}
      </div>
      ${descHtml}
      ${tagsHtml}
      ${coordsHtml}
      ${reviewsHtml}
      ${openBtn}
      <div id="detail-notes-section">
        <h3 class="detail-section-title">📝 Mijn notitie</h3>
        <textarea id="detail-note-input" placeholder="Persoonlijke notitie over dit POI…" rows="3"></textarea>
      </div>
      <div style="height: calc(var(--safe-bottom) + 20px)"></div>
    </div>
  `;

  detail.classList.add('open');
  detail.scrollTop = 0;
  document.body.style.overflow = 'hidden';

  // ── Notitie laden en auto-opslaan ──
  const noteInput = document.getElementById('detail-note-input');
  noteInput.value = getNote(poi.id);
  let _noteTimer;
  noteInput.addEventListener('input', () => {
    clearTimeout(_noteTimer);
    _noteTimer = setTimeout(() => saveNote(poi.id, noteInput.value), 400);
  });

  // ── Interactieve mini-kaart initialiseren ──
  // Verwijder vorige instantie (als je snel tussen POIs wisselt)
  if (_detailMap) { _detailMap.remove(); _detailMap = null; }

  requestAnimationFrame(() => {
    const miniMap = L.map('detail-mini-map', {
      zoomControl:     true,
      scrollWheelZoom: false,   // geen ongewenste zoom bij scrollen
      tap:             true,    // iOS touch support
    }).setView([poi.lat, poi.lon], 15);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:       19,
      maxNativeZoom: 17,   // Boven zoom 17 schalen we de tile op (offline-veilig)
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    }).addTo(miniMap);

    // GPX-route als rode lijn
    if (window._routeData) {
      L.geoJSON(window._routeData, {
        style: { color: '#e8433a', weight: 3, opacity: 0.75 },
      }).addTo(miniMap);
    }

    // POI-marker (kleur per categorie)
    const poiColor = CAT_COLORS[poi.category] ?? '#9E9E9E';
    L.circleMarker([poi.lat, poi.lon], {
      radius:      10,
      fillColor:   poiColor,
      color:       '#fff',
      weight:      2,
      opacity:     1,
      fillOpacity: 1,
    }).addTo(miniMap);

    // Eigen GPS-locatie tonen als blauwe stip (indien bekend)
    if (userLat !== null) {
      L.circleMarker([userLat, userLon], {
        radius:      7,
        fillColor:   '#4285f4',
        color:       '#fff',
        weight:      2,
        opacity:     1,
        fillOpacity: 0.9,
      }).addTo(miniMap);
    }

    miniMap.invalidateSize();
    _detailMap = miniMap;
  });
};

window.closeDetail = function() {
  if (_detailMap) { _detailMap.remove(); _detailMap = null; }
  document.getElementById('detail').classList.remove('open');
  document.body.style.overflow = '';
};

// Swipe-to-close op detail (iOS-gevoel)
(function() {
  let startY = 0;
  document.addEventListener('touchstart', e => {
    if (document.getElementById('detail').classList.contains('open')) {
      startY = e.touches[0].clientY;
    }
  });
  document.addEventListener('touchend', e => {
    if (!document.getElementById('detail').classList.contains('open')) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 80 && document.getElementById('detail').scrollTop < 5) {
      closeDetail();
    }
  });
})();

// ── Weergave-tabs ─────────────────────────────────────────────────────────────

function setupViewTabs() {
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.view;
      document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const listEl    = document.getElementById('list');
      const statsEl   = document.getElementById('stats');
      const filtersEl = document.getElementById('filters');
      const mapView   = document.getElementById('map-view');
      const locateBtn = document.getElementById('locate-btn');

      if (activeView === 'map') {
        listEl.style.display   = 'none';
        statsEl.style.display  = 'none';
        mapView.style.display  = 'block';
        locateBtn.style.bottom = 'calc(var(--safe-bottom) + 20px)';
        // Bereken header-hoogte dynamisch zodat de kaart er naadloos onder begint,
        // ook als de filter-chips zichtbaar blijven.
        requestAnimationFrame(() => {
          mapView.style.top = document.getElementById('header').offsetHeight + 'px';
        });
        initMap();
      } else {
        listEl.style.display  = '';
        statsEl.style.display = '';
        mapView.style.display = 'none';
      }
    });
  });
}

// ── Leaflet kaart ─────────────────────────────────────────────────────────────

const CAT_COLORS = {
  accommodation: '#FF6B35',
  water:         '#29B6F6',
  food:          '#E91E63',
  sights:        '#66BB6A',
};

function initMap() {
  if (leafletMap) {
    // Al geïnitialiseerd — refresh markers voor actieve filter
    leafletMap.invalidateSize();
    updateMapMarkers();
    return;
  }

  // Centreer op middelpunt van de route
  const allCoords = window._routeData?.geometry?.coordinates ?? [];
  const midIdx    = Math.floor(allCoords.length / 2);
  const center    = allCoords.length > 0
    ? [allCoords[midIdx][1], allCoords[midIdx][0]]
    : [42.5, 19.9];

  leafletMap = L.map('map', { zoomControl: true }).setView(center, 12);

  // OSM tiles — worden gecached door service worker na eerste gebruik
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom:       19,
    maxNativeZoom: 17,   // Boven zoom 17 schalen we de tile op (offline-veilig)
    crossOrigin: true,
  }).addTo(leafletMap);

  // Route tekenen
  if (window._routeData) {
    L.geoJSON(window._routeData, {
      style: { color: '#7c6af5', weight: 3, opacity: 0.85 },
    }).addTo(leafletMap);
  }

  updateMapMarkers();

  // Pas kaart aan als GPS al bekend is
  if (userLat !== null) updateUserMarker(userLat, userLon);
}

/**
 * Geeft border-kleur + dikte op basis van de sterren-score én het aantal reviews.
 *   geen reviews (count=0 of stars null/0) → wit   (onbeoordeeld)
 *   ≥ 4.0 sterren                          → goud  (toplocatie)
 *   3.0–4.0 sterren                        → grijs (gemiddeld)
 *   < 3.0 sterren                          → rood  (lage score)
 */
function ratingBorder(stars, reviewCount) {
  if (!reviewCount || !stars) return { color: '#ffffff', weight: 1.5 }; // geen reviews
  if (stars >= 4.0)           return { color: '#FFD700', weight: 2.5 }; // goud ★★★★+
  if (stars >= 3.0)           return { color: '#9E9E9E', weight: 2.0 }; // grijs ★★★
  return                       { color: '#EF5350', weight: 2.5 };        // rood  ★★☆
}

function updateMapMarkers() {
  if (!leafletMap) return;

  // Verwijder oude markers
  for (const { marker } of poiMarkers) marker.remove();
  poiMarkers = [];

  // Voeg gefilterde POIs toe als markers (zelfde filter als de lijst)
  for (const poi of filtered) {
    const color  = CAT_COLORS[poi.category] ?? '#9E9E9E';
    const border = ratingBorder(poi.rating_stars, poi.review_count);

    // Accommodatie → divIcon met subtype-emoji; overige → circleMarker
    let marker;
    if (poi.category === 'accommodation') {
      const emoji = ACCOM_EMOJI[accomSubtype(poi)] ?? '🏕';
      marker = L.marker([poi.lat, poi.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="
            width:26px;height:26px;border-radius:50%;
            background:#FF6B35;
            display:flex;align-items:center;justify-content:center;
            font-size:13px;line-height:1;
            border:${border.weight}px solid ${border.color};
            box-shadow:0 1px 4px rgba(0,0,0,.5);
          ">${emoji}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
          popupAnchor: [0, -15],
        }),
      }).addTo(leafletMap);
    } else {
      marker = L.circleMarker([poi.lat, poi.lon], {
        radius: 8,
        fillColor: color,
        color: border.color,
        weight: border.weight,
        opacity: 1,
        fillOpacity: 0.9,
      }).addTo(leafletMap);
    }

    const starsStr = poi.rating_stars
      ? `${'★'.repeat(Math.round(poi.rating_stars))} ${poi.rating_stars.toFixed(1)}`
      : (poi.review_count > 0 ? `${poi.review_count} review${poi.review_count > 1 ? 's' : ''}` : '');

    marker.bindPopup(`
      <div class="map-popup-name">${esc(poi.name)}</div>
      <div class="map-popup-meta">
        ${poiLabel(poi)} · km ${poi.distance_along_route_km}
        ${starsStr ? `· ${starsStr}` : ''}
      </div>
      <button class="map-popup-btn" onclick="openDetail(${poi.osm_id},'${poi.osm_type}')">
        Bekijk reviews & foto's
      </button>
    `, { maxWidth: 220 });

    poiMarkers.push({ marker, poi });
  }
}

function updateUserMarker(lat, lon) {
  if (!leafletMap) return;

  if (userMarker) userMarker.remove();

  // Pulserende blauwe stip voor huidige locatie
  const icon = L.divIcon({
    className: '',
    html: '<div class="location-pulse"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 })
    .addTo(leafletMap)
    .bindPopup('<b>📍 Jij bent hier</b>');
}

// ── GPS-locatieknop ────────────────────────────────────────────────────────────

function setupLocate() {
  const btn = document.getElementById('locate-btn');
  if (!navigator.geolocation) { btn.style.display = 'none'; return; }

  btn.addEventListener('click', () => {
    btn.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLat = pos.coords.latitude;
        userLon = pos.coords.longitude;
        btn.textContent = '📍';

        // Update kaartmarker + zoom naar locatie
        updateUserMarker(userLat, userLon);
        if (leafletMap && activeView === 'map') {
          leafletMap.setView([userLat, userLon], Math.max(leafletMap.getZoom(), 14));
        }

        // Sorteer lijst op afstand
        applyFilters();
      },
      () => { btn.textContent = '📍'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ── Hulpfuncties ──────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function starsString(rating) {
  const full = Math.round(rating);
  return '★'.repeat(Math.min(5, Math.max(0, full))) + '☆'.repeat(Math.max(0, 5 - full));
}

function categoryLabel(cat) {
  return { accommodation: '🏕 Slaap', water: '💧 Water', food: '🍽 Eten', sights: '🏔 Zien' }[cat] ?? cat;
}

function categoryEmoji(cat) {
  return { accommodation: '🏕', water: '💧', food: '🍽', sights: '🏔' }[cat] ?? '📍';
}

/**
 * Leidt het slaap-subtype af uit de OSM-tag tourism=*
 * Geen rebuild nodig — poi.tags is al beschikbaar.
 */
function accomSubtype(poi) {
  const t = poi.tags?.tourism;
  const a = poi.tags?.amenity;
  if (t === 'alpine_hut')     return 'hut';
  if (t === 'wilderness_hut') return 'wilderness';
  if (a === 'shelter')        return 'shelter';
  if (t === 'hotel')          return 'hotel';
  if (t === 'camp_site' || poi.tags?.leisure === 'camp_site') {
    return (poi.tags?.backcountry === 'yes' || poi.tags?.informal === 'yes')
      ? 'wild' : 'camping';
  }
  return 'guesthouse'; // guest_house, hostel, chalet
}

const ACCOM_LABELS = {
  hut:        '🏔 Berghut',
  wilderness: '🛖 Onbem. hut',
  shelter:    '🏕 Schuilplaats',
  camping:    '⛺ Camping',
  wild:       '🌿 Wild kamperen',
  guesthouse: '🏠 Guesthouse',
  hotel:      '🏨 Hotel',
};
const ACCOM_EMOJI = {
  hut: '🏔', wilderness: '🛖', shelter: '🏕', camping: '⛺', wild: '🌿', guesthouse: '🏠', hotel: '🏨',
};

function accomLabel(poi) {
  return ACCOM_LABELS[accomSubtype(poi)] ?? '🏕 Slaap';
}

/** Label voor lijst, kaart-popup en detail — subtype als het accommodation is, anders generiek */
function poiLabel(poi) {
  if (poi.category === 'accommodation') return accomLabel(poi);
  // Sights subtypes
  if (poi.tags?.natural === 'cave_entrance') return '🕳 Grot';
  if (poi.tags?.natural === 'hot_spring')    return '♨️ Warmwaterbron';
  if (poi.tags?.natural === 'gorge')         return '🏞 Kloof';
  if (poi.tags?.historic === 'ruins')        return '🏚 Ruïne';
  // Water subtypes
  if (poi.tags?.amenity === 'toilets')       return '🚻 Toilet';
  // Food subtypes
  if (poi.tags?.amenity === 'snack_bar')     return '🥪 Snackbar';
  return categoryLabel(poi.category);
}

function tagLabel(key) {
  const map = {
    website: '🌐 Website', phone: '📞 Tel', email: '✉ Email',
    opening_hours: '🕐 Uren', fee: '💶 Prijs', drinking_water: '💧 Drinkwater',
    ele: '⛰ Hoogte', operator: '🏢 Beheerder', 'addr:city': '🏙 Stad',
    capacity: '🛏 Capaciteit', access: '🚪 Toegang',
  };
  return map[key] ?? key;
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('nl-BE', { year: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Reviews-sectie met tabs ───────────────────────────────────────────────────

function buildReviewsSection(poi) {
  const hasMapy   = (poi.reviews ?? []).length > 0;
  const hasGoogle = (poi.google_reviews ?? []).length > 0;

  if (!hasMapy && !hasGoogle) {
    return `<p style="color:var(--text2);font-size:.85rem;margin-top:8px">Geen reviews gevonden voor deze locatie.</p>`;
  }

  const showTabs = hasMapy && hasGoogle;

  // ── Tab-knoppen ──
  const tabsHtml = showTabs ? `
    <div class="review-tabs">
      <button class="review-tab active" data-source="mapy" onclick="switchReviewTab('mapy')">
        📍 Mapy.cz <span class="tab-count">(${poi.review_count})</span>
      </button>
      <button class="review-tab" data-source="google" onclick="switchReviewTab('google')">
        <span class="google-attr-g">G</span> Google
        <span class="tab-count">(${poi.google_reviews.length})</span>
      </button>
    </div>` : '';

  // ── Mapy-reviews ──
  const mapyHtml = hasMapy ? `
    <div id="mapy-reviews-section">
      ${!showTabs ? `<div id="detail-reviews-title">${poi.review_count} reviews via Mapy.cz</div>` : ''}
      ${poi.reviews.map(r => {
        const langBadge = r.was_translated && r.lang_original
          ? `<span style="font-size:.68rem;background:var(--bg3);padding:1px 5px;border-radius:4px;color:var(--text2)">vertaald uit ${r.lang_original.toUpperCase()}</span>`
          : '';
        const posNeg = (r.positives || r.negatives)
          ? `${r.positives ? `<div style="color:#66bb6a;font-size:.82rem;margin-top:4px">👍 ${esc(r.positives)}</div>` : ''}
             ${r.negatives ? `<div style="color:#ef5350;font-size:.82rem;margin-top:2px">👎 ${esc(r.negatives)}</div>` : ''}`
          : '';
        return `
          <div class="review-card">
            <div class="review-header">
              <span class="review-author">${esc(r.author)} ${langBadge}</span>
              <span class="review-date">${r.stars ? starsString(r.stars) + ' ' : ''}${r.date ? formatDate(r.date) : ''}</span>
            </div>
            <div class="review-english">${esc(r.text_en || r.text || '')}</div>
            ${posNeg}
          </div>`;
      }).join('')}
    </div>` : '';

  // ── Google-reviews ──
  const googleHtml = hasGoogle ? `
    <div id="google-reviews-section"${showTabs ? ' style="display:none"' : ''}>
      ${!showTabs ? `<div id="detail-reviews-title">${poi.google_reviews.length} reviews via Google Maps</div>` : ''}
      <div class="google-attr">
        <span class="google-attr-g">G</span> Reviews van Google Maps
        ${poi.google_rating ? `· <span class="stars">${starsString(Math.round(poi.google_rating))}</span> ${poi.google_rating.toFixed(1)} (${poi.google_total_ratings ?? 0} totaal)` : ''}
      </div>
      ${poi.google_reviews.map(r => {
        const langBadge = r.translated_from
          ? `<span style="font-size:.68rem;background:var(--bg3);padding:1px 5px;border-radius:4px;color:var(--text2)">vertaald uit ${r.translated_from.toUpperCase()}</span>`
          : '';
        return `
        <div class="review-card">
          <div class="review-header">
            <span class="review-author">${esc(r.author)} ${langBadge}</span>
            <span class="review-date">${r.rating ? starsString(r.rating) + ' ' : ''}${r.relative_time ?? (r.date ? formatDate(r.date) : '')}</span>
          </div>
          <div class="review-english">${esc(r.text || '')}</div>
        </div>`;
      }).join('')}
    </div>` : '';

  return tabsHtml + mapyHtml + googleHtml;
}

window.switchReviewTab = function(source) {
  document.querySelectorAll('#detail .review-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.source === source));
  const m = document.getElementById('mapy-reviews-section');
  const g = document.getElementById('google-reviews-section');
  if (m) m.style.display = source === 'mapy'   ? '' : 'none';
  if (g) g.style.display = source === 'google' ? '' : 'none';
};

// ── Lightbox ──────────────────────────────────────────────────────────────────

function setupLightbox() {
  const lb   = document.getElementById('lightbox');
  const prev = document.getElementById('lightbox-prev');
  const next = document.getElementById('lightbox-next');

  prev.addEventListener('click', e => { e.stopPropagation(); lbGo(_lbIndex - 1); });
  next.addEventListener('click', e => { e.stopPropagation(); lbGo(_lbIndex + 1); });

  // Tik op achtergrond → sluiten (niet als ingezoomd, niet direct na dubbeltik)
  lb.addEventListener('click', e => {
    if (_lbSuppressClose || _lbScale > 1) return;
    if (e.target === lb || e.target.id === 'lightbox-img') closeLightbox();
  });

  // ── Touch: swipe, pinch-zoom, pan, dubbeltik ──────────────────────────────
  let swipeStartX = 0;
  let pinchStartDist = 0, pinchScaleAtStart = 1;
  let panStartX = 0, panStartY = 0, panTxAtStart = 0, panTyAtStart = 0;
  let lastTapTime = 0, touchMoved = false;

  lb.addEventListener('touchstart', e => {
    touchMoved = false;
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      pinchStartDist    = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      pinchScaleAtStart = _lbScale;
    } else if (e.touches.length === 1) {
      swipeStartX  = e.touches[0].clientX;
      panStartX    = e.touches[0].clientX;
      panStartY    = e.touches[0].clientY;
      panTxAtStart = _lbTransX;
      panTyAtStart = _lbTransY;
    }
  }, { passive: false });

  lb.addEventListener('touchmove', e => {
    touchMoved = true;
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      _lbScale = Math.max(1, Math.min(6, pinchScaleAtStart * dist / pinchStartDist));
      lbApplyTransform();
    } else if (e.touches.length === 1 && _lbScale > 1) {
      e.preventDefault();
      _lbTransX = panTxAtStart + (e.touches[0].clientX - panStartX) / _lbScale;
      _lbTransY = panTyAtStart + (e.touches[0].clientY - panStartY) / _lbScale;
      lbApplyTransform();
    }
  }, { passive: false });

  lb.addEventListener('touchend', e => {
    // Dubbeltik: inzoomen op 2.5× of terugzetten
    if (!touchMoved && e.changedTouches.length === 1) {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        _lbSuppressClose = true;
        setTimeout(() => { _lbSuppressClose = false; }, 150);
        _lbScale > 1 ? lbResetZoom() : lbZoomTo(2.5);
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;
    }
    // Swipe navigatie (alleen als niet ingezoomd)
    if (_lbScale <= 1 && e.changedTouches.length === 1) {
      const dx = e.changedTouches[0].clientX - swipeStartX;
      if (dx < -50) lbGo(_lbIndex + 1);
      if (dx >  50) lbGo(_lbIndex - 1);
    }
  });

  // Pijltjestoetsen + Escape (handig bij desktop-test)
  document.addEventListener('keydown', e => {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape')      closeLightbox();
    if (e.key === 'ArrowRight')  lbGo(_lbIndex + 1);
    if (e.key === 'ArrowLeft')   lbGo(_lbIndex - 1);
  });
}

function lbGo(index) {
  if (index < 0 || index >= _lbPhotos.length) return;
  _lbIndex = index;
  lbResetZoom();
  lbRender();
}

function lbApplyTransform() {
  const img = document.getElementById('lightbox-img');
  if (img) img.style.transform = `scale(${_lbScale}) translate(${_lbTransX}px, ${_lbTransY}px)`;
}

function lbResetZoom() {
  _lbScale = 1; _lbTransX = 0; _lbTransY = 0;
  const img = document.getElementById('lightbox-img');
  if (!img) return;
  img.style.transition = 'transform .25s ease';
  img.style.transform  = '';
  setTimeout(() => { img.style.transition = ''; }, 260);
}

function lbZoomTo(scale) {
  _lbScale = scale; _lbTransX = 0; _lbTransY = 0;
  const img = document.getElementById('lightbox-img');
  if (!img) return;
  img.style.transition = 'transform .2s ease';
  lbApplyTransform();
  setTimeout(() => { img.style.transition = ''; }, 210);
}

function lbRender() {
  const multi = _lbPhotos.length > 1;
  const p = _lbPhotos[_lbIndex];
  document.getElementById('lightbox-img').src = p.url;
  document.getElementById('lightbox-counter').textContent = `${_lbIndex + 1} / ${_lbPhotos.length}`;
  document.getElementById('lightbox-counter').classList.toggle('hidden', !multi);
  const dateEl = document.getElementById('lightbox-date');
  dateEl.textContent = p.date ? formatPhotoDate(p.date) : '';
  dateEl.classList.toggle('hidden', !p.date);
  document.getElementById('lightbox-prev').classList.toggle('hidden', _lbIndex === 0);
  document.getElementById('lightbox-next').classList.toggle('hidden', _lbIndex === _lbPhotos.length - 1);
}

function formatPhotoDate(dateStr) {
  if (!dateStr) return '';
  // dateStr is "2024-07-17" (of "2024-07-17T18:54:31" — we nemen de eerste 10 tekens)
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
}

window.openLightbox = function(index) {
  _lbIndex = index;
  lbRender();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
};

window.closeLightbox = function() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
  lbResetZoom();
  document.body.style.overflow = '';
};

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
