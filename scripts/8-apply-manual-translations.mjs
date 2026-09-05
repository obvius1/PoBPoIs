/**
 * Stap 8 — Handmatige vertalingen toepassen op web/data.json
 *
 * Waarom nodig:
 *   • Mapy.cz vertaalt met forceTranslation=true, maar slaat reviews over waarvan
 *     het de taal verkeerd detecteert (bv. Tsjechisch/Slowaaks zónder diakritische
 *     tekens wordt als "en" gemarkeerd) of die het te kort vindt.
 *   • Google Places-reviews (stap 3b) worden helemaal niet vertaald — die komen
 *     binnen in de originele taal.
 *
 * Dit script leest data/manual-translations.json en patcht web/data.json.
 * Draai het na elke build (staat in build-all.mjs), of los:
 *   node scripts/8-apply-manual-translations.mjs
 *
 * Matching gebeurt op auteur + exacte originele tekst, dus dezelfde review die
 * bij meerdere POIs voorkomt wordt overal gepatcht. Al vertaalde reviews worden
 * overgeslagen (idempotent).
 *
 * Output: web/data.json (in place) + SW-versie opnieuw gebumpt
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { log, ok, warn, ROOT, WEB_DIR } from './utils.mjs';

const overridesPath = join(ROOT, 'data', 'manual-translations.json');
const dataPath      = join(WEB_DIR, 'data.json');

if (!existsSync(overridesPath)) {
  warn('data/manual-translations.json niet gevonden — stap 8 overgeslagen.');
  process.exit(0);
}
if (!existsSync(dataPath)) {
  console.error('❌  web/data.json niet gevonden. Voer eerst stap 7 uit.');
  process.exit(1);
}

const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
const data      = JSON.parse(readFileSync(dataPath, 'utf8'));

const norm = s => (s ?? '').replace(/\r\n/g, '\n').trim();

let applied = 0, already = 0;
const unmatched = new Set(overrides.map((_, i) => i));

for (const poi of data.pois ?? []) {
  for (const [i, ov] of overrides.entries()) {
    // ── Mapy-reviews: text_en bevat de (onvertaalde) originele tekst ──
    if (ov.source === 'mapy') {
      for (const r of poi.reviews ?? []) {
        if (r.author !== ov.author) continue;
        if (norm(r.text_en) === norm(ov.english)) { already++; unmatched.delete(i); continue; }
        if (norm(r.text_en) !== norm(ov.original)) continue;
        r.text_original  = ov.original;
        r.text_en        = ov.english;
        r.lang_original  = ov.lang;
        r.was_translated = true;
        applied++;
        unmatched.delete(i);
      }
    }

    // ── Google-reviews: de app toont r.text rechtstreeks ──
    if (ov.source === 'google') {
      for (const g of poi.google_reviews ?? []) {
        if (g.author !== ov.author) continue;
        if (norm(g.text) === norm(ov.english)) { already++; unmatched.delete(i); continue; }
        if (norm(g.text) !== norm(ov.original)) continue;
        g.text_original   = ov.original;
        g.text            = ov.english;
        g.translated_from = ov.lang;
        applied++;
        unmatched.delete(i);
      }
    }
  }
}

for (const i of unmatched) {
  warn(`Geen match voor override #${i + 1} (${overrides[i].author}) — review verdwenen of tekst gewijzigd?`);
}

const outJson = JSON.stringify(data);
writeFileSync(dataPath, outJson, 'utf8');

// ── SW-versie opnieuw bumpen (identiek aan stap 7) ───────────────────────────
const dataHash = createHash('sha256').update(outJson).digest('hex').slice(0, 8);
const swPath   = join(WEB_DIR, 'sw.js');
if (existsSync(swPath)) {
  writeFileSync(swPath, readFileSync(swPath, 'utf8')
    .replace(/const CACHE_VERSION = '[^']*'/, `const CACHE_VERSION = 'build-${dataHash}'`), 'utf8');
  log(`  SW versie     : build-${dataHash}`);
}

ok('Stap 8 voltooid ✓');
log(`  Vertalingen toegepast : ${applied}`);
log(`  Al vertaald (overgeslagen) : ${already}`);
log(`  Overrides zonder match : ${unmatched.size}`);
