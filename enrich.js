// Standalone enrichment — run with: node enrich.js
// Does three things:
//   1. Enrich watchlist movies missing from cache (search + details)
//   2. Enrich rated/watched movies missing from cache (same)
//   3. Upgrade cache entries that are missing countries/language (details-only, fast)
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function latestDataDir(root) {
  const archiveDir = join(root, 'archive');
  if (!existsSync(archiveDir)) return root;
  const dirs = readdirSync(archiveDir).filter(d => statSync(join(archiveDir, d)).isDirectory()).sort();
  if (!dirs.length) return root;
  console.log(`📂 Using archive: archive/${dirs[dirs.length - 1]}`);
  return join(archiveDir, dirs[dirs.length - 1]);
}

const DATA_DIR = latestDataDir(__dirname);

try {
  const env = readFileSync(join(__dirname, '.env'), 'utf-8');
  for (const line of env.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch {}

const TMDB_KEY   = process.env.TMDB_API_KEY || '';
const TMDB_BASE  = 'https://api.themoviedb.org/3';
const CACHE_FILE = join(__dirname, 'tmdb-cache.json');
const THIS_YEAR  = new Date().getFullYear();

if (!TMDB_KEY) { console.error('❌  TMDB_API_KEY not set in .env'); process.exit(1); }

// Returns true if TMDB year differs too much from the Letterboxd year (likely a wrong match).
// Stricter for current/upcoming films than for historical ones.
function isSuspectYear(letterboxdYear, tmdbYear) {
  if (!letterboxdYear || !tmdbYear) return false;
  const diff      = Math.abs(letterboxdYear - tmdbYear);
  const threshold = letterboxdYear >= THIS_YEAR - 1 ? 1 : 3;
  return diff > threshold;
}

// ── Load ──────────────────────────────────────────────────────────────────────

function loadCSV(f) {
  return parse(readFileSync(join(DATA_DIR, f), 'utf-8'), { columns: true, skip_empty_lines: true });
}

const watchlist  = loadCSV('watchlist.csv');
let ratingsList  = [];
try { ratingsList = loadCSV('ratings.csv'); } catch {}

// Merge all movies, deduplicate by URI (watchlist takes priority for Name/Year)
const allMoviesMap = new Map();
ratingsList.forEach(m => allMoviesMap.set(m['Letterboxd URI'], m));
watchlist.forEach(m => allMoviesMap.set(m['Letterboxd URI'], m));
const allMovies = [...allMoviesMap.values()];

let cache = {};
if (existsSync(CACHE_FILE)) { try { cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch {} }

// Overrides: { "https://boxd.it/XXX": null } = skip, { "https://boxd.it/XXX": 12345 } = use this TMDB ID
let overrides = {};
try { overrides = JSON.parse(readFileSync(join(__dirname, 'tmdb-overrides.json'), 'utf-8')); } catch {}
// Strip comment keys
Object.keys(overrides).filter(k => k.startsWith('_')).forEach(k => delete overrides[k]);

// ── What needs doing? ─────────────────────────────────────────────────────────

const overrideUris = new Set(Object.keys(overrides));
// Re-process overrides only when the cached result is missing or the override ID changed.
// Also re-process suspect matches — TMDB may have added the film since the last run.
const toEnrich  = allMovies.filter(m => {
  const uri = m['Letterboxd URI'];
  const c = cache[uri];
  if (overrideUris.has(uri)) {
    if (!c?.tmdbId) return true;   // no result yet — try
    // Re-run only if the override value changed since we last cached it
    const ov = overrides[uri];
    if (!ov) return false;
    const expectedId = typeof ov === 'object' ? ov.id : ov;
    return c.tmdbId !== expectedId;
  }
  if (!c) return true;
  if (c.suspectMatch) return true;            // re-check in case TMDB now has the right film
  if (c.notFound && !c.tvFallbackTried) return true;  // retry notFound entries with TV search
  return !c.tmdbId && !c.notFound && !c.failed;
});
const toUpgrade = allMovies.filter(m => { const c = cache[m['Letterboxd URI']]; return c?.tmdbId && c.countries === undefined; });
// Only re-fetch recent movies (current year ±1) that are missing releaseDate — small targeted set
const toUpgradeRelease = allMovies.filter(m => {
  const year = parseInt(m['Year']) || 0;
  const c = cache[m['Letterboxd URI']];
  return c?.tmdbId && c.releaseDate === undefined && !toUpgrade.find(u => u['Letterboxd URI'] === m['Letterboxd URI']) && year >= THIS_YEAR - 1;
});
const alreadyOk = Object.values(cache).filter(v => v?.tmdbId && v.countries !== undefined).length;

console.log(`\n🎬 Movies total:   ${allMovies.length} (${watchlist.length} watchlist + ${ratingsList.length} rated)`);
console.log(`   To enrich:      ${toEnrich.length}`);
console.log(`   To upgrade:     ${toUpgrade.length} (add countries/language to existing entries)`);
if (toUpgradeRelease.length) console.log(`   Release dates:  ${toUpgradeRelease.length} recent movies missing release date`);
console.log(`   Already done:   ${alreadyOk}\n`);

if (!toEnrich.length && !toUpgrade.length && !toUpgradeRelease.length) {
  console.log('✓ Nothing to do — cache is complete and up to date.');
  process.exit(0);
}

// ── Rate-limited fetch ────────────────────────────────────────────────────────

let active = 0;
const MAX  = 6;
const q    = [];

function drain() {
  while (active < MAX && q.length) {
    const { url, resolve, reject, attempt } = q.shift();
    active++;
    fetch(url)
      .then(async res => {
        active--;
        if (res.status === 429) {
          const d = 2000 * Math.min((attempt || 0) + 1, 5);
          setTimeout(() => { q.unshift({ url, resolve, reject, attempt: (attempt||0)+1 }); drain(); }, d);
          return;
        }
        if (!res.ok) { reject(new Error(`HTTP ${res.status}`)); drain(); return; }
        resolve(await res.json());
        drain();
      })
      .catch(e => { active--; reject(e); drain(); });
  }
}
function tmdbFetch(url) { return new Promise((resolve, reject) => { q.push({ url, resolve, reject, attempt: 0 }); drain(); }); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildEntry(d) {
  return {
    tmdbId:      d.id,
    runtime:     d.runtime || null,
    overview:    d.overview || '',
    voteAverage: Math.round((d.vote_average || 0) * 10) / 10,
    voteCount:   d.vote_count || 0,
    posterPath:  d.poster_path   || null,
    backdropPath:d.backdrop_path || null,
    genres:      (d.genres || []).map(g => g.name),
    tagline:     d.tagline || '',
    imdbId:      d.imdb_id || null,
    countries:   (d.production_countries || []).map(c => c.name),
    language:    d.original_language || null,
    releaseDate: d.release_date || null,
    directors:   (d.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name),
  };
}

function buildTvEntry(d) {
  const runtimes = d.episode_run_time || [];
  return {
    tmdbId:      d.id,
    mediaType:   'tv',
    runtime:     runtimes[0] || null,
    overview:    d.overview || '',
    voteAverage: Math.round((d.vote_average || 0) * 10) / 10,
    voteCount:   d.vote_count || 0,
    posterPath:  d.poster_path   || null,
    backdropPath:d.backdrop_path || null,
    genres:      (d.genres || []).map(g => g.name),
    tagline:     d.tagline || '',
    imdbId:      null,
    countries:   (d.production_countries || []).map(c => c.name),
    language:    d.original_language || null,
    releaseDate: d.first_air_date || null,
    directors:   (d.created_by || []).map(c => c.name),
  };
}

async function enrichOne(movie) {
  const uri  = movie['Letterboxd URI'];
  const name = encodeURIComponent(movie['Name']);
  const year = movie['Year'];

  // Manual override: null = skip, number = movie TMDB ID, { id, type:'tv' } = TV entry
  if (uri in overrides) {
    const ov = overrides[uri];
    if (!ov) return { notFound: true };
    const tmdbId    = typeof ov === 'object' ? ov.id   : ov;
    const mediaType = typeof ov === 'object' ? (ov.type || 'movie') : 'movie';
    try {
      const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
      const d = await tmdbFetch(`${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
      return mediaType === 'tv' ? buildTvEntry(d) : buildEntry(d);
    } catch (e) {
      process.stderr.write(`  ✗ override "${movie['Name']}" (${mediaType}/${tmdbId}): ${e.message}\n`);
      return null;
    }
  }

  try {
    let r = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${name}&primary_release_year=${year}&api_key=${TMDB_KEY}&language=en-US`);
    let hit = r.results?.[0];
    if (!hit) {
      r = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${name}&api_key=${TMDB_KEY}&language=en-US`);
      const yn = parseInt(year) || 0;
      // Only accept a fallback hit if the year roughly matches — never fall back to "any result"
      hit = r.results?.find(m => Math.abs(parseInt(m.release_date?.slice(0,4)||0) - yn) <= 2) ?? null;
    }
    if (!hit) {
      // TV fallback — many "not found" entries are actually TV shows or miniseries
      try {
        let tvR = await tmdbFetch(`${TMDB_BASE}/search/tv?query=${name}&first_air_date_year=${year}&api_key=${TMDB_KEY}&language=en-US`);
        let tvHit = tvR.results?.[0] ?? null;
        if (!tvHit) {
          tvR = await tmdbFetch(`${TMDB_BASE}/search/tv?query=${name}&api_key=${TMDB_KEY}&language=en-US`);
          if (tvR.results?.length) {
            const yn2 = parseInt(year) || 0;
            tvHit = tvR.results.find(t => Math.abs(parseInt(t.first_air_date?.slice(0, 4) || 0) - yn2) <= 2) ?? null;
          }
        }
        if (tvHit) {
          const tvYear = parseInt(tvHit.first_air_date?.slice(0, 4) || '0');
          if (!isSuspectYear(parseInt(year) || 0, tvYear)) {
            const d = await tmdbFetch(`${TMDB_BASE}/tv/${tvHit.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
            return buildTvEntry(d);
          }
        }
      } catch {}
      return { notFound: true, tvFallbackTried: true };
    }

    // Sanity check: if the best match's year differs too much from the letterboxd year,
    // flag as a suspect match rather than silently using wrong data.
    const yn      = parseInt(year) || 0;
    const hitYear = parseInt(hit.release_date?.slice(0, 4) || '0');
    if (isSuspectYear(yn, hitYear)) {
      process.stderr.write(`  ⚠ "${movie['Name']}" (${year}): best TMDB hit is ${hitYear} — year mismatch, skipping\n`);
      return { notFound: true, suspectMatch: true };
    }

    const d = await tmdbFetch(`${TMDB_BASE}/movie/${hit.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
    return buildEntry(d);
  } catch (e) {
    process.stderr.write(`  ✗ "${movie['Name']}": ${e.message}\n`);
    return null;
  }
}

async function upgradeOne(uri, entry) {
  try {
    const d = await tmdbFetch(`${TMDB_BASE}/movie/${entry.tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
    entry.countries   = (d.production_countries || []).map(c => c.name);
    entry.language    = d.original_language || null;
    entry.releaseDate = d.release_date || null;
    if (entry.directors === undefined) {
      entry.directors = (d.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name);
    }
    return true;
  } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const BATCH = 20;
const start = Date.now();

// Phase 1: Enrich missing
if (toEnrich.length) {
  console.log(`Phase 1: Enriching ${toEnrich.length} new movies...`);
  let done = 0, errors = 0;
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    await Promise.all(toEnrich.slice(i, i + BATCH).map(async movie => {
      const uri  = movie['Letterboxd URI'];
      const data = await enrichOne(movie);
      cache[uri] = data ?? { failed: true, failedAt: Date.now() };
      done++;
      if (!data?.tmdbId) errors++;
    }));
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
    const pct = Math.round(done / toEnrich.length * 100);
    const eta = done > 0 ? Math.round(((toEnrich.length - done) / done) * ((Date.now() - start) / 1000)) : '?';
    process.stdout.write(`\r  ${done}/${toEnrich.length} (${pct}%)  eta ~${eta}s   `);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n✓ Phase 1 done. ${errors} not found on TMDB.`);
}

// Phase 2: Upgrade existing entries missing country data
if (toUpgrade.length) {
  console.log(`\nPhase 2: Adding countries/language to ${toUpgrade.length} existing entries...`);
  let done = 0;
  for (let i = 0; i < toUpgrade.length; i += BATCH) {
    await Promise.all(toUpgrade.slice(i, i + BATCH).map(async movie => {
      const uri = movie['Letterboxd URI'];
      await upgradeOne(uri, cache[uri]);
      done++;
    }));
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
    const pct = Math.round(done / toUpgrade.length * 100);
    process.stdout.write(`\r  ${done}/${toUpgrade.length} (${pct}%)   `);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n✓ Phase 2 done.`);
}

// Phase 3: Add release date to recent movies missing it (small targeted set)
if (toUpgradeRelease.length) {
  console.log(`\nPhase 3: Adding release dates to ${toUpgradeRelease.length} recent movies...`);
  let done = 0;
  for (let i = 0; i < toUpgradeRelease.length; i += BATCH) {
    await Promise.all(toUpgradeRelease.slice(i, i + BATCH).map(async movie => {
      const uri = movie['Letterboxd URI'];
      await upgradeOne(uri, cache[uri]);
      done++;
    }));
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
    process.stdout.write(`\r  ${done}/${toUpgradeRelease.length}   `);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n✓ Phase 3 done.`);
}

const total = Object.values(cache).filter(v => v?.tmdbId).length;
console.log(`\n✅ Cache complete: ${total}/${allMovies.length} movies enriched with full data.\n`);
