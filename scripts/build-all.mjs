/**
 * Voert alle 7 stappen in volgorde uit.
 * Gebruik `npm run build` om te starten.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { log, ok } from './utils.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const steps = [
  { script: '1-buffer.mjs',         label: 'Stap 1: GPX → zoekzone' },
  { script: '2-discover-pois.mjs',  label: 'Stap 2: POIs zoeken via Overpass' },
  { script: '2b-mapy-ids.mjs',      label: 'Stap 2b: Mapy.cz interne IDs ophalen' },
  { script: '3-fetch-reviews.mjs',  label: 'Stap 3: Mapy.cz reviews ophalen' },
  { script: '3b-google-reviews.mjs',label: 'Stap 3b: Google Places reviews + foto\'s' },
  { script: '4-download-photos.mjs',label: 'Stap 4: Foto\'s downloaden' },
  { script: '5-translate.mjs',      label: 'Stap 5: Reviews vertalen' },
  // Stap 6 (statische mini-tiles) vervangen door interactieve Leaflet mini-kaart in de app
  { script: '7-bundle.mjs',         label: 'Stap 7: data.json samenvoegen' },
  { script: '8-apply-manual-translations.mjs', label: 'Stap 8: handmatige vertalingen toepassen' },
];

const start = Date.now();
log('═══════════════════════════════════════════');
log(' Mapy.cz Offline Viewer — volledige build  ');
log('═══════════════════════════════════════════\n');

for (const step of steps) {
  log(`\n${'─'.repeat(50)}`);
  log(`▶  ${step.label}`);
  log('─'.repeat(50));

  const result = spawnSync('node', [`scripts/${step.script}`], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  if (result.status !== 0) {
    console.error(`\n❌  ${step.label} mislukt (exit code ${result.status})`);
    console.error('   Los het probleem op en run opnieuw — de voortgang is gecached.');
    process.exit(result.status ?? 1);
  }
}

const mins = ((Date.now() - start) / 60000).toFixed(1);
log(`\n${'═'.repeat(50)}`);
ok(`Volledige build voltooid in ${mins} minuten!`);
log(`${'═'.repeat(50)}`);
log('\n📱 Volgende stap: deploy web/ naar GitHub Pages (of Netlify)');
log('   en open de URL in Safari op je iPhone → Add to Home Screen\n');
