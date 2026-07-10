import express from 'express';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── Archive resolver ──────────────────────────────────────────────────────────
function latestDataDir(root) {
  const archiveDir = join(root, 'archive');
  if (!existsSync(archiveDir)) return root;
  const dirs = readdirSync(archiveDir)
    .filter(d => statSync(join(archiveDir, d)).isDirectory())
    .sort();
  if (!dirs.length) return root;
  const latest = join(archiveDir, dirs[dirs.length - 1]);
  console.log(`📂 Using archive: archive/${dirs[dirs.length - 1]}`);
  return latest;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = latestDataDir(__dirname);

// Load .env
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

const app        = express();
const PORT       = process.env.PORT || 3000;
const TMDB_KEY   = process.env.TMDB_API_KEY || '';
const TMDB_BASE  = 'https://api.themoviedb.org/3';
const CACHE_FILE = join(__dirname, 'tmdb-cache.json');
const THIS_YEAR  = new Date().getFullYear();

// Returns true if TMDB year differs too much from the Letterboxd year to be a valid auto-match.
// Stricter tolerance for current/upcoming films (year >= THIS_YEAR-1) because an upcoming 2026
// film is much more likely to be misidentified as a 2024 film than a 1975 film is.
function isSuspectYear(letterboxdYear, tmdbYear) {
  if (!letterboxdYear || !tmdbYear) return false;
  const diff      = Math.abs(letterboxdYear - tmdbYear);
  const threshold = letterboxdYear >= THIS_YEAR - 1 ? 1 : 3;
  return diff > threshold;
}

// Manual overrides: { "https://boxd.it/XXX": null } = skip, { "https://boxd.it/XXX": 12345 } = use TMDB ID
let overrides = {};
try {
  const raw = JSON.parse(readFileSync(join(__dirname, 'tmdb-overrides.json'), 'utf-8'));
  Object.keys(raw).filter(k => !k.startsWith('_')).forEach(k => { overrides[k] = raw[k]; });
} catch {}

// Local library: movies added outside Letterboxd CSV
const LOCAL_LIB_FILE = join(__dirname, 'local-library.json');
let localLib = { watchlist: [], watched: [] };
try { localLib = { watchlist: [], watched: [], ...JSON.parse(readFileSync(LOCAL_LIB_FILE, 'utf-8')) }; } catch {}
function saveLocalLib() { writeFileSync(LOCAL_LIB_FILE, JSON.stringify(localLib, null, 2)); }
// Synthetic URI for a local library entry
const localUri = tmdbId => `local://movie/${tmdbId}`;

// Series grouping: { "Black Mirror": { tmdbTvId: 42009 }, ... }
const SERIES_CACHE_FILE   = join(__dirname, 'series-cache.json');
const DIRECTOR_CACHE_FILE = join(__dirname, 'director-cache.json');
const DIRECTOR_CACHE_TTL  = 3 * 24 * 60 * 60 * 1000; // 3 days
let seriesGroups   = {};
let seriesCache    = {};
let directorCache  = {};
try { seriesGroups  = JSON.parse(readFileSync(join(__dirname, 'series-groups.json'), 'utf-8')); } catch {}
try { seriesCache   = JSON.parse(readFileSync(SERIES_CACHE_FILE, 'utf-8')); } catch {}
try { directorCache = JSON.parse(readFileSync(DIRECTOR_CACHE_FILE, 'utf-8')); } catch {}
// Strip the comment key
delete seriesGroups['_comment'];

function saveSeriesCache() { writeFileSync(SERIES_CACHE_FILE, JSON.stringify(seriesCache)); }

async function fetchSeriesData(seriesName) {
  const { tmdbTvId } = seriesGroups[seriesName];
  if (!TMDB_KEY || !tmdbTvId) return;
  try {
    const d = await tmdbFetch(`${TMDB_BASE}/tv/${tmdbTvId}?api_key=${TMDB_KEY}&language=en-US`);

    // Fetch all episode titles from every season (skip season 0 = specials)
    const episodeTitles = [];
    for (const season of (d.seasons || []).filter(s => s.season_number > 0)) {
      try {
        const sd = await tmdbFetch(`${TMDB_BASE}/tv/${tmdbTvId}/season/${season.season_number}?api_key=${TMDB_KEY}&language=en-US`);
        (sd.episodes || []).forEach(e => { if (e.name) episodeTitles.push(e.name); });
      } catch {}
    }

    seriesCache[seriesName] = {
      tmdbId:       d.id,
      posterPath:   d.poster_path   || null,
      overview:     d.overview      || '',
      genres:       (d.genres || []).map(g => g.name),
      countries:    (d.production_countries || []).map(c => c.name),
      voteAverage:  Math.round((d.vote_average || 0) * 10) / 10,
      voteCount:    d.vote_count    || 0,
      firstAirYear: d.first_air_date ? parseInt(d.first_air_date.slice(0, 4)) : null,
      episodeTitles,
    };
    saveSeriesCache();
    // Download poster inline so cards load immediately
    if (d.poster_path) {
      const posterFile = join(__dirname, 'public', 'posters', `tv-${d.id}.jpg`);
      if (!existsSync(posterFile)) {
        try {
          const r = await fetch(`https://image.tmdb.org/t/p/w342${d.poster_path}`);
          if (r.ok) writeFileSync(posterFile, Buffer.from(await r.arrayBuffer()));
        } catch {}
      }
    }
    console.log(`📺 Series data loaded: ${seriesName}`);
  } catch (e) {
    console.error(`Failed to fetch series data for "${seriesName}": ${e.message}`);
  }
}

async function initSeriesCache() {
  for (const sn of Object.keys(seriesGroups)) {
    // Re-fetch if cache entry is missing episodeTitles or countries (older format)
    if (!seriesCache[sn] || !seriesCache[sn].episodeTitles || seriesCache[sn].countries === undefined) await fetchSeriesData(sn);
  }
}

// Returns the series name if this movie title matches a known series prefix (e.g. "Black Mirror: ...")
// Supports both "Series: Episode" and "Series - Episode" naming conventions,
// and exact episode title matching for anthology series (e.g. Cabinet of Curiosities)
function getSeriesGroup(name, year) {
  const nl = name.toLowerCase().trim();
  for (const sn of Object.keys(seriesGroups)) {
    const snl = sn.toLowerCase();
    if (nl === snl || nl.startsWith(snl + ':') || nl.startsWith(snl + ' - ')) return sn;
    // Anthology fallback: match by exact episode title from TMDB, but guard against
    // false positives by requiring the movie year to be within 3 years of the series.
    const sc = seriesCache[sn];
    if (sc?.episodeTitles?.some(t => t.toLowerCase() === nl)) {
      if (year && sc.firstAirYear && Math.abs(parseInt(year) - sc.firstAirYear) > 3) continue;
      return sn;
    }
  }
  return null;
}

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Data ─────────────────────────────────────────────────────────────────────

let watchlist    = [];
let ratingsList  = [];
let watchedList  = [];   // full rows from watched.csv
let watchedSet   = new Set();
let tmdbCache    = {};
const enrichStatus = { total: 0, done: 0, running: false, errors: 0 };

function loadCSV(filename) {
  return parse(readFileSync(join(DATA_DIR, filename), 'utf-8'), { columns: true, skip_empty_lines: true });
}
function saveCache() { writeFileSync(CACHE_FILE, JSON.stringify(tmdbCache)); }

// ── TMDB rate limiter ─────────────────────────────────────────────────────────

let activeReqs = 0;
const MAX_CONCURRENT = 6;
const pending = [];

function drainQueue() {
  while (activeReqs < MAX_CONCURRENT && pending.length) {
    const { url, resolve, reject, attempt } = pending.shift();
    activeReqs++;
    fetch(url)
      .then(async res => {
        activeReqs--;
        if (res.status === 429) {
          const delay = 2000 * Math.min(attempt + 1, 4);
          setTimeout(() => { pending.unshift({ url, resolve, reject, attempt: attempt + 1 }); drainQueue(); }, delay);
          return;
        }
        if (!res.ok) { reject(new Error(`HTTP ${res.status}: ${url}`)); drainQueue(); return; }
        resolve(await res.json());
        drainQueue();
      })
      .catch(err => { activeReqs--; reject(err); drainQueue(); });
  }
}
function tmdbFetch(url) {
  return new Promise((resolve, reject) => { pending.push({ url, resolve, reject, attempt: 0 }); drainQueue(); });
}

// ── TMDB enrichment ───────────────────────────────────────────────────────────

async function enrichOne(movie) {
  const uri  = movie['Letterboxd URI'];
  const name = encodeURIComponent(movie['Name']);
  const year = movie['Year'];

  // Local library entry: fetch directly by tmdbId stored in cache or extract from URI
  if (uri.startsWith('local://movie/')) {
    const existing = tmdbCache[uri];
    if (existing?.tmdbId) return existing; // already enriched
    const tmdbId = parseInt(uri.replace('local://movie/', ''));
    if (!tmdbId || !TMDB_KEY) return null;
    try {
      const d = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
      return buildCacheEntry(d);
    } catch { return null; }
  }

  // Manual override: null = skip, number = movie TMDB ID, { id, type:'tv' } = TV entry
  if (uri in overrides) {
    const ov = overrides[uri];
    if (!ov) return { notFound: true };
    const tmdbId    = typeof ov === 'object' ? ov.id   : ov;
    const mediaType = typeof ov === 'object' ? (ov.type || 'movie') : 'movie';
    try {
      const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
      const d = await tmdbFetch(`${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
      return mediaType === 'tv' ? buildTvEntry(d) : buildCacheEntry(d);
    } catch (e) {
      console.error(`  ✗ override "${movie['Name']}" (${mediaType}/${tmdbId}): ${e.message}`);
      return null;
    }
  }

  try {
    let result = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${name}&primary_release_year=${year}&api_key=${TMDB_KEY}&language=en-US`);
    let hit = result.results?.[0];

    // Fallback: search without year but require the year to roughly match (±2 years)
    // — do NOT fall back to "any result" as that causes false matches for new/obscure titles
    if (!hit) {
      result = await tmdbFetch(`${TMDB_BASE}/search/movie?query=${name}&api_key=${TMDB_KEY}&language=en-US`);
      if (result.results?.length) {
        const yn = parseInt(year) || 0;
        hit = result.results.find(m => Math.abs(parseInt(m.release_date?.slice(0, 4) || 0) - yn) <= 2) ?? null;
      }
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

    // Sanity check: if the best TMDB result's year differs too much from the letterboxd year,
    // this is almost certainly a wrong match (e.g. a 2024 film matched against a 2026 watchlist entry).
    // Mark as suspectMatch so the UI shows a warning instead of silently using wrong data.
    const yn      = parseInt(year) || 0;
    const hitYear = parseInt(hit.release_date?.slice(0, 4) || '0');
    if (isSuspectYear(yn, hitYear)) {
      return { notFound: true, suspectMatch: true };
    }

    const d = await tmdbFetch(`${TMDB_BASE}/movie/${hit.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
    return buildCacheEntry(d);
  } catch (e) {
    console.error(`  ✗ "${movie['Name']}": ${e.message}`);
    return null;
  }
}

function buildCacheEntry(d) {
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

// TV entries use different field names than movie entries
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

// Returns true if movie has a release date in the past (or no date info in cache = assume released for old entries)
function isReleased(c, year) {
  if (c && 'releaseDate' in c) {
    if (!c.releaseDate) return false; // null = date TBD = unreleased
    return c.releaseDate <= new Date().toISOString().slice(0, 10);
  }
  // Fallback for old cache entries that predate the releaseDate field
  const thisYear = new Date().getFullYear();
  return !year || year <= thisYear;
}

async function runEnrichment() {
  if (!TMDB_KEY) { console.log('⚠  No TMDB_API_KEY'); return; }

  const toEnrich = watchlist.filter(m => {
    const uri = m['Letterboxd URI'];
    const c   = tmdbCache[uri];
    if (c?.tmdbId) {
      // Already enriched — only re-run if the override ID changed
      if (!(uri in overrides)) return false;
      const ov = overrides[uri];
      if (!ov) return false;
      const expectedId = typeof ov === 'object' ? ov.id : ov;
      return c.tmdbId !== expectedId;
    }
    if (uri in overrides) {
      if (!c) return true;               // never tried
      const RETRY_AFTER = 4 * 60 * 60 * 1000;
      return !c.failedAt || (Date.now() - c.failedAt > RETRY_AFTER);
    }
    return !c || (!c.notFound && !c.failed);
  });

  if (!toEnrich.length) { console.log('✓ Watchlist fully enriched'); return; }

  enrichStatus.running = true;
  console.log(`\nEnriching ${toEnrich.length} watchlist movies...`);

  const BATCH = 20;
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const batch = toEnrich.slice(i, i + BATCH);
    await Promise.all(batch.map(async movie => {
      const uri  = movie['Letterboxd URI'];
      const data = await enrichOne(movie);
      tmdbCache[uri] = data ?? { failed: true, failedAt: Date.now() };
      enrichStatus.done++;
      if (!data?.tmdbId) enrichStatus.errors++;
    }));
    saveCache();
    console.log(`  ${Math.min(i + BATCH, toEnrich.length)}/${toEnrich.length} (${Math.round((i + BATCH) / toEnrich.length * 100)}%)`);
    await new Promise(r => setTimeout(r, 50));
  }

  enrichStatus.running = false;
  console.log(`✓ Done. ${enrichStatus.errors} not found.\n`);
}

// ── Movie builder ─────────────────────────────────────────────────────────────

function buildMovie(row) {
  const uri = row['Letterboxd URI'];
  const c   = tmdbCache[uri];
  const letterboxdYear = parseInt(row['Year']) || 0;
  const tmdbYear       = c?.releaseDate ? parseInt(c.releaseDate.slice(0, 4)) : 0;
  const hasOverride    = uri in overrides;
  return {
    id:          uri.replace('https://boxd.it/', ''),
    uri,
    name:        row['Name'],
    year:        letterboxdYear,
    addedDate:   row['Date'],
    tmdbId:      c?.tmdbId      ?? null,
    posterId:    c?.tmdbId ? (c.mediaType === 'tv' ? `tv-${c.tmdbId}` : String(c.tmdbId)) : null,
    runtime:     c?.runtime     ?? null,
    overview:    c?.overview    ?? null,
    voteAverage: c?.voteAverage ?? null,
    voteCount:   c?.voteCount   ?? null,
    posterPath:  c?.posterPath  ?? null,
    backdropPath:c?.backdropPath ?? null,
    genres:      c?.genres      ?? [],
    tagline:     c?.tagline     ?? null,
    imdbId:      c?.imdbId      ?? null,
    countries:   c?.countries   ?? [],
    language:    c?.language    ?? null,
    directors:   c?.directors   ?? [],
    seriesGroup: getSeriesGroup(row['Name'], parseInt(row['Year']) || null),
    enriched:    !!(c?.tmdbId),
    enrichFailed:!!(c?.failed || c?.notFound),
    // suspectMatch: only flag when there is NO override — an override is intentional
    suspectMatch: !hasOverride && (!!(c?.suspectMatch) || !!(c?.tmdbId && isSuspectYear(letterboxdYear, tmdbYear))),
    released:    isReleased(c, letterboxdYear),
    hasOverride,
    overrideId:  hasOverride ? overrides[uri] : undefined,
  };
}

// ── Taste profile (built from ratings.csv × cache) ───────────────────────────

// Animation and very recent movies have tight pacing — little to skip
function adjustedRatio(movie, userRatio) {
  if (userRatio >= 1.0) return 1.0;
  if ((movie.genres || []).includes('Animation'))       return Math.max(userRatio, 0.95);
  if ((movie.year || 0) >= THIS_YEAR - 1)               return Math.max(userRatio, 0.93);
  return userRatio;
}

function buildTasteProfile() {
  const genreMap = {}, decadeMap = {};
  ratingsList.forEach(r => {
    const c = tmdbCache[r['Letterboxd URI']];
    if (!c?.tmdbId) return;
    const rating = parseFloat(r['Rating']) || 0;
    const year   = parseInt(r['Year']) || 0;
    (c.genres || []).forEach(g => {
      if (!genreMap[g]) genreMap[g] = { sum: 0, count: 0 };
      genreMap[g].sum += rating; genreMap[g].count++;
    });
    const decade = Math.floor(year / 10) * 10;
    if (!decadeMap[decade]) decadeMap[decade] = { sum: 0, count: 0 };
    decadeMap[decade].sum += rating; decadeMap[decade].count++;
  });
  const genrePrefs = Object.fromEntries(
    Object.entries(genreMap).filter(([, v]) => v.count >= 3).map(([g, v]) => [g, v.sum / v.count])
  );
  const decadePrefs = Object.fromEntries(
    Object.entries(decadeMap).filter(([, v]) => v.count >= 3).map(([d, v]) => [d, v.sum / v.count])
  );
  return { genrePrefs, decadePrefs };
}

function personalizedScore(movie, profile) {
  const base = (movie.voteAverage || 5) * Math.log10((movie.voteCount || 1) + 1);
  const genreBonus  = movie.genres.length
    ? Math.max(...movie.genres.map(g => profile.genrePrefs[g] || 0))
    : 0;
  const decade = Math.floor(movie.year / 10) * 10;
  const decadeBonus = profile.decadePrefs[decade] || 0;
  return base + genreBonus * 0.6 + decadeBonus * 0.3;
}

// Builds the full discover film pool (director films not in user's library).
// Shared by /api/discover, /api/discover/random, and /api/movies/suggest?discover=true.
function buildDiscoverPool() {
  const watchlistIds = new Set(watchlist.map(m => tmdbCache[m['Letterboxd URI']]?.tmdbId).filter(Boolean));
  const watchedIds   = new Set(watchedList.map(m => tmdbCache[m['Letterboxd URI']]?.tmdbId).filter(Boolean));
  const tmdbIdToCache = {};
  for (const c of Object.values(tmdbCache)) {
    if (c?.tmdbId) tmdbIdToCache[c.tmdbId] = c;
  }
  const affinityMap = {};
  for (const entry of Object.values(directorCache)) {
    if (!entry?.person?.name) continue;
    const inLibrary = entry.movies.filter(m => watchlistIds.has(m.tmdbId) || watchedIds.has(m.tmdbId)).length;
    affinityMap[entry.person.name] = inLibrary;
  }
  const filmMap = new Map();
  for (const entry of Object.values(directorCache)) {
    if (!entry?.person?.name || !entry.movies) continue;
    const dirName = entry.person.name;
    const affinity = affinityMap[dirName] || 0;
    for (const m of entry.movies) {
      if (watchlistIds.has(m.tmdbId) || watchedIds.has(m.tmdbId)) continue;
      const cached = tmdbIdToCache[m.tmdbId];
      if (filmMap.has(m.tmdbId)) {
        const f = filmMap.get(m.tmdbId);
        if (!f.directors.includes(dirName)) f.directors.push(dirName);
        f.affinity = Math.max(f.affinity, affinity);
      } else {
        filmMap.set(m.tmdbId, {
          ...m,
          id:        `discover-${m.tmdbId}`,
          source:    'discover',
          directors: [dirName],
          affinity,
          genres:    cached?.genres    || [],
          runtime:   cached?.runtime   || null,
          countries: cached?.countries || [],
          posterId:  (m.tmdbId && existsSync(join(__dirname, 'public', 'posters', `${m.tmdbId}.jpg`))) ? String(m.tmdbId) : null,
        });
      }
    }
  }
  return [...filmMap.values()];
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/movies', (req, res) => {
  const { sort = 'votes', page = 1, limit = 28, genre, country, maxRuntime, q } = req.query;
  const showWatched    = req.query.showWatched === 'true';
  const showUnreleased = req.query.showUnreleased === 'true';
  const showBroken     = req.query.broken === 'true';
  const director = req.query.director || '';

  // "Broken" view: show ALL movies (watchlist + watched, released + unreleased) that need fixing
  let movies;
  if (showBroken) {
    const wlMovies = watchlist.map(m => {
      const movie = buildMovie(m);
      if (watchedSet.has(m['Letterboxd URI'])) movie.watched = true;
      return movie;
    });
    const watchlistUris = new Set(watchlist.map(m => m['Letterboxd URI']));
    const watchedMovies = watchedList
      .filter(m => !watchlistUris.has(m['Letterboxd URI']))
      .map(m => ({ ...buildMovie(m), watched: true }));
    movies = [...wlMovies, ...watchedMovies]
      .filter(m => !m.seriesGroup && (m.suspectMatch || (m.enrichFailed && !m.hasOverride)));
  } else if (showWatched) {
    const wlMovies = watchlist.map(m => {
      const movie = buildMovie(m);
      if (watchedSet.has(m['Letterboxd URI'])) movie.watched = true;
      return movie;
    });
    const watchlistUris = new Set(watchlist.map(m => m['Letterboxd URI']));
    const watchedMovies = watchedList
      .filter(m => !watchlistUris.has(m['Letterboxd URI']))
      .map(m => ({ ...buildMovie(m), watched: true }));
    movies = [...wlMovies, ...watchedMovies];
  } else {
    const watchlistUris = new Set(watchlist.map(m => m['Letterboxd URI']));
    // Unwatched watchlist movies
    movies = watchlist
      .filter(m => !watchedSet.has(m['Letterboxd URI']))
      .map(buildMovie);
    // Also include watched series episodes so they can be grouped into series cards
    const watchedSeriesEps = watchedList
      .filter(m => !watchlistUris.has(m['Letterboxd URI']) && getSeriesGroup(m['Name'], parseInt(m['Year']) || null))
      .map(m => ({ ...buildMovie(m), watched: true }));
    movies = [...movies, ...watchedSeriesEps];
  }

  // Hide unreleased movies by default (skipped in broken mode — broken unreleased still need fixing)
  if (!showUnreleased && !showBroken) movies = movies.filter(m => m.released);

  // Series grouping: collapse episode cards into a single series card (not in broken mode)
  let seriesCards = [];
  if (!showBroken) {
    const seriesEpisodesMap = {};
    movies = movies.filter(m => {
      if (m.seriesGroup) {
        if (!seriesEpisodesMap[m.seriesGroup]) seriesEpisodesMap[m.seriesGroup] = [];
        seriesEpisodesMap[m.seriesGroup].push(m);
        return false;
      }
      return true;
    });
    seriesCards = Object.entries(seriesEpisodesMap).map(([sn, eps]) => {
      const sc = seriesCache[sn];
      const sortedEps = [...eps].sort((a, b) => a.name.localeCompare(b.name));
      return {
        type:         'series',
        id:           `series-${sn.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        seriesName:   sn,
        name:         sn,
        tmdbId:       sc?.tmdbId       ?? null,
        posterId:     sc?.tmdbId       ? `tv-${sc.tmdbId}` : null,
        posterPath:   sc?.posterPath   ?? null,
        year:         sc?.firstAirYear ?? null,
        runtime:      null,
        overview:     sc?.overview     ?? null,
        voteAverage:  sc?.voteAverage  ?? null,
        voteCount:    sc?.voteCount    ?? null,
        genres:       sc?.genres       ?? [],
        released:     true,
        enriched:     !!(sc?.tmdbId),
        episodes:     sortedEps,
        episodeCount: sortedEps.length,
        watchedCount: sortedEps.filter(e => e.watched).length,
        watched:      sortedEps.every(e => e.watched),
        ratioUsed:    1,
        directors:    [],
        countries:    sc?.countries   ?? [],
      };
    });
  }

  if (q) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const nq = norm(q);
    movies = movies.filter(m => norm(m.name).includes(nq) || (m.directors || []).some(d => norm(d).includes(nq)));
    seriesCards = seriesCards.filter(s =>
      norm(s.name).includes(nq) || s.episodes.some(e => norm(e.name).includes(nq))
    );
  }
  if (director) movies = movies.filter(m => (m.directors || []).includes(director));
  if (genre && genre !== 'all') {
    movies      = movies.filter(m => m.genres.includes(genre));
    seriesCards = seriesCards.filter(s => s.genres.includes(genre));
  }
  if (country && country !== 'all') {
    movies      = movies.filter(m => (m.countries || []).includes(country));
    seriesCards = seriesCards.filter(s => (s.countries || []).includes(country));
  }
  if (maxRuntime) {
    const max = parseInt(maxRuntime);
    // Use adjustedRatio for time filtering so Animation/new movies aren't wrongly excluded
    movies = movies.filter(m => m.runtime && Math.round(m.runtime * adjustedRatio(m, parseFloat(req.query.ratio) || 1)) <= max);
  }

  // When not showing watched, hide fully-watched series cards
  if (!showWatched) seriesCards = seriesCards.filter(s => !s.watched);

  // Merge series cards into the movies array before sorting
  movies = [...movies, ...seriesCards];

  if (sort === 'foryou') {
    const profile = buildTasteProfile();
    movies.sort((a, b) => personalizedScore(b, profile) - personalizedScore(a, profile));
  } else {
    movies.sort((a, b) => {
      switch (sort) {
        // Rating sort: only movies with >= 100 votes get a meaningful position; others sink to bottom
        case 'rating': {
          const ra = (a.voteCount ?? 0) >= 100 ? (a.voteAverage ?? 0) : -1;
          const rb = (b.voteCount ?? 0) >= 100 ? (b.voteAverage ?? 0) : -1;
          return rb - ra;
        }
        case 'votes':    return (b.voteCount   ?? 0) - (a.voteCount   ?? 0);
        // year-new: unknown year (0) goes to end; future years stay at top (anticipated films)
        case 'year-new': return (b.year || -1) - (a.year || -1);
        // year-old: unknown year (0) goes to end, not the front
        case 'year-old': return (a.year || 9999) - (b.year || 9999);
        case 'runtime':  return (a.runtime ?? 999) - (b.runtime ?? 999);
        case 'name':     return a.name.localeCompare(b.name);
        default:         return (b.voteCount ?? 0) - (a.voteCount ?? 0);
      }
    });
  }

  const total   = movies.length;
  const pageNum = parseInt(page);
  const ps      = parseInt(limit);
  const offset  = (pageNum - 1) * ps;
  const userRatio = parseFloat(req.query.ratio) || 1;

  // Enrichment total across all data sources (watchlist + watched + ratings)
  const allUris = new Set([
    ...watchlist.map(m => m['Letterboxd URI']),
    ...watchedList.map(m => m['Letterboxd URI']),
    ...ratingsList.map(m => m['Letterboxd URI']),
  ]);
  const enrichedCount = [...allUris].filter(uri => tmdbCache[uri]?.tmdbId).length;

  // Count broken movies (suspect year + failed without manual skip) across all sources
  // Series episodes are excluded — they can't be enriched as individual TMDB movies and are
  // covered by their series card
  const allMoviesForBroken = new Map();
  watchedList.forEach(m => allMoviesForBroken.set(m['Letterboxd URI'], m));
  watchlist.forEach(m => allMoviesForBroken.set(m['Letterboxd URI'], m));
  const brokenCount = [...allMoviesForBroken.entries()].filter(([uri, row]) => {
    if (getSeriesGroup(row['Name'], parseInt(row['Year']) || null)) return false;
    if (uri in overrides) return false;   // overrides are intentional
    const c = tmdbCache[uri];
    if (!c) return false;
    const ly = parseInt(row['Year']) || 0;
    const ty = c.releaseDate ? parseInt(c.releaseDate.slice(0, 4)) : 0;
    return !!(c.suspectMatch) || !!(c.tmdbId && isSuspectYear(ly, ty))
        || (c.failed || c.notFound);
  }).length;

  // Attach per-movie adjusted ratio so frontend can display correct effective runtime
  const page_movies = movies.slice(offset, offset + ps).map(m => ({
    ...m,
    ratioUsed: adjustedRatio(m, userRatio),
  }));

  res.json({
    movies: page_movies,
    total, page: pageNum, pages: Math.ceil(total / ps),
    enrichmentStatus: {
      total:       allUris.size,
      done:        enrichedCount,
      running:     enrichStatus.running,
      percent:     Math.min(100, Math.round(enrichedCount / allUris.size * 100)),
      brokenCount,
    },
  });
});

