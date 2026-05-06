/**
 * download-posters.js
 * Downloads TMDB posters for all cached movies to public/posters/{tmdbId}.jpg
 * Run once: node download-posters.js
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, 'tmdb-cache.json');
const POSTER_DIR = join(__dirname, 'public', 'posters');
const TMDB_BASE  = 'https://image.tmdb.org/t/p/w342';
const CONCURRENT = 8;

if (!existsSync(POSTER_DIR)) mkdirSync(POSTER_DIR, { recursive: true });

const cache   = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
const entries = Object.values(cache).filter(v => v?.tmdbId && v?.posterPath);

console.log(`🎬 ${entries.length} posters to download → public/posters/\n`);

let done = 0, skipped = 0, failed = 0;
const total = entries.length;

async function downloadOne({ tmdbId, mediaType, posterPath }) {
  const posterId = mediaType === 'tv' ? `tv-${tmdbId}` : String(tmdbId);
  const file = join(POSTER_DIR, `${posterId}.jpg`);
  if (existsSync(file)) { skipped++; return; }

  try {
    const res = await fetch(`${TMDB_BASE}${posterPath}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    writeFileSync(file, Buffer.from(buf));
    done++;
  } catch (e) {
    failed++;
  }
}

// Process in batches of CONCURRENT with a small delay between batches (only when actually downloading)
for (let i = 0; i < entries.length; i += CONCURRENT) {
  const doneBefore = done;
  await Promise.all(entries.slice(i, i + CONCURRENT).map(downloadOne));
  const n   = Math.min(i + CONCURRENT, total);
  const pct = Math.round(n / total * 100);
  process.stdout.write(`\r  ${n}/${total} (${pct}%)  ✓ ${done} new  — ${skipped} already had  — ${failed} failed`);
  // Only pause between batches when we actually hit the network (avoids 18s sleep on recheck)
  if (doneBefore < done && i + CONCURRENT < entries.length) await new Promise(r => setTimeout(r, 80));
}

console.log(`\n\n✅ Done. ${done} downloaded, ${skipped} already existed, ${failed} failed.`);
if (done > 0) {
  const mb = Math.round(done * 25 / 1024);
  console.log(`   Approx. disk used: ~${mb} MB`);
}
