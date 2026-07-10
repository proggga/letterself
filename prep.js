// prep.js — Full offline preparation script
// Run once (or occasionally) before starting the server to pre-populate all caches.
//
// Phases:
//   1. Enrich library movies (watchlist + ratings) — TMDB search + details
//   2. Upgrade entries missing country/language data
//   3. Director filmographies — fetch all directors' full movie lists
//   4. Discover film details  — full TMDB data for director films not in cache
//   5. Poster downloads       — download all missing poster images locally
//
// Usage:  node prep.js
//         node prep.js --skip-posters   (skip phase 5, useful if offline)
//         node prep.js --only-posters   (only run phase 5)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

// ── Env ───────────────────────────────────────────────────────────────────────

try {
  const env = readFileSync(join(__dirname, '.env'), 'utf-8');
  for (const line of env.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch {}

const TMDB_KEY  = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
if (!TMDB_KEY) { console.error('❌  TMDB_API_KEY not set in .env'); process.exit(1); }

// ── Paths ─────────────────────────────────────────────────────────────────────

function latestDataDir() {
  const archiveDir = join(__dirname, 'archive');
  if (!existsSync(archiveDir)) return __dirname;
  const dirs = readdirSync(archiveDir)
    .filter(d => statSync(join(archiveDir, d)).isDirectory())
    .sort();
  if (!dirs.length) return __dirname;
  console.log(`📂 Using archive: archive/${dirs[dirs.length - 1]}`);
  return join(archiveDir, dirs[dirs.length - 1]);
}

const DATA_DIR       = latestDataDir();
const CACHE_FILE     = join(__dirname, 'tmdb-cache.json');
const DIR_CACHE_FILE = join(__dirname, 'director-cache.json');
const OVERRIDES_FILE = join(__dirname, 'tmdb-overrides.json');
const POSTERS_DIR    = join(__dirname, 'public', 'posters');
const LOCAL_LIB_FILE = join(__dirname, 'local-library.json');

mkdirSync(POSTERS_DIR, { recursive: true });

// ── Load caches ───────────────────────────────────────────────────────────────

function loadJSON(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function saveJSON(file, data) { writeFileSync(file, JSON.stringify(data, null, 2)); }

let cache       = loadJSON(CACHE_FILE);
let dirCache    = loadJSON(DIR_CACHE_FILE);
let overrides   = loadJSON(OVERRIDES_FILE);
Object.keys(overrides).filter(k => k.startsWith('_')).forEach(k => delete overrides[k]);

// ── Load CSV data ─────────────────────────────────────────────────────────────

function loadCSV(name) {
  const f = join(DATA_DIR, name);
  if (!existsSync(f)) return [];
  return parse(readFileSync(f, 'utf-8'), { columns: true, skip_empty_lines: true });
}

const watchlist    = loadCSV('watchlist.csv');
const ratingsList  = loadCSV('ratings.csv');

// Local library synthetic rows
const localLib     = loadJSON(LOCAL_LIB_FILE, { watchlist: [], watched: [] });
const localUri     = id => `local://movie/${id}`;
function makeLocalRow(e) {
  return { 'Letterboxd URI': localUri(e.tmdbId), Name: e.title, Year: String(e.year || ''), Date: e.addedAt || '' };
}
const localRows = [
  ...localLib.watchlist.map(makeLocalRow),
  ...localLib.watched.map(makeLocalRow),
];

// Merge: deduplicate by URI, watchlist/local takes priority
const allMoviesMap = new Map();
ratingsList.forEach(m => allMoviesMap.set(m['Letterboxd URI'], m));
watchlist.forEach(m   => allMoviesMap.set(m['Letterboxd URI'], m));
localRows.forEach(m   => allMoviesMap.set(m['Letterboxd URI'], m));
const allMovies = [...allMoviesMap.values()];

const THIS_YEAR = new Date().getFullYear();

// ── Rate-limited TMDB fetch ───────────────────────────────────────────────────

let   active = 0;
const MAX    = 8;
const queue  = [];

function drain() {
  while (active < MAX && queue.length) {
    const { url, resolve, reject, attempt } = queue.shift();
    active++;
    fetch(url)
      .then(async res => {
        active--;
        if (res.status === 429) {
          const delay = 2000 * Math.min((attempt || 0) + 1, 5);
          setTimeout(() => { queue.unshift({ url, resolve, reject, attempt: (attempt||0)+1 }); drain(); }, delay);
          return;
        }
        if (!res.ok) { reject(new Error(`HTTP ${res.status}`)); drain(); return; }
        resolve(await res.json());
        drain();
      })
      .catch(e => { active--; reject(e); drain(); });
  }
}
const tmdbFetch = url => new Promise((resolve, reject) => { queue.push({ url, resolve, reject, attempt: 0 }); drain(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSuspectYear(lbYear, tmdbYear) {
  if (!lbYear || !tmdbYear) return false;
  const diff      = Math.abs(lbYear - tmdbYear);
  const threshold = lbYear >= THIS_YEAR - 1 ? 1 : 3;
  return diff > threshold;
}

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

  // Local library: fetch directly by tmdbId
  if (uri.startsWith('local://movie/')) {
    const tmdbId = parseInt(uri.replace('local://movie/', ''));
    if (!tmdbId) return null;
    try {
      const d = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
      return buildEntry(d);
    } catch (e) { process.stderr.write(`  ✗ local "${movie['Name']}": ${e.message}\n`); return null; }
  }

  // Manual override
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

  // Normal TMDB search
  try {
    let r = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${name}&primary_release_year=${year}&api_key=${TMDB_KEY}&language=en-US`);
    let hit = r.results?.[0];
    if (!hit) {
      r = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${name}&api_key=${TMDB_KEY}&language=en-US`);
      const yn = parseInt(year) || 0;
      hit = r.results?.find(m => Math.abs(parseInt(m.release_date?.slice(0,4)||0) - yn) <= 2) ?? null;
    }
    if (!hit) {
      try {
        let tvR = await tmdbFetch(`${TMDB_BASE}/search/tv?query=${name}&first_air_date_year=${year}&api_key=${TMDB_KEY}&language=en-US`);
        let tvHit = tvR.results?.[0] ?? null;
        if (!tvHit) {
          tvR = await tmdbFetch(`${TMDB_BASE}/search/tv?query=${name}&api_key=${TMDB_KEY}&language=en-US`);
          if (tvR.results?.length) {
            const yn2 = parseInt(year) || 0;
            tvHit = tvR.results.find(t => Math.abs(parseInt(t.first_air_date?.slice(0,4)||0) - yn2) <= 2) ?? null;
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
    const yn = parseInt(year) || 0, hitYear = parseInt(hit.release_date?.slice(0, 4) || '0');
    if (isSuspectYear(yn, hitYear)) {
      process.stderr.write(`  ⚠ "${movie['Name']}" (${year}): best TMDB hit is ${hitYear} — year mismatch\n`);
      return { notFound: true, suspectMatch: true };
    }
    const d = await tmdbFetch(`${TMDB_BASE}/movie/${hit.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
    return buildEntry(d);
  } catch (e) {
    process.stderr.write(`  ✗ "${movie['Name']}": ${e.message}\n`);
    return null;
  }
}

// ── Progress helpers ──────────────────────────────────────────────────────────

function fmtDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function progress(done, total, startMs, label = '') {
  const pct    = total ? Math.round(done / total * 100) : 100;
  const elapsedS = Math.round((Date.now() - startMs) / 1000);
  const etaS   = done > 0 && done < total ? Math.round((total - done) / done * elapsedS) : 0;
  const bar    = (() => {
    const w = 24, filled = Math.round(pct / 100 * w);
    return '[' + '█'.repeat(filled) + '░'.repeat(w - filled) + ']';
  })();
  const suffix = done < total ? ` · ETA ~${fmtDuration(etaS)}` : ' ✓';
  const lbl    = label ? `  ${label.slice(0, 40).padEnd(40)}` : '';
  process.stdout.write(`\r  ${bar} ${done}/${total} (${pct}%)${suffix}${lbl}  `);
}

// ── Phase 1: Enrich library ───────────────────────────────────────────────────

const overrideUris = new Set(Object.keys(overrides));

const toEnrich = args.has('--only-posters') ? [] : allMovies.filter(m => {
  const uri = m['Letterboxd URI'];
  const c   = cache[uri];
  if (overrideUris.has(uri)) {
    if (!c?.tmdbId) return true;
    const ov = overrides[uri];
    if (!ov) return false;
    const expectedId = typeof ov === 'object' ? ov.id : ov;
    return c.tmdbId !== expectedId;
  }
  if (!c) return true;
  if (c.suspectMatch) return true;
  if (c.notFound && !c.tvFallbackTried) return true;
  return !c.tmdbId && !c.notFound && !c.failed;
});

const toUpgrade = args.has('--only-posters') ? [] : allMovies.filter(m => {
  const c = cache[m['Letterboxd URI']];
  return c?.tmdbId && c.countries === undefined;
});

const toUpgradeRelease = args.has('--only-posters') ? [] : allMovies.filter(m => {
  const year = parseInt(m['Year']) || 0;
  const c    = cache[m['Letterboxd URI']];
  const uri  = m['Letterboxd URI'];
  return c?.tmdbId && c.releaseDate === undefined
    && year >= THIS_YEAR - 1
    && !toUpgrade.some(u => u['Letterboxd URI'] === uri);
});

const enrichedCount = Object.values(cache).filter(v => v?.tmdbId).length;

console.log(`\n🎬 Movie Night — Prep Script`);
console.log(`${'─'.repeat(50)}`);
console.log(`Library:   ${allMovies.length} movies (${watchlist.length} watchlist + ${ratingsList.length} rated + ${localRows.length} local)`);
console.log(`Cache:     ${enrichedCount} enriched · ${toEnrich.length} to enrich · ${toUpgrade.length} to upgrade`);
console.log(`Directors: ${Object.keys(dirCache).length} cached`);
console.log(`${'─'.repeat(50)}\n`);

if (!args.has('--only-posters') && !toEnrich.length && !toUpgrade.length) {
  console.log('✓ Library cache complete — skipping phases 1–2\n');
}

// Phase 1: Enrich missing movies
if (toEnrich.length) {
  console.log(`Phase 1: Enriching ${toEnrich.length} library movies...`);
  const BATCH = 20;
  let done = 0, errors = 0;
  const phaseStart = Date.now();
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    await Promise.all(toEnrich.slice(i, i + BATCH).map(async movie => {
      const uri  = movie['Letterboxd URI'];
      const data = await enrichOne(movie);
      cache[uri] = data ?? { failed: true, failedAt: Date.now() };
      done++;
      if (!data?.tmdbId) errors++;
      progress(done, toEnrich.length, phaseStart, movie['Name']);
    }));
    saveJSON(CACHE_FILE, cache);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n  ✓ ${done - errors} enriched · ${errors} not found\n`);
}

// Phase 2: Upgrade missing country data
if (toUpgrade.length) {
  console.log(`Phase 2: Upgrading ${toUpgrade.length} entries (adding country/language)...`);
  const BATCH = 20;
  let done = 0;
  const phaseStart = Date.now();
  for (let i = 0; i < toUpgrade.length; i += BATCH) {
    await Promise.all(toUpgrade.slice(i, i + BATCH).map(async movie => {
      const uri = movie['Letterboxd URI'];
      const c   = cache[uri];
      try {
        const d = await tmdbFetch(`${TMDB_BASE}/movie/${c.tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
        c.countries   = (d.production_countries || []).map(x => x.name);
        c.language    = d.original_language || null;
        c.releaseDate = d.release_date || null;
        if (!c.directors) c.directors = (d.credits?.crew || []).filter(x => x.job === 'Director').map(x => x.name);
      } catch {}
      done++;
      progress(done, toUpgrade.length, phaseStart);
    }));
    saveJSON(CACHE_FILE, cache);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n  ✓ Done\n`);
}

if (toUpgradeRelease.length) {
  console.log(`Phase 2b: Adding release dates to ${toUpgradeRelease.length} recent entries...`);
  const BATCH = 20;
  let done = 0;
  const phaseStart = Date.now();
  for (let i = 0; i < toUpgradeRelease.length; i += BATCH) {
    await Promise.all(toUpgradeRelease.slice(i, i + BATCH).map(async movie => {
      const uri = movie['Letterboxd URI'];
      const c   = cache[uri];
      try {
        const d = await tmdbFetch(`${TMDB_BASE}/movie/${c.tmdbId}?api_key=${TMDB_KEY}&language=en-US`);
        c.releaseDate = d.release_date || null;
      } catch {}
      done++;
      progress(done, toUpgradeRelease.length, phaseStart);
    }));
    saveJSON(CACHE_FILE, cache);
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n  ✓ Done\n`);
}

// ── Phase 3: Director filmographies ──────────────────────────────────────────

if (!args.has('--only-posters')) {
  const DIRECTOR_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

  // Collect all directors from the enriched library
  const allDirectors = new Set(
    allMovies.flatMap(m => cache[m['Letterboxd URI']]?.directors || [])
  );
  const toFetchDirs = [...allDirectors].filter(d => {
    const e = dirCache[d.toLowerCase()];
    return !e || (Date.now() - e.cachedAt > DIRECTOR_CACHE_TTL);
  });

  const alreadyCachedDirs = [...allDirectors].filter(d => {
    const e = dirCache[d.toLowerCase()];
    return e && (Date.now() - e.cachedAt <= DIRECTOR_CACHE_TTL);
  });

  console.log(`Phase 3: Director filmographies`);
  console.log(`  ${allDirectors.size} unique directors · ${alreadyCachedDirs.length} cached · ${toFetchDirs.length} to fetch`);

  if (toFetchDirs.length) {
    let done = 0, saved = 0;
    const phaseStart = Date.now();
    const BATCH = 10; // each director = 2 API calls; 10 concurrent = 20 in-flight
    for (let i = 0; i < toFetchDirs.length; i += BATCH) {
      const batch = toFetchDirs.slice(i, i + BATCH);
      await Promise.all(batch.map(async name => {
        try {
          const search = await tmdbFetch(`${TMDB_BASE}/search/person?query=${encodeURIComponent(name)}&api_key=${TMDB_KEY}&language=en-US`);
          const person = search.results?.[0];
          if (person) {
            const credits = await tmdbFetch(`${TMDB_BASE}/person/${person.id}/movie_credits?api_key=${TMDB_KEY}&language=en-US`);
            const movies  = (credits.crew || [])
              .filter(m => m.job === 'Director' && m.release_date)
              .sort((a, b) => b.release_date.localeCompare(a.release_date))
              .map(m => ({
                tmdbId:      m.id,
                title:       m.title,
                year:        parseInt(m.release_date.slice(0, 4)),
                posterPath:  m.poster_path || null,
                voteAverage: Math.round((m.vote_average || 0) * 10) / 10,
                voteCount:   m.vote_count  || 0,
                overview:    m.overview    || '',
              }));
            dirCache[name.toLowerCase()] = {
              cachedAt: Date.now(),
              person:   { id: person.id, name: person.name, profilePath: person.profile_path || null },
              movies,
            };
            saved++;
          }
        } catch {}
        done++;
        progress(done, toFetchDirs.length, phaseStart, name);
      }));
      saveJSON(DIR_CACHE_FILE, dirCache);
      await new Promise(r => setTimeout(r, 50));
    }
    console.log(`\n  ✓ ${saved}/${toFetchDirs.length} fetched\n`);
  } else {
    console.log('  ✓ All director filmographies cached\n');
  }
}

// ── Phase 4: Discover film details ────────────────────────────────────────────

if (!args.has('--only-posters')) {
  // Collect all unique films from directorCache: tmdbId → { posterPath, title }
  const discoverFilms = new Map();
  for (const entry of Object.values(dirCache)) {
    for (const film of (entry.movies || [])) {
      if (film.tmdbId && !discoverFilms.has(film.tmdbId)) {
        discoverFilms.set(film.tmdbId, { posterPath: film.posterPath, title: film.title || '' });
      }
    }
  }

  const existingIds = new Set(Object.values(cache).map(c => c?.tmdbId).filter(Boolean));
  const toFetchDetails = [...discoverFilms.keys()].filter(id => !existingIds.has(id));

  console.log(`Phase 4: Discover film details`);
  console.log(`  ${discoverFilms.size} unique discover films · ${existingIds.size} already in cache · ${toFetchDetails.length} to fetch`);

  if (toFetchDetails.length) {
    let done = 0, saved = 0;
    const phaseStart = Date.now();
    const BATCH = 20;
    for (let i = 0; i < toFetchDetails.length; i += BATCH) {
      const batch = toFetchDetails.slice(i, i + BATCH);
      await Promise.all(batch.map(async tmdbId => {
        const uri = localUri(tmdbId);
        if (cache[uri]?.tmdbId) { done++; return; }
        const film = discoverFilms.get(tmdbId);
        try {
          const d = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
          cache[uri] = buildEntry(d);
          if (d.poster_path) film.posterPath = d.poster_path;
          saved++;
        } catch {}
        done++;
        progress(done, toFetchDetails.length, phaseStart, film.title);
      }));
      saveJSON(CACHE_FILE, cache);
      await new Promise(r => setTimeout(r, 50));
    }
    console.log(`\n  ✓ ${saved}/${toFetchDetails.length} fetched\n`);
  } else {
    console.log('  ✓ All discover film details cached\n');
  }
}

// ── Phase 5: Poster downloads ─────────────────────────────────────────────────

if (!args.has('--skip-posters')) {
  // Use a Map keyed by filename to deduplicate across all sources
  const needed = new Map(); // fname → posterPath

  // Source A: tmdb-cache (library movies + fully-fetched discover films)
  for (const c of Object.values(cache)) {
    if (!c?.posterPath || !c?.tmdbId) continue;
    const fname = c.mediaType === 'tv' ? `tv-${c.tmdbId}.jpg` : `${c.tmdbId}.jpg`;
    if (!needed.has(fname)) needed.set(fname, c.posterPath);
  }

  // Source B: director-cache movies (covers discover films even if Phase 4 failed or was skipped)
  for (const entry of Object.values(dirCache)) {
    for (const film of (entry.movies || [])) {
      if (!film.tmdbId || !film.posterPath) continue;
      const fname = `${film.tmdbId}.jpg`;
      if (!needed.has(fname)) needed.set(fname, film.posterPath);
    }
  }

  const toDownload = [...needed.entries()]
    .filter(([fname]) => !existsSync(join(POSTERS_DIR, fname)))
    .map(([fname, path]) => ({ fname, path }));

  const alreadyHave = needed.size - toDownload.length;

  console.log(`Phase 5: Poster downloads`);
  console.log(`  ${needed.size} total · ${alreadyHave} already on disk · ${toDownload.length} to download`);

  if (toDownload.length) {
    let done = 0, saved = 0, errors = 0;
    const phaseStart = Date.now();
    const CONCURRENCY = 8;

    for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
      const batch = toDownload.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ fname, path }) => {
        try {
          const r = await fetch(`https://image.tmdb.org/t/p/w342${path}`);
          if (r.ok) {
            writeFileSync(join(POSTERS_DIR, fname), Buffer.from(await r.arrayBuffer()));
            saved++;
          } else { errors++; }
        } catch { errors++; }
        done++;
        progress(done, toDownload.length, phaseStart, fname);
      }));
      await new Promise(r => setTimeout(r, 60));
    }
    console.log(`\n  ✓ ${saved} downloaded · ${errors} failed\n`);
  } else {
    console.log('  ✓ All posters already on disk\n');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const finalCount = Object.values(cache).filter(v => v?.tmdbId).length;
const posterCount = existsSync(POSTERS_DIR)
  ? readdirSync(POSTERS_DIR).filter(f => f.endsWith('.jpg')).length
  : 0;
const dirCount = Object.keys(dirCache).length;

console.log(`${'─'.repeat(50)}`);
console.log(`✅  Prep complete!`);
console.log(`    Movies enriched: ${finalCount}`);
console.log(`    Directors cached: ${dirCount}`);
console.log(`    Posters on disk:  ${posterCount}`);
console.log(`${'─'.repeat(50)}\n`);