app.get('/api/movies/random', (req, res) => {
  const { maxRuntime } = req.query;
  let pool = watchlist.filter(m => !watchedSet.has(m['Letterboxd URI'])).map(buildMovie)
               .filter(m => m.released);
  const enriched = pool.filter(m => m.enriched);
  if (enriched.length) pool = enriched;
  if (maxRuntime) {
    const max = parseInt(maxRuntime);
    pool = pool.filter(m => m.runtime && Math.round(m.runtime * 0.88) <= max);
  }
  if (!pool.length) return res.json({ movie: null });

  // Sort by quality and pick from top 10% (min 50) so "random" means good, not truly random
  pool.sort((a, b) => {
    const sa = (a.voteAverage || 5) * Math.log10((a.voteCount || 1) + 1);
    const sb = (b.voteAverage || 5) * Math.log10((b.voteCount || 1) + 1);
    return sb - sa;
  });
  const TOP = Math.max(50, Math.floor(pool.length * 0.1));
  pool = pool.slice(0, TOP);

  res.json({ movie: pool[Math.floor(Math.random() * pool.length)] });
});


app.get('/api/movies/suggest', (req, res) => {
  const budget  = parseInt(req.query.minutes) || 120;
  const ratio   = parseFloat(req.query.ratio) || 0.85;
  const exclude = (req.query.exclude || '').split(',').filter(Boolean);
  const foryou  = req.query.foryou === 'true';
  const mode    = req.query.mode || 'feature'; // 'feature' | 'shorts'
  const discover = req.query.discover === 'true';

  const MAX_MOVIES = mode === 'shorts' ? 8 : 4;
  const MIN_EFF    = mode === 'shorts' ? 5  : 40;
  const PREF_EFF   = mode === 'shorts' ? 70 : 80;

  let movies;
  if (discover) {
    movies = buildDiscoverPool()
      .filter(m => m.runtime && !exclude.includes(m.id))
      .map(m => ({ ...m, name: m.title }));
  } else {
    movies = watchlist
      .filter(m => !watchedSet.has(m['Letterboxd URI']))
      .map(buildMovie)
      .filter(m => m.enriched && m.runtime && m.released && !exclude.includes(m.id));
  }

  // Pre-filter: must fit in budget and meet mode minimum
  movies = movies.filter(m => {
    const eff = Math.round(m.runtime * adjustedRatio(m, ratio));
    return eff <= budget && eff >= MIN_EFF;
  });

  if (foryou) {
    const profile = buildTasteProfile();
    movies.sort((a, b) => personalizedScore(b, profile) - personalizedScore(a, profile));
  } else {
    movies.sort((a, b) => {
      const sa = (a.voteAverage || 5) * Math.log10((a.voteCount || 1) + 1);
      const sb = (b.voteAverage || 5) * Math.log10((b.voteCount || 1) + 1);
      return sb - sa;
    });
  }

  const POOL = 15;
  const night = [];
  const used  = new Set(exclude);
  let remaining = budget;

  while (night.length < MAX_MOVIES && remaining >= 20) {
    const fits = movies.filter(m => {
      const eff = Math.round(m.runtime * adjustedRatio(m, ratio));
      return eff <= remaining && !used.has(m.id);
    });
    if (!fits.length) break;

    // Bias toward mode preference: feature = longer films, shorts = shorter films
    const preferred = fits.filter(m => {
      const eff = Math.round(m.runtime * adjustedRatio(m, ratio));
      return mode === 'shorts' ? eff <= PREF_EFF : eff >= PREF_EFF;
    });
    const candidates = (preferred.length ? preferred : fits).slice(0, POOL);

    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    const eff    = Math.round(picked.runtime * adjustedRatio(picked, ratio));
    night.push({ ...picked, effectiveRuntime: eff, ratioUsed: adjustedRatio(picked, ratio) });
    used.add(picked.id);
    remaining -= eff;
  }

  res.json({ night, budgetMinutes: budget, usedMinutes: budget - remaining, remainingMinutes: remaining });
});

app.get('/api/overrides', (req, res) => {
  const allMovies  = [...watchlist, ...watchedList];
  const movieMap   = new Map(allMovies.map(m => [m['Letterboxd URI'], m]));
  const result = Object.entries(overrides).map(([uri, ov]) => {
    const m   = movieMap.get(uri);
    const c   = tmdbCache[uri];
    const isSkip  = ov === null;
    const isTv    = ov && typeof ov === 'object' && ov.type === 'tv';
    const forcedId = isSkip ? null : (typeof ov === 'object' ? ov.id : ov);
    return {
      uri,
      name:     m?.['Name'] || uri,
      year:     m?.['Year'] || '',
      override: { isSkip, id: forcedId, type: isTv ? 'tv' : 'movie' },
      current:  c?.tmdbId ? {
        tmdbId:      c.tmdbId,
        mediaType:   c.mediaType || 'movie',
        posterPath:  c.posterPath  || null,
        overview:    c.overview    || null,
        voteAverage: c.voteAverage || null,
        releaseDate: c.releaseDate || null,
        genres:      c.genres      || [],
        directors:   c.directors   || [],
      } : null,
    };
  });
  res.json(result);
});

app.post('/api/overrides', async (req, res) => {
  const { uri, tmdbId, mediaType, clear } = req.body;

  // Note old poster ID before changing the override
  const oldEntry  = tmdbCache[uri];
  const oldPosterId = oldEntry?.tmdbId
    ? (oldEntry.mediaType === 'tv' ? `tv-${oldEntry.tmdbId}` : String(oldEntry.tmdbId))
    : null;

  if (clear) {
    delete overrides[uri];
  } else if (tmdbId === null) {
    overrides[uri] = null; // skip
  } else {
    // Store as plain number for movie (backward compatible), object for TV
    overrides[uri] = (mediaType && mediaType !== 'movie') ? { id: tmdbId, type: mediaType } : tmdbId;
  }
  writeFileSync(join(__dirname, 'tmdb-overrides.json'), JSON.stringify(overrides, null, 2));

  // Re-enrich immediately with new override
  const allMovies = [...watchlist, ...watchedList];
  const movie = allMovies.find(m => m['Letterboxd URI'] === uri);
  if (movie) {
    const data = await enrichOne(movie);
    tmdbCache[uri] = data ?? { failed: true };
    saveCache();

    // Delete old poster file if it changed
    const POSTER_DIR = join(__dirname, 'public', 'posters');
    const newEntry = tmdbCache[uri];
    const newPosterId = newEntry?.tmdbId
      ? (newEntry.mediaType === 'tv' ? `tv-${newEntry.tmdbId}` : String(newEntry.tmdbId))
      : null;

    if (oldPosterId && oldPosterId !== newPosterId) {
      const oldFile = join(POSTER_DIR, `${oldPosterId}.jpg`);
      if (existsSync(oldFile)) { try { unlinkSync(oldFile); } catch {} }
    }

    // Download new poster inline if needed
    if (newPosterId && newEntry?.posterPath) {
      const newFile = join(POSTER_DIR, `${newPosterId}.jpg`);
      if (!existsSync(newFile)) {
        try {
          const r = await fetch(`https://image.tmdb.org/t/p/w342${newEntry.posterPath}`);
          if (r.ok) {
            const buf = await r.arrayBuffer();
            writeFileSync(newFile, Buffer.from(buf));
          }
        } catch {}
      }
    }
  }

  const wlMovie = watchlist.find(m => m['Letterboxd URI'] === uri)
                || watchedList.find(m => m['Letterboxd URI'] === uri);
  res.json({ ok: true, movie: wlMovie ? buildMovie(wlMovie) : null });
});

// ── Director filmography ──────────────────────────────────────────────────────

function saveDirectorCache() {
  writeFileSync(DIRECTOR_CACHE_FILE, JSON.stringify(directorCache));
}

function buildLibrarySets() {
  return {
    watchlistIds: new Set(watchlist.map(m => tmdbCache[m['Letterboxd URI']]?.tmdbId).filter(Boolean)),
    watchedIds:   new Set(watchedList.map(m => tmdbCache[m['Letterboxd URI']]?.tmdbId).filter(Boolean)),
  };
}

function annotateWithLibrary(movies, watchlistIds, watchedIds) {
  // Build tmdbId → cache lookup so we can merge in genres/runtime for director films
  const idToCache = new Map();
  for (const c of Object.values(tmdbCache)) {
    if (c?.tmdbId && !idToCache.has(c.tmdbId)) idToCache.set(c.tmdbId, c);
  }
  return movies.map(m => {
    const c = idToCache.get(m.tmdbId);
    return {
      ...m,
      genres:      c?.genres   || [],
      runtime:     c?.runtime  || null,
      countries:   c?.countries || [],
      inWatchlist: watchlistIds.has(m.tmdbId),
      watched:     watchedIds.has(m.tmdbId),
      posterId:    existsSync(join(__dirname, 'public', 'posters', `${m.tmdbId}.jpg`)) ? String(m.tmdbId) : null,
    };
  });
}

async function fetchDirectorFilmography(name) {
  const search = await tmdbFetch(`${TMDB_BASE}/search/person?query=${encodeURIComponent(name)}&api_key=${TMDB_KEY}&language=en-US`);
  const person = search.results?.[0];
  if (!person) return null;

  const credits = await tmdbFetch(`${TMDB_BASE}/person/${person.id}/movie_credits?api_key=${TMDB_KEY}&language=en-US`);

  const movies = (credits.crew || [])
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

  return {
    cachedAt: Date.now(),
    person:   { id: person.id, name: person.name, profilePath: person.profile_path || null },
    movies,
  };
}

// Refresh a stale cache entry in the background (fire-and-forget)
function refreshDirectorInBackground(name) {
  const key = name.toLowerCase();
  fetchDirectorFilmography(name)
    .then(entry => {
      if (entry) { directorCache[key] = entry; saveDirectorCache(); }
    })
    .catch(() => {});
}

app.get('/api/director/filmography', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name || !TMDB_KEY) return res.json({ person: null, movies: [] });

  const key    = name.toLowerCase();
  const cached = directorCache[key];
  const now    = Date.now();
  const { watchlistIds, watchedIds } = buildLibrarySets();

  // Always serve from cache immediately if available (stale-while-revalidate)
  if (cached) {
    if (now - cached.cachedAt > DIRECTOR_CACHE_TTL) refreshDirectorInBackground(name);
    return res.json({ person: cached.person, movies: annotateWithLibrary(cached.movies, watchlistIds, watchedIds) });
  }

  // First-ever request: fetch synchronously then cache
  try {
    const entry = await fetchDirectorFilmography(name);
    if (!entry) return res.json({ person: null, movies: [] });
    directorCache[key] = entry;
    saveDirectorCache();
    res.json({ person: entry.person, movies: annotateWithLibrary(entry.movies, watchlistIds, watchedIds) });
  } catch (e) {
    console.error('Director filmography error:', e.message);
    res.status(500).json({ person: null, movies: [] });
  }
});

// Proactively backfill filmographies for all directors in the library
async function backfillDirectorCache() {
  if (!TMDB_KEY) return;
  const allDirectors = new Set(
    [...watchlist, ...watchedList]
      .flatMap(m => tmdbCache[m['Letterboxd URI']]?.directors || [])
  );
  const toFetch = [...allDirectors].filter(d => {
    const e = directorCache[d.toLowerCase()];
    return !e || (Date.now() - e.cachedAt > DIRECTOR_CACHE_TTL);
  });
  if (!toFetch.length) return;
  console.log(`🎬 Backfilling director cache: ${toFetch.length} directors`);
  let saved = 0;
  for (const name of toFetch) {
    try {
      const entry = await fetchDirectorFilmography(name);
      if (entry) {
        directorCache[name.toLowerCase()] = entry;
        saved++;
        // Save every 10 directors so restarts don't lose progress
        if (saved % 10 === 0) saveDirectorCache();
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  saveDirectorCache();
  console.log('🎬 Director cache backfill complete');
}

// After director backfill: fetch full details + posters for all discover films
async function backfillDiscoverDetails() {
  if (!TMDB_KEY) return;

  // Collect all unique (tmdbId, posterPath) pairs from directorCache
  const allFilms = new Map(); // tmdbId → posterPath
  for (const entry of Object.values(directorCache)) {
    for (const film of (entry.movies || [])) {
      if (film.tmdbId && !allFilms.has(film.tmdbId)) {
        allFilms.set(film.tmdbId, film.posterPath);
      }
    }
  }
  if (!allFilms.size) return;

  // Pass 1: fetch full TMDB details for films missing from tmdbCache
  const existingIds = new Set(Object.values(tmdbCache).map(c => c?.tmdbId).filter(Boolean));
  const toFetch = [...allFilms.keys()].filter(id => !existingIds.has(id));

  if (toFetch.length) {
    console.log(`📽  Backfilling details for ${toFetch.length} discover films...`);
    let done = 0;
    for (const tmdbId of toFetch) {
      const uri = localUri(tmdbId);
      if (tmdbCache[uri]?.tmdbId) { done++; continue; }
      try {
        const d = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
        tmdbCache[uri] = buildCacheEntry(d);
        if (d.poster_path) allFilms.set(tmdbId, d.poster_path); // update with accurate path
        done++;
      } catch {}
      if (done % 20 === 0) saveCache();
      await new Promise(r => setTimeout(r, 300));
    }
    saveCache();
    console.log(`📽  Detail backfill done: ${done}/${toFetch.length} films`);
  }

  // Pass 2: download missing poster files (image CDN, gentler rate limit)
  let postersDone = 0;
  for (const [tmdbId, fallbackPath] of allFilms) {
    const posterFile = join(__dirname, 'public', 'posters', `${tmdbId}.jpg`);
    if (existsSync(posterFile)) continue;
    const uri    = localUri(tmdbId);
    const path   = tmdbCache[uri]?.posterPath || fallbackPath;
    if (!path) continue;
    try {
      const r = await fetch(`https://image.tmdb.org/t/p/w342${path}`);
      if (r.ok) { writeFileSync(posterFile, Buffer.from(await r.arrayBuffer())); postersDone++; }
    } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  if (postersDone > 0) console.log(`📽  Downloaded ${postersDone} discover posters`);
}

// ── TMDB movie details (for discover films) ───────────────────────────────────

app.get('/api/tmdb/movie/:tmdbId', async (req, res) => {
  const id = parseInt(req.params.tmdbId);
  if (!id || !TMDB_KEY) return res.status(400).json({ error: 'invalid' });

  // Check existing cache first
  const tempUri = `local://movie/${id}`;
  if (tmdbCache[tempUri]?.tmdbId) return res.json(tmdbCache[tempUri]);
  const found = Object.values(tmdbCache).find(c => c?.tmdbId === id);
  if (found) return res.json(found);

  try {
    const d = await tmdbFetch(`${TMDB_BASE}/movie/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
    const entry = buildCacheEntry(d);
    tmdbCache[tempUri] = entry;
    saveCache();

    // Download poster so subsequent discover loads use local file
    if (d.poster_path) {
      const posterFile = join(__dirname, 'public', 'posters', `${id}.jpg`);
      if (!existsSync(posterFile)) {
        fetch(`https://image.tmdb.org/t/p/w342${d.poster_path}`)
          .then(r => r.ok ? r.arrayBuffer() : null)
          .then(buf => { if (buf) writeFileSync(posterFile, Buffer.from(buf)); })
          .catch(() => {});
      }
    }

    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Local library ─────────────────────────────────────────────────────────────

app.get('/api/local-library', (req, res) => {
  res.json(localLib);
});

app.post('/api/local-library', async (req, res) => {
  const { tmdbId, title, year, posterPath, action } = req.body; // action: 'watchlist' | 'watched'
  if (!tmdbId || !action) return res.status(400).json({ error: 'tmdbId and action required' });

  const uri = localUri(tmdbId);

  // Fetch full details if not yet cached
  if (!tmdbCache[uri]?.tmdbId && TMDB_KEY) {
    try {
      const d = await tmdbFetch(`${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`);
      tmdbCache[uri] = buildCacheEntry(d);
      saveCache();
    } catch {}
  }

  const entry = { tmdbId, title, year, posterPath: posterPath || tmdbCache[uri]?.posterPath || null };

  // Remove from both lists first to avoid dupes
  localLib.watchlist = localLib.watchlist.filter(e => e.tmdbId !== tmdbId);
  localLib.watched   = localLib.watched.filter(e => e.tmdbId !== tmdbId);

  if (action === 'watchlist') {
    entry.addedAt = new Date().toISOString().slice(0, 10);
    localLib.watchlist.push(entry);
  } else if (action === 'watched') {
    entry.watchedAt = new Date().toISOString().slice(0, 10);
    localLib.watched.push(entry);
  }

  saveLocalLib();

  // Update live in-memory lists so grid reflects change without restart
  const row = makeLocalRow({ ...entry, addedAt: entry.addedAt, watchedAt: entry.watchedAt });
  watchlist   = watchlist.filter(m => m['Letterboxd URI'] !== uri);
  watchedList = watchedList.filter(m => m['Letterboxd URI'] !== uri);
  watchedSet.delete(uri);
  if (action === 'watchlist') {
    watchlist.push(row);
  } else {
    watchedList.push(row);
    watchedSet.add(uri);
  }

  res.json({ ok: true });
});

app.delete('/api/local-library/:tmdbId', (req, res) => {
  const tmdbId = parseInt(req.params.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: 'invalid' });
  const uri = localUri(tmdbId);

  localLib.watchlist = localLib.watchlist.filter(e => e.tmdbId !== tmdbId);
  localLib.watched   = localLib.watched.filter(e => e.tmdbId !== tmdbId);
  saveLocalLib();

  watchlist   = watchlist.filter(m => m['Letterboxd URI'] !== uri);
  watchedList = watchedList.filter(m => m['Letterboxd URI'] !== uri);
  watchedSet.delete(uri);

  res.json({ ok: true });
});

// ── Discover ──────────────────────────────────────────────────────────────────

app.get('/api/discover', (req, res) => {
  const { sort = 'affinity', page = 1, limit = 28, q, genre, country, maxRuntime } = req.query;

  let films = buildDiscoverPool();

  // Aggregate genres/countries from ALL films (pre-filter) so the dropdowns reflect discover's universe
  const discoverGenreCount = {};
  const discoverCountryCount = {};
  films.forEach(f => {
    (f.genres || []).forEach(g => { discoverGenreCount[g] = (discoverGenreCount[g] || 0) + 1; });
    (f.countries || []).forEach(c => { discoverCountryCount[c] = (discoverCountryCount[c] || 0) + 1; });
  });
  const discoverGenres    = Object.entries(discoverGenreCount).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const discoverCountries = Object.entries(discoverCountryCount).sort((a, b) => b[1] - a[1]).map(([c]) => c);

  if (q) {
    const nq = q.toLowerCase();
    films = films.filter(f =>
      f.title.toLowerCase().includes(nq) ||
      f.directors.some(d => d.toLowerCase().includes(nq))
    );
  }
  if (genre && genre !== 'all') {
    films = films.filter(f => f.genres.includes(genre));
  }
  if (country && country !== 'all') {
    films = films.filter(f => (f.countries || []).includes(country));
  }
  if (maxRuntime) {
    const max = parseInt(maxRuntime);
    films = films.filter(f => f.runtime && Math.round(f.runtime * (parseFloat(req.query.ratio) || 1)) <= max);
  }

  // Sorting
  if (sort === 'affinity') {
    films.sort((a, b) => {
      const s = f => f.affinity * (f.voteAverage || 0) * Math.log10((f.voteCount || 0) + 10);
      return s(b) - s(a);
    });
  } else if (sort === 'rating') {
    films.sort((a, b) => {
      const ra = (a.voteCount || 0) >= 100 ? (a.voteAverage || 0) : -1;
      const rb = (b.voteCount || 0) >= 100 ? (b.voteAverage || 0) : -1;
      return rb - ra;
    });
  } else if (sort === 'votes') {
    films.sort((a, b) => (b.voteCount || 0) - (a.voteCount || 0));
  } else if (sort === 'year-new') {
    films.sort((a, b) => (b.year || 0) - (a.year || 0));
  } else if (sort === 'year-old') {
    films.sort((a, b) => (a.year || 0) - (b.year || 0));
  }

  const total = films.length;
  const pg    = parseInt(page);
  const lim   = parseInt(limit);
  const start = (pg - 1) * lim;
  const slice = films.slice(start, start + lim);

  const movies = slice.map(f => ({
    id:          f.id,
    source:      'discover',
    tmdbId:      f.tmdbId,
    name:        f.title,
    year:        f.year,
    posterPath:  f.posterPath,
    posterId:    f.posterId,
    voteAverage: f.voteAverage,
    voteCount:   f.voteCount,
    overview:    f.overview,
    directors:   f.directors,
    genres:      f.genres,
    countries:   f.countries || [],
    runtime:     f.runtime,
    enriched:    true,
    released:    true,
    watched:     false,
  }));

  res.json({ movies, total, page: pg, hasMore: start + slice.length < total, genres: discoverGenres, countries: discoverCountries });
});

app.get('/api/discover/random', (req, res) => {
  const { maxRuntime } = req.query;
  const ratio = parseFloat(req.query.ratio) || 1;
  let pool = buildDiscoverPool().filter(f => f.runtime);
  if (maxRuntime) {
    const max = parseInt(maxRuntime);
    pool = pool.filter(f => Math.round(f.runtime * ratio) <= max);
  }
  if (!pool.length) return res.json({ film: null });
  pool.sort((a, b) => {
    const s = f => f.affinity * (f.voteAverage || 0) * Math.log10((f.voteCount || 0) + 10);
    return s(b) - s(a);
  });
  const TOP = Math.max(50, Math.floor(pool.length * 0.1));
  pool = pool.slice(0, TOP);
  const f = pool[Math.floor(Math.random() * pool.length)];
  res.json({ film: { id: f.id, source: 'discover', tmdbId: f.tmdbId, name: f.title, year: f.year,
    posterPath: f.posterPath, posterId: f.posterId, voteAverage: f.voteAverage, voteCount: f.voteCount,
    overview: f.overview, directors: f.directors, genres: f.genres, countries: f.countries || [],
    runtime: f.runtime, enriched: true, released: true, watched: false } });
});

// ── Series management ─────────────────────────────────────────────────────────

const SERIES_GROUPS_FILE = join(__dirname, 'series-groups.json');

function saveSeriesGroups() {
  const out = { _comment: 'Series grouping config. Key = prefix used in Letterboxd episode titles. tmdbTvId = TMDB TV show ID.' };
  Object.assign(out, seriesGroups);
  writeFileSync(SERIES_GROUPS_FILE, JSON.stringify(out, null, 2));
}

app.get('/api/series/groups', (req, res) => {
  res.json(Object.entries(seriesGroups).map(([name, cfg]) => ({ name, tmdbTvId: cfg.tmdbTvId })));
});

app.post('/api/series/groups', async (req, res) => {
  const { name, tmdbTvId, remove } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (remove) {
    delete seriesGroups[name];
  } else {
    if (!tmdbTvId) return res.status(400).json({ error: 'tmdbTvId required' });
    seriesGroups[name] = { tmdbTvId };
    if (!seriesCache[name]) await fetchSeriesData(name);
  }
  saveSeriesGroups();
  res.json({ ok: true, groups: Object.entries(seriesGroups).map(([n, c]) => ({ name: n, tmdbTvId: c.tmdbTvId })) });
});

// Scan all movies for potential series patterns (2+ entries sharing a prefix before ":" or " - ")
app.get('/api/series/candidates', (req, res) => {
  const allMovies = [...new Map(
    [...watchlist, ...watchedList].map(m => [m['Letterboxd URI'], m])
  ).values()];

  const prefixMap = {};
  for (const m of allMovies) {
    const name = m['Name'];
    // Match "Prefix: ..." or "Prefix - ..." patterns
    const colon = name.indexOf(': ');
    const dash  = name.indexOf(' - ');
    const sep   = colon >= 0 ? colon : (dash >= 0 ? dash : -1);
    if (sep < 3) continue; // prefix must be at least 3 chars
    const prefix = name.slice(0, sep).trim();
    if (!prefix) continue;
    if (!prefixMap[prefix]) prefixMap[prefix] = { count: 0, example: name };
    prefixMap[prefix].count++;
  }

  const known = new Set(Object.keys(seriesGroups));
  const candidates = Object.entries(prefixMap)
    .filter(([p, v]) => v.count >= 2)
    .map(([p, v]) => ({
      name:    p,
      count:   v.count,
      example: v.example,
      known:   known.has(p),
    }))
    .sort((a, b) => b.count - a.count);

  res.json({ candidates, known: [...known] });
});

app.get('/api/stats', (req, res) => {
  const movies   = watchlist.map(buildMovie).filter(m => !watchedSet.has(m.uri));
  const enriched = movies.filter(m => m.enriched);
  const genreCount = {};
  enriched.forEach(m => m.genres.forEach(g => { genreCount[g] = (genreCount[g] || 0) + 1; }));
  const genres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const countryCount = {};
  enriched.forEach(m => (m.countries || []).forEach(c => { countryCount[c] = (countryCount[c] || 0) + 1; }));
  const countries = Object.entries(countryCount).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  res.json({
    total: movies.length, watched: watchedSet.size,
    enriched: enriched.length, genres, countries,
    percent: Math.round(enriched.length / movies.length * 100),
  });
});

app.get('/api/enrich-status', (req, res) => {
  const allUris = new Set([
    ...watchlist.map(m => m['Letterboxd URI']),
    ...watchedList.map(m => m['Letterboxd URI']),
    ...ratingsList.map(m => m['Letterboxd URI']),
  ]);
  const done = [...allUris].filter(uri => tmdbCache[uri]?.tmdbId).length;
  const allForBroken = new Map();
  watchedList.forEach(m => allForBroken.set(m['Letterboxd URI'], m));
  watchlist.forEach(m => allForBroken.set(m['Letterboxd URI'], m));
  const brokenCount = [...allForBroken.entries()].filter(([uri, row]) => {
    if (getSeriesGroup(row['Name'], parseInt(row['Year']) || null)) return false;
    const c = tmdbCache[uri];
    if (!c) return false;
    const ly = parseInt(row['Year']) || 0;
    const ty = c.releaseDate ? parseInt(c.releaseDate.slice(0, 4)) : 0;
    return !!(c.suspectMatch) || !!(c.tmdbId && isSuspectYear(ly, ty))
        || ((c.failed || c.notFound) && !(uri in overrides));
  }).length;
  res.json({ total: allUris.size, done, running: enrichStatus.running, percent: Math.min(100, Math.round(done / allUris.size * 100)), brokenCount });
});

// ── Analytics ─────────────────────────────────────────────────────────────────

app.get('/api/analytics', (req, res) => {
  // Build rated movies with TMDB data
  const ratedMovies = ratingsList.map(r => {
    const uri = r['Letterboxd URI'];
    const c   = tmdbCache[uri];
    return {
      name:        r['Name'],
      year:        parseInt(r['Year']) || 0,
      myRating:    parseFloat(r['Rating']) || 0,
      tmdbId:      c?.tmdbId      ?? null,
      runtime:     c?.runtime     ?? null,
      voteAverage: c?.voteAverage ?? null,
      voteCount:   c?.voteCount   ?? null,
      genres:      c?.genres      ?? [],
      countries:   c?.countries   ?? [],
      language:    c?.language    ?? null,
      posterPath:  c?.posterPath  ?? null,
      enriched:    !!(c?.tmdbId),
    };
  });

  const E = ratedMovies.filter(m => m.enriched && m.myRating > 0);

  // ── Overview
  // Use all rated movies for runtime estimation; fall back to avg of known runtimes
  const withRuntime   = E.filter(m => m.runtime);
  const knownMinutes  = withRuntime.reduce((s, m) => s + m.runtime, 0);
  const avgRuntime    = withRuntime.length ? knownMinutes / withRuntime.length : 100;
  // Estimate total: known runtime for enriched + avg for the rest
  const allRated      = ratedMovies.filter(m => m.myRating > 0);
  const totalMinutes  = allRated.reduce((s, m) => s + (m.runtime || avgRuntime), 0);
  const avgRating     = allRated.length
    ? Math.round(allRated.reduce((s, m) => s + m.myRating, 0) / allRated.length * 10) / 10 : 0;
  const enrichedPct   = allRated.length ? Math.round(withRuntime.length / allRated.length * 100) : 0;

  const ratingDist = {};
  for (let r = 0.5; r <= 5; r += 0.5) ratingDist[r.toFixed(1)] = 0;
  ratedMovies.forEach(m => { const k = m.myRating.toFixed(1); if (ratingDist[k] !== undefined) ratingDist[k]++; });

  // ── Decades (use all rated movies by year from CSV, no enrichment needed)
  const decMap = {};
  allRated.forEach(m => {
    if (!m.year || m.year < 1880) return;
    const d = Math.floor(m.year / 10) * 10;
    if (!decMap[d]) decMap[d] = { count: 0, mySum: 0, tmdbSum: 0, tmdbN: 0 };
    decMap[d].count++; decMap[d].mySum += m.myRating;
    if (m.voteAverage) { decMap[d].tmdbSum += m.voteAverage; decMap[d].tmdbN++; }
  });
  const decades = Object.entries(decMap).sort((a, b) => +a[0] - +b[0]).map(([d, v]) => ({
    decade: +d, label: `${d}s`, count: v.count,
    avgMyRating: Math.round(v.mySum / v.count * 10) / 10,
    avgTmdb:     v.tmdbN ? Math.round(v.tmdbSum / v.tmdbN * 10) / 10 : null,
  }));

  // ── Genres (enriched only, but decades above uses all)
  const gMap = {};
  E.forEach(m => m.genres.forEach(g => {
    if (!gMap[g]) gMap[g] = { count: 0, sum: 0 };
    gMap[g].count++; gMap[g].sum += m.myRating;
  }));
  const genres = Object.entries(gMap)
    .map(([name, v]) => ({ name, count: v.count, avgRating: Math.round(v.sum / v.count * 10) / 10 }))
    .sort((a, b) => b.count - a.count).slice(0, 15);

  // ── Countries
  const cMap = {};
  E.forEach(m => (m.countries || []).forEach(c => { cMap[c] = (cMap[c] || 0) + 1; }));
  const countries = Object.entries(cMap).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  // ── Languages
  const lMap = {};
  E.forEach(m => { if (m.language) { lMap[m.language] = (lMap[m.language] || 0) + 1; } });
  const LANG = { en:'English', fr:'French', ko:'Korean', ja:'Japanese', it:'Italian', de:'German', es:'Spanish', zh:'Mandarin', pt:'Portuguese', ru:'Russian', hi:'Hindi', sv:'Swedish', da:'Danish', nl:'Dutch', pl:'Polish', no:'Norwegian', tr:'Turkish', ar:'Arabic', th:'Thai', fi:'Finnish', hu:'Hungarian', cs:'Czech', ro:'Romanian' };
  const languages = Object.entries(lMap).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([code, count]) => ({ code, name: LANG[code] || code.toUpperCase(), count }));

  // ── You vs Crowd (diff on 0-5 scale, same as Letterboxd)
  const divergence = E
    .filter(m => m.voteAverage && m.voteCount >= 500)  // only reliable crowd votes
    .map(m => ({
      name: m.name, year: m.year, posterPath: m.posterPath, tmdbId: m.tmdbId,
      myRating: m.myRating, tmdb: m.voteAverage,
      // Both on 0-5 scale
      diff: Math.round((m.myRating - m.voteAverage / 2) * 10) / 10,
    }))
    .sort((a, b) => b.diff - a.diff);
  // Only show items with meaningful divergence (>= 1 star gap on 0-5 scale)
  const hiddenGems = divergence.filter(m => m.diff >= 1.0).slice(0, 12);
  const overrated  = divergence.filter(m => m.diff <= -1.0).slice(-12).reverse();

  // ── Watching pace (diary.csv) — use Watched Date field
  let diary = [];
  try { diary = loadCSV('diary.csv'); } catch {}
  const paceMap = {};
  diary.forEach(e => {
    const date = e['Watched Date'] || e['Date'];
    if (!date) return;
    const ym = date.slice(0, 7);
    paceMap[ym] = (paceMap[ym] || 0) + 1;
  });
  const pace = Object.entries(paceMap).sort((a, b) => a[0].localeCompare(b[0])).slice(-24)
    .map(([month, count]) => ({ month, count }));

  // ── Seasonal watching (average per month, normalized across years)
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seasonMap  = Array(12).fill(0);
  const seasonYears = Array.from({length: 12}, () => new Set());
  const nowYear = new Date().getFullYear().toString();
  const nowMonth = new Date().getMonth(); // 0-indexed
  diary.forEach(e => {
    const date = e['Watched Date'] || e['Date'];
    if (!date) return;
    const mo = parseInt(date.slice(5, 7)) - 1;
    const yr = date.slice(0, 4);
    if (mo >= 0 && mo < 12) {
      // Skip current incomplete month
      if (yr === nowYear && mo === nowMonth) return;
      seasonMap[mo]++;
      seasonYears[mo].add(yr);
    }
  });
  const seasonal = monthNames.map((name, i) => {
    const years = seasonYears[i].size || 1;
    return { name, count: Math.round(seasonMap[i] / years * 10) / 10 };
  });

  // ── Rewatches from diary (with poster lookup)
  // Diary URIs are diary-entry-specific, NOT canonical movie URIs — build name→cache via watchlist+ratings
  const nameToCache = {};
  watchlist.forEach(m => {
    const c = tmdbCache[m['Letterboxd URI']];
    if (c?.posterPath) nameToCache[m['Name']] = c;
  });
  ratingsList.forEach(r => {
    if (!nameToCache[r['Name']]) {
      const c = tmdbCache[r['Letterboxd URI']];
      if (c?.posterPath) nameToCache[r['Name']] = c;
    }
  });

  const rewatchMap = {};
  diary.forEach(e => {
    if ((e['Rewatch'] || '').toLowerCase() === 'yes') {
      rewatchMap[e['Name']] = (rewatchMap[e['Name']] || 0) + 1;
    }
  });
  const rewatches = Object.entries(rewatchMap).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const c = nameToCache[name];
      const r = ratingsList.find(r => r['Name'] === name);
      const myRating = r ? parseFloat(r['Rating']) || 0 : 0;
      return { name, count: count + 1, myRating, posterPath: c?.posterPath ?? null, tmdbId: c?.tmdbId ?? null };
    })
    .sort((a, b) => b.count - a.count || b.myRating - a.myRating);
  const totalRewatches = Object.values(rewatchMap).reduce((s, n) => s + n, 0);

  // ── Recent watches — popular vs rare gems
  const sortedDiary = [...diary].sort((a, b) => {
    const da = a['Watched Date'] || a['Date'] || '';
    const db = b['Watched Date'] || b['Date'] || '';
    return db.localeCompare(da);
  });
  const seenRecent = new Set();
  const recentEntries = [];
  for (const e of sortedDiary) {
    const name = e['Name'];
    if (!name || seenRecent.has(name)) continue;
    seenRecent.add(name);
    recentEntries.push(e);
  }
  const toRecentMovie = (e) => {
    const c = nameToCache[e['Name']] || {};
    const r = ratingsList.find(r => r['Name'] === e['Name']);
    const myRating = parseFloat(e['Rating']) || (r ? parseFloat(r['Rating']) || 0 : 0);
    return {
      name: e['Name'],
      year: parseInt(e['Year']) || 0,
      watchedDate: e['Watched Date'] || e['Date'] || '',
      myRating,
      voteCount: c.voteCount || 0,
      voteAverage: c.voteAverage ?? null,
      posterPath: c.posterPath ?? null,
      tmdbId: c.tmdbId ?? null,
    };
  };
  const MAINSTREAM_MIN_VOTES = 2000; // mid-range tier and above — no padding below this
  const recentPopular = recentEntries.slice(0, 100)
    .map(toRecentMovie)
    .filter(m => m.voteCount >= MAINSTREAM_MIN_VOTES)
    .sort((a, b) => b.watchedDate.localeCompare(a.watchedDate))
    .slice(0, 12);

  const rarePool = recentEntries.slice(0, 100)
    .map(toRecentMovie)
    .filter(m => m.voteCount > 0);
  const rareVotes = rarePool.map(m => m.voteCount).sort((a, b) => a - b);
  const rareCutoff = rareVotes[Math.floor(rareVotes.length * 0.25)] || 0;
  const rarestGems = rarePool
    .filter(m => m.voteCount <= rareCutoff)
    .sort((a, b) => b.watchedDate.localeCompare(a.watchedDate))
    .slice(0, 12);

  // ── Year progress (YTD from Jan 1)
  const now = new Date();
  const year = now.getFullYear();
  const dayOfYear = Math.floor((now - new Date(year, 0, 1)) / 86400000) + 1;
  const daysInYear = ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
  const ytdDiary = diary.filter(e => {
    const d = e['Watched Date'] || e['Date'] || '';
    return d.startsWith(String(year));
  });
  const uniqueYtd = new Set(ytdDiary.map(e => e['Name']).filter(Boolean)).size;
  const totalYtd = ytdDiary.length;
  const avgPerDay = dayOfYear ? Math.round(totalYtd / dayOfYear * 100) / 100 : 0;
  const ytdMinutes = ytdDiary.reduce((s, e) => {
    const rt = nameToCache[e['Name']]?.runtime || avgRuntime;
    return s + rt;
  }, 0);
  const yearProgress = {
    year,
    dayOfYear,
    daysInYear,
    uniqueMovies: uniqueYtd,
    totalWithRepeats: totalYtd,
    avgPerDay,
    hoursWatched: Math.round(ytdMinutes / 60),
  };

  // ── Film length buckets (enriched rated movies)
  const lengthBuckets = [
    { label: 'Short',      sublabel: '< 80 min',     count: 0 },
    { label: 'Standard',   sublabel: '80–110 min',   count: 0 },
    { label: 'Feature',    sublabel: '110–140 min',  count: 0 },
    { label: 'Long',       sublabel: '140–180 min',  count: 0 },
    { label: 'Epic',       sublabel: '180+ min',     count: 0 },
  ];
  withRuntime.forEach(m => {
    if      (m.runtime < 80)  lengthBuckets[0].count++;
    else if (m.runtime < 110) lengthBuckets[1].count++;
    else if (m.runtime < 140) lengthBuckets[2].count++;
    else if (m.runtime < 180) lengthBuckets[3].count++;
    else                       lengthBuckets[4].count++;
  });

  // ── Popularity tiers (adjusted for TMDB scale — max ~40K votes on TMDB)
  const tiers = [
    { label: 'Hidden gem',   sublabel: '< 500 votes',     count: 0 },
    { label: 'Arthouse',     sublabel: '500 – 2K',        count: 0 },
    { label: 'Mid-range',    sublabel: '2K – 8K',         count: 0 },
    { label: 'Popular',      sublabel: '8K – 20K',        count: 0 },
    { label: 'Blockbuster',  sublabel: '20K+',            count: 0 },
  ];
  E.forEach(m => {
    const v = m.voteCount || 0;
    if      (v < 500)    tiers[0].count++;
    else if (v < 2000)   tiers[1].count++;
    else if (v < 8000)   tiers[2].count++;
    else if (v < 20000)  tiers[3].count++;
    else                 tiers[4].count++;
  });

  // ── Taste profile (for smart suggestions tooltip)
  // ── Watchlist ETA
  const remaining = watchlist
    .filter(m => !watchedSet.has(m['Letterboxd URI']))
    .map(buildMovie);
  const withRt   = remaining.filter(m => m.runtime);
  const avgRt    = withRt.length ? withRt.reduce((s, m) => s + m.runtime, 0) / withRt.length : 105;
  const DEF_RATIO = 0.88;
  const watchlistHoursLeft = Math.round(remaining.length * avgRt * DEF_RATIO / 60);

  // Pace from last 3 months of diary
  const cutoff3m = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent3m = diary.filter(e => {
    const d = e['Watched Date'] || e['Date'];
    return d && d >= cutoff3m;
  }).length;
  const monthlyPace = recent3m / 3; // avg movies per month

  const etaMonths = monthlyPace > 0 ? remaining.length / monthlyPace : null;

  const profile    = buildTasteProfile();
  const topGenres  = Object.entries(profile.genrePrefs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, s]) => ({ genre: g, score: Math.round(s * 10) / 10 }));
  const topDecades = Object.entries(profile.decadePrefs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, s]) => ({ decade: +d, score: Math.round(s * 10) / 10 }));

  // ── Cinephile DNA Radar Chart
  const totalE = E.length || 1;
  // Explorer: unique countries diversity (normalized to 0-100)
  const uniqueCountries = new Set(); E.forEach(m => (m.countries||[]).forEach(c => uniqueCountries.add(c)));
  const explorerScore = Math.min(100, Math.round(uniqueCountries.size / 80 * 100));
  // Indie: % in hidden gem + arthouse tiers
  const indieCount = E.filter(m => (m.voteCount||0) < 10000).length;
  const indieScore = Math.round(indieCount / totalE * 100);
  // Critic: how much you diverge from crowd (harsher = higher)
  const withCrowd = E.filter(m => m.voteAverage && m.voteCount >= 100);
  const avgDivergence = withCrowd.length ? withCrowd.reduce((s, m) => s + (m.voteAverage/2 - m.myRating), 0) / withCrowd.length : 0;
  const criticScore = Math.min(100, Math.max(0, Math.round(50 + avgDivergence * 25)));
  // Binger: monthly pace normalized (60+/mo = 100)
  const bingerScore = Math.min(100, Math.round(monthlyPace / 60 * 100));
  // Retro: weighted toward older films (pre-2000 gets more weight)
  const retroCount = allRated.filter(m => m.year && m.year < 2000).length;
  const retroScore = Math.min(100, Math.round(retroCount / (allRated.length || 1) * 130));
  // Loyalist: rewatch rate + director concentration
  const rewatchRate = diary.length ? (Object.values(rewatchMap).reduce((s,n)=>s+n,0) / diary.length) : 0;
  const dirCountMap = {}; E.forEach(m => { const c = tmdbCache[ratingsList.find(r => r['Name']===m.name && r['Year']===String(m.year))?.['Letterboxd URI']]; (c?.directors||[]).forEach(d => { dirCountMap[d] = (dirCountMap[d]||0)+1; }); });
  const topDirShare = Object.values(dirCountMap).sort((a,b)=>b-a).slice(0,3).reduce((s,n)=>s+n,0) / totalE;
  const loyalistScore = Math.min(100, Math.round((rewatchRate * 200 + topDirShare * 200) / 2));
  const radarChart = [
    { axis: 'Explorer', value: explorerScore, description: `${uniqueCountries.size} countries` },
    { axis: 'Indie', value: indieScore, description: `${indieCount} films < 10K votes` },
    { axis: 'Critic', value: criticScore, description: avgDivergence > 0 ? `${avgDivergence.toFixed(1)}★ harsher than crowd` : `${Math.abs(avgDivergence).toFixed(1)}★ gentler than crowd` },
    { axis: 'Binger', value: bingerScore, description: `${Math.round(monthlyPace*10)/10} movies/month` },
    { axis: 'Retro', value: retroScore, description: `${retroCount} pre-2000 films` },
    { axis: 'Loyalist', value: loyalistScore, description: `${totalRewatches} rewatches` },
  ];

  // ── Director Spotlight (top 10 most watched)
  const dirFilms = {};
  E.forEach(m => {
    const uri = ratingsList.find(r => r['Name'] === m.name && r['Year'] === String(m.year))?.['Letterboxd URI'];
    const c = uri ? tmdbCache[uri] : null;
    (c?.directors || []).forEach(d => {
      if (!dirFilms[d]) dirFilms[d] = [];
      dirFilms[d].push({ name: m.name, year: m.year, myRating: m.myRating, posterPath: m.posterPath, tmdbId: m.tmdbId });
    });
  });
  const directorSpotlight = Object.entries(dirFilms)
    .filter(([, films]) => films.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([name, films]) => {
      const avgR = Math.round(films.reduce((s, f) => s + f.myRating, 0) / films.length * 10) / 10;
      const best = films.reduce((a, b) => a.myRating >= b.myRating ? a : b);
      const worst = films.reduce((a, b) => a.myRating <= b.myRating ? a : b);
      return { name, count: films.length, avgRating: avgR, best, worst, films: films.sort((a,b) => b.myRating - a.myRating) };
    });

  // ── Rating Evolution (quarterly averages over time)
  const quarterMap = {};
  diary.forEach(e => {
    const date = e['Watched Date'] || e['Date'];
    const rating = parseFloat(e['Rating']);
    if (!date || !rating) return;
    const y = date.slice(0, 4);
    const q = Math.ceil(parseInt(date.slice(5, 7)) / 3);
    const key = `${y}-Q${q}`;
    if (!quarterMap[key]) quarterMap[key] = { sum: 0, count: 0 };
    quarterMap[key].sum += rating; quarterMap[key].count++;
  });
  const ratingEvolution = Object.entries(quarterMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-16)
    .map(([quarter, v]) => ({ quarter, avg: Math.round(v.sum / v.count * 100) / 100, count: v.count }));

  // ── Genre × Decade Heatmap
  const gdMap = {};
  const heatGenres = new Set();
  const heatDecades = new Set();
  E.forEach(m => {
    const decade = Math.floor(m.year / 10) * 10;
    if (!decade) return;
    m.genres.forEach(g => {
      const key = `${g}|${decade}`;
      if (!gdMap[key]) gdMap[key] = { sum: 0, count: 0 };
      gdMap[key].sum += m.myRating; gdMap[key].count++;
      heatGenres.add(g);
      heatDecades.add(decade);
    });
  });
  const topHeatGenres = [...heatGenres].filter(g => {
    let total = 0;
    for (const [k, v] of Object.entries(gdMap)) { if (k.startsWith(g + '|')) total += v.count; }
    return total >= 5;
  }).sort((a, b) => {
    let ta = 0, tb = 0;
    for (const [k, v] of Object.entries(gdMap)) { if (k.startsWith(a + '|')) ta += v.count; if (k.startsWith(b + '|')) tb += v.count; }
    return tb - ta;
  }).slice(0, 8);
  const sortedHeatDecades = [...heatDecades].sort((a, b) => a - b);
  const genreDecadeHeatmap = {
    genres: topHeatGenres,
    decades: sortedHeatDecades,
    cells: topHeatGenres.map(g => sortedHeatDecades.map(d => {
      const cell = gdMap[`${g}|${d}`];
      return cell ? { avg: Math.round(cell.sum / cell.count * 10) / 10, count: cell.count } : null;
    })),
  };

  res.json({
    overview: {
      total:             allRated.length,
      enriched:          withRuntime.length,
      enrichedPct,
      avgRating,
      totalRuntimeHours: Math.round(totalMinutes / 60),
      ratingDist:        Object.entries(ratingDist).map(([r, c]) => ({ rating: +r, count: c })),
    },
    diaryTotal: diary.length,
    totalRewatches,
    rewatches,
    recentPopular,
    rarestGems,
    yearProgress,
    watchlistEta: {
      remaining:   remaining.length,
      hoursLeft:   watchlistHoursLeft,
      monthlyPace: Math.round(monthlyPace * 10) / 10,
      etaMonths:   etaMonths ? Math.round(etaMonths * 10) / 10 : null,
    },
    decades, genres, countries, languages,
    divergence: { hiddenGems, overrated },
    pace, seasonal, popularityTiers: tiers, lengthBuckets,
    tasteProfile: { topGenres, topDecades },
    radarChart, directorSpotlight, ratingEvolution, genreDecadeHeatmap,
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

function makeLocalRow(entry) {
  return {
    'Letterboxd URI': localUri(entry.tmdbId),
    'Name':  entry.title,
    'Year':  String(entry.year || ''),
    'Date':  entry.addedAt || entry.watchedAt || '',
    '_local': true,
  };
}

function init() {
  watchlist = loadCSV('watchlist.csv');
  try { ratingsList = loadCSV('ratings.csv'); } catch {}
  try {
    watchedList = loadCSV('watched.csv');
    watchedSet  = new Set(watchedList.map(m => m['Letterboxd URI']));
  } catch {}

  if (existsSync(CACHE_FILE)) {
    try { tmdbCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch {}
  }

  // Merge local library entries on top of Letterboxd CSVs
  const lbxdWlUris = new Set(watchlist.map(m => m['Letterboxd URI']));
  const lbxdWdUris = new Set(watchedList.map(m => m['Letterboxd URI']));
  for (const entry of localLib.watchlist) {
    const uri = localUri(entry.tmdbId);
    if (!lbxdWlUris.has(uri) && !lbxdWdUris.has(uri)) watchlist.push(makeLocalRow(entry));
  }
  for (const entry of localLib.watched) {
    const uri = localUri(entry.tmdbId);
    if (!lbxdWdUris.has(uri)) {
      const row = makeLocalRow(entry);
      watchedList.push(row);
      watchedSet.add(uri);
    }
  }

  const enrichedCount = Object.values(tmdbCache).filter(v => v?.tmdbId).length;
  enrichStatus.total = watchlist.length;
  enrichStatus.done  = enrichedCount;
  console.log(`🎬 Watchlist: ${watchlist.length}  |  Rated: ${ratingsList.length}  |  Cache: ${enrichedCount}`);

  setTimeout(runEnrichment, 1500);
  initSeriesCache().catch(e => console.error('Series cache init failed:', e));
}

init();
app.listen(PORT, () => console.log(`\n✓ Movie Night → http://localhost:${PORT}\n`));
