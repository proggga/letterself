// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  movies:        [],
  total:         0,
  page:          1,
  pages:         1,
  sort:          'votes',
  genre:         'all',
  country:       'all',
  search:        '',
  fitInTime:     false,
  showWatched:   true,
  darkenWatched: false,
  showBroken:    false,
  ratio:         0.88,
  hours:         2,
  mins:          30,
  queue:         [],
  genres:        [],
  countries:     [],
  enrichPct:     0,
  loading:       false,
  hasMore:       false,
  discoverMode:  false,
};

// ── Queue persistence ─────────────────────────────────────────────────────────
function saveQueue() {
  try { localStorage.setItem('mn_queue', JSON.stringify(state.queue)); } catch {}
}
function loadQueue() {
  try {
    const raw = localStorage.getItem('mn_queue');
    if (raw) state.queue = JSON.parse(raw);
  } catch {}
}
function saveSettings() {
  try { localStorage.setItem('mn_settings', JSON.stringify({ ratio: state.ratio, hours: state.hours, mins: state.mins, showWatched: state.showWatched, darkenWatched: state.darkenWatched })); } catch {}
}
function loadSettings() {
  try {
    const raw = localStorage.getItem('mn_settings');
    if (raw) { const s = JSON.parse(raw); Object.assign(state, s); }
  } catch {}
}


const THIS_YEAR = new Date().getFullYear();

// ── Helpers ───────────────────────────────────────────────────────────────────

// CDN URL — always the TMDB source
const POSTER_CDN = (path, size = 'w342') =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

// Preferred URL — local cached file if downloaded, else CDN
const POSTER = (path, size = 'w342', posterId = null) =>
  posterId ? `/posters/${posterId}.jpg` : POSTER_CDN(path, size);

// For <img> in inline HTML: src = local if downloaded, else CDN; always has CDN fallback
function posterAttrs(movie, size = 'w342') {
  const cdn = POSTER_CDN(movie.posterPath, size);
  if (!cdn) return '';                                     // no posterPath → no image
  if (!movie.posterId) return `src="${cdn}"`;              // no local possible → CDN directly
  return `src="/posters/${movie.posterId}.jpg" data-cdn="${cdn}" data-name="${esc(movie.name)}"`; // local first, CDN fallback
}

function fmtMins(m) {
  if (!m && m !== 0) return '?';
  const h = Math.floor(m / 60), mn = m % 60;
  return h > 0 ? `${h}h ${mn > 0 ? mn + 'm' : ''}`.trim() : `${mn}m`;
}
function fmtVotes(n) {
  if (!n) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K';
  return String(n);
}
// Convert TMDB 0–10 to Letterboxd 0–5 scale, return null if too few votes to trust
function fmtRating(voteAverage, voteCount) {
  if (!voteAverage || voteCount < 100) return null;
  return (voteAverage / 2).toFixed(1);
}
/// Smart ratio: animation and recent movies have minimal skip potential
function movieRatio(movie) {
  const r = state.ratio;
  if (r >= 1.0) return 1.0;
  if ((movie.genres || []).includes('Animation')) return Math.max(r, 0.95);
  if ((movie.year || 0) >= THIS_YEAR - 1) return Math.max(r, 0.93);
  return r;
}
function effectiveRuntime(movie) {
  if (!movie.runtime) return null;
  return Math.round(movie.runtime * movieRatio(movie));
}
function availableMinutes() { return state.hours * 60 + state.mins; }
function finishTime(totalMins) {
  const now  = new Date();
  const end  = new Date(now.getTime() + totalMins * 60_000);
  return end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function initials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}
function splitEvenRows(items, maxPerRow) {
  const n = items.length;
  if (n <= maxPerRow) return [items];
  for (let rowCount = 2; rowCount <= n; rowCount++) {
    const perRow = Math.ceil(n / rowCount);
    if (perRow <= maxPerRow) {
      const rows = [];
      for (let i = 0; i < n; i += perRow) rows.push(items.slice(i, i + perRow));
      return rows;
    }
  }
  return [items];
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function loadMovies(append = false) {
  if (state.loading) return;
  state.loading = true;

  const searching = !!state.search;
  const limit = searching ? 500 : 28;
  const params = new URLSearchParams({ page: state.page, sort: state.sort, limit, ratio: state.ratio });
  if (state.genre !== 'all') params.set('genre', state.genre);
  if (state.country !== 'all') params.set('country', state.country);
  if (state.search) params.set('q', state.search);
  if (state.showWatched) params.set('showWatched', 'true');
  if (state.showBroken) params.set('broken', 'true');
  if (state.fitInTime && availableMinutes() > 0) {
    params.set('maxRuntime', availableMinutes());
  }

  const sentinel = document.getElementById('scroll-sentinel');

  try {
    const data = await api(`/api/movies?${params}`);
    state.movies = data.movies;
    state.total  = data.total;
    state.pages  = data.pages;
    state.hasMore = state.page < state.pages && !searching;
    if (data.enrichmentStatus) updateEnrichBar(data.enrichmentStatus);
    renderGrid(append);
  } catch (e) {
    console.error(e);
  }

  state.loading = false;
  if (sentinel) sentinel.innerHTML = state.hasMore ? '' : '';
}

async function loadDiscover(append = false) {
  if (state.loading) return;
  state.loading = true;

  const params = new URLSearchParams({ page: state.page, sort: state.sort, limit: 28, ratio: state.ratio });
  if (state.search) params.set('q', state.search);
  if (state.genre !== 'all') params.set('genre', state.genre);
  if (state.country !== 'all') params.set('country', state.country);
  if (state.fitInTime && availableMinutes() > 0) params.set('maxRuntime', availableMinutes());

  const sentinel = document.getElementById('scroll-sentinel');
  try {
    const data = await api(`/api/discover?${params}`);
    state.movies  = data.movies;
    state.total   = data.total;
    state.hasMore = data.hasMore;
    if (data.genres) {
      state.genres = data.genres;
      populateGenreSelect();
      document.getElementById('genre-select').value = state.genre;
    }
    if (data.countries) {
      state.countries = data.countries;
      populateCountrySelect();
      document.getElementById('country-select').value = state.country;
    }
    renderGrid(append);
  } catch (e) {
    console.error(e);
  }

  state.loading = false;
  if (sentinel) sentinel.innerHTML = '';
}

async function loadStats() {
  const d = await api('/api/stats');
  state.genres    = d.genres;
  state.countries = d.countries || [];
  populateGenreSelect();
  populateCountrySelect();
  updateEnrichBar({ percent: d.percent, total: d.total, done: d.enriched, running: false });
}

// ── Enrichment polling ────────────────────────────────────────────────────────
let enrichPollTimer = null;
function updateEnrichBar({ percent, total, done, running, brokenCount }) {
  const fill  = document.getElementById('enrich-fill');
  const label = document.getElementById('enrich-label');
  fill.style.width = `${percent}%`;
  fill.style.background = percent >= 100 ? 'var(--success)' : 'var(--accent)';
  if (percent >= 100) {
    label.textContent = 'Fully enriched';
  } else if (done != null && total != null) {
    label.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} enriched`;
  } else {
    label.textContent = `${percent}% enriched`;
  }

  // Update broken button with live count
  const brokenBtn = document.getElementById('broken-btn');
  if (brokenBtn && brokenCount != null) {
    brokenBtn.textContent = brokenCount > 0 ? `⚠ Fix broken (${brokenCount})` : '⚠ Fix broken';
    brokenBtn.style.display = brokenCount > 0 || state.showBroken ? '' : 'none';
  }

  if (running && !enrichPollTimer) {
    enrichPollTimer = setInterval(async () => {
      const s = await api('/api/enrich-status');
      updateEnrichBar(s);
      if (!s.running) { clearInterval(enrichPollTimer); enrichPollTimer = null; loadMovies(); }
    }, 4000);
  }
}

// ── Genre select ──────────────────────────────────────────────────────────────
function populateGenreSelect() {
  const sel = document.getElementById('genre-select');
  sel.innerHTML = '<option value="all">All genres</option>';
  state.genres.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    sel.appendChild(opt);
  });
}

// ── Country select ────────────────────────────────────────────────────────────
function populateCountrySelect() {
  const sel = document.getElementById('country-select');
  sel.innerHTML = '<option value="all">All countries</option>';
  state.countries.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
}

// ── Grid rendering ────────────────────────────────────────────────────────────
function renderGrid(append = false) {
  const grid    = document.getElementById('movie-grid');
  const noRes   = document.getElementById('no-results');
  const counter = document.getElementById('result-count');

  counter.textContent = state.total > 0
    ? `${state.total.toLocaleString()} movie${state.total !== 1 ? 's' : ''}`
    : '';

  if (!state.movies.length && !append) {
    grid.innerHTML = '';
    noRes.classList.remove('hidden');
    return;
  }
  noRes.classList.add('hidden');

  if (!append) grid.innerHTML = '';

  const queueIds = new Set(state.queue.map(m => m.id));
  state.movies.forEach(movie => {
    grid.appendChild(buildCard(movie, queueIds.has(movie.id)));
  });
}

function buildCard(movie, inQueue) {
  if (movie.type === 'series') return buildSeriesCard(movie);
  if (movie.source === 'discover') return buildDiscoverCard(movie);

  const eff      = effectiveRuntime(movie);
  const showOrig = eff && movie.runtime && eff !== movie.runtime;
  const watched  = movie.watched || false;

  const card = document.createElement('div');
  card.className = `movie-card${watched && state.darkenWatched ? ' watched' : ''}`;
  card.dataset.id = movie.id;

  // Suspect-match warning badge (wrong TMDB entry detected)
  if (movie.suspectMatch) {
    const badge = document.createElement('div');
    badge.className = 'suspect-badge';
    badge.title = 'Year mismatch — likely wrong TMDB entry. Click movie to fix.';
    badge.textContent = '⚠';
    card.appendChild(badge);
  }

  // Poster
  const localSrc = POSTER(movie.posterPath, 'w342', movie.posterId);
  const cdnSrc   = POSTER_CDN(movie.posterPath, 'w342');
  if (localSrc) {
    const img = document.createElement('img');
    img.className = 'card-poster';
    img.src       = localSrc;
    img.alt       = movie.name;
    img.loading   = 'lazy';
    img.dataset.name = movie.name;
    if (movie.posterId && cdnSrc) img.dataset.cdn = cdnSrc;
    card.appendChild(img);
  } else {
    card.appendChild(makePlaceholder(movie.name));
  }

  // Add-to-queue button (top-right)
  const addBtn = document.createElement('button');
  addBtn.className = `card-add${inQueue ? ' in-queue' : ''}`;
  addBtn.title     = inQueue ? 'Remove from queue' : 'Add to queue';
  addBtn.textContent = inQueue ? '✓' : '+';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleQueue(movie);
    renderGrid();
    renderQueue();
  });
  card.appendChild(addBtn);

  // Info section
  const info = document.createElement('div');
  info.className = 'card-info';

  const title = document.createElement('div');
  title.className   = 'card-title';
  title.textContent = movie.name;
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className   = 'card-meta';
  meta.textContent = movie.year || '';
  if (movie.genres?.[0]) meta.textContent += ` · ${movie.genres[0]}`;
  info.appendChild(meta);

  if (movie.voteAverage) {
    const rat = document.createElement('div');
    rat.className = 'card-rating';
    const display = fmtRating(movie.voteAverage, movie.voteCount);
    if (display) {
      rat.innerHTML = `<span class="star">★</span><span>${display}</span>`
        + (movie.voteCount ? `<span class="votes">(${fmtVotes(movie.voteCount)})</span>` : '');
    } else if (movie.voteCount) {
      // Too few votes to trust — just show vote count
      rat.innerHTML = `<span class="votes" title="Too few votes to trust rating">${fmtVotes(movie.voteCount)} votes</span>`;
    }
    info.appendChild(rat);
  }

  if (eff) {
    const rt = document.createElement('div');
    rt.className = 'card-runtime';
    rt.innerHTML = `⏱ ${fmtMins(eff)}`
      + (showOrig ? ` <span class="orig">(${fmtMins(movie.runtime)})</span>` : '');
    info.appendChild(rt);
  } else if (!movie.enriched) {
    const nd = document.createElement('div');
    nd.className   = 'card-no-data';
    nd.textContent = 'Loading…';
    info.appendChild(nd);
  }

  if (movie.overview) {
    const ov = document.createElement('div');
    ov.className   = 'card-overview';
    ov.textContent = movie.overview;
    info.appendChild(ov);
  }

  card.appendChild(info);
  card.addEventListener('click', () => openDetail(movie));
  return card;
}

function makePlaceholder(name) {
  const div = document.createElement('div');
  div.className   = 'card-poster-placeholder';
  div.textContent = initials(name);
  return div;
}

// ── Series card ───────────────────────────────────────────────────────────────
function buildSeriesCard(series) {
  const watched = series.watched || false;
  const card = document.createElement('div');
  card.className = `movie-card series-card${watched && state.darkenWatched ? ' watched' : ''}`;
  card.dataset.id = series.id;

  // Episode count badge (top-right, always visible)
  const badge = document.createElement('div');
  badge.className = 'series-count-badge';
  badge.title = `${series.episodeCount} episodes`;
  badge.textContent = series.episodeCount;
  card.appendChild(badge);

  // Poster
  const localSrc = POSTER(series.posterPath, 'w342', series.posterId);
  const cdnSrc   = POSTER_CDN(series.posterPath, 'w342');
  if (localSrc) {
    const img = document.createElement('img');
    img.className = 'card-poster';
    img.src       = localSrc;
    img.alt       = series.name;
    img.loading   = 'lazy';
    img.dataset.name = series.name;
    if (series.posterId && cdnSrc) img.dataset.cdn = cdnSrc;
    card.appendChild(img);
  } else {
    card.appendChild(makePlaceholder(series.name));
  }

  // Info section
  const info = document.createElement('div');
  info.className = 'card-info';

  const title = document.createElement('div');
  title.className   = 'card-title';
  title.textContent = series.name;
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  if (series.year) meta.textContent = String(series.year);
  if (series.genres?.[0]) meta.textContent += ` · ${series.genres[0]}`;
  info.appendChild(meta);

  if (series.voteAverage) {
    const rat = document.createElement('div');
    rat.className = 'card-rating';
    const display = fmtRating(series.voteAverage, series.voteCount);
    if (display) {
      rat.innerHTML = `<span class="star">★</span><span>${display}</span>`
        + (series.voteCount ? `<span class="votes">(${fmtVotes(series.voteCount)})</span>` : '');
    }
    info.appendChild(rat);
  }

  const epInfo = document.createElement('div');
  epInfo.className = 'card-runtime';
  const wc = series.watchedCount || 0;
  epInfo.textContent = `${series.episodeCount} ep${series.episodeCount !== 1 ? 's' : ''}${wc > 0 ? ` · ${wc} watched` : ''}`;
  info.appendChild(epInfo);

  card.appendChild(info);
  card.addEventListener('click', () => openSeriesDetail(series));
  return card;
}

function openSeriesDetail(series) {
  const modal  = document.getElementById('detail-modal');
  const body   = document.getElementById('detail-body');
  const pAttrs = posterAttrs(series, 'w500');

  const episodesHTML = series.episodes.map(ep => {
    const prefix   = series.seriesName + ':';
    const epTitle  = ep.name.startsWith(prefix) ? ep.name.slice(prefix.length).trim() : ep.name;
    const epPAttrs = posterAttrs(ep, 'w92');
    const rating   = fmtRating(ep.voteAverage, ep.voteCount);
    return `
      <div class="series-ep-item${ep.watched ? ' ep-watched' : ''}" data-uri="${esc(ep.uri)}">
        ${epPAttrs
          ? `<img class="series-ep-thumb" ${epPAttrs} alt="${esc(ep.name)}">`
          : `<div class="series-ep-thumb series-ep-thumb-ph">${initials(ep.name)}</div>`}
        <div class="series-ep-info">
          <div class="series-ep-name">${esc(epTitle)}</div>
          <div class="series-ep-meta">${ep.year || ''}${rating ? ` · ★${rating}` : ''}${ep.runtime ? ` · ${fmtMins(ep.runtime)}` : ''}</div>
        </div>
        ${ep.watched ? `<span class="series-ep-watched-badge">✓</span>` : ''}
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="detail-inner">
      <div class="detail-poster">
        ${pAttrs
          ? `<img ${pAttrs} alt="${esc(series.name)}" style="width:100%;border-radius:var(--radius)">`
          : `<div class="detail-poster-ph">${initials(series.name)}</div>`}
      </div>
      <div class="detail-info">
        <div class="detail-title">${esc(series.name)}</div>
        <div class="detail-row">
          ${series.year ? `<div class="detail-stat"><div class="detail-stat-label">First Aired</div><div class="detail-stat-value">${series.year}</div></div>` : ''}
          ${series.voteAverage ? `
          <div class="detail-stat">
            <div class="detail-stat-label">Rating (0–5)</div>
            <div class="detail-stat-value gold">★ ${fmtRating(series.voteAverage, series.voteCount) ?? series.voteAverage.toFixed(1)}</div>
          </div>` : ''}
          <div class="detail-stat">
            <div class="detail-stat-label">Episodes</div>
            <div class="detail-stat-value">${series.episodeCount}${series.watchedCount > 0 ? ` (${series.watchedCount} watched)` : ''}</div>
          </div>
        </div>
        ${series.overview ? `<div class="detail-overview">${esc(series.overview)}</div>` : ''}
        ${series.genres?.length ? `
          <div class="detail-genres">
            ${series.genres.map(g => `<span class="detail-genre-tag" data-genre="${esc(g)}">${esc(g)}</span>`).join('')}
          </div>` : ''}
        ${series.tmdbId ? `<a class="detail-link" href="https://www.themoviedb.org/tv/${series.tmdbId}" target="_blank" rel="noopener">View on TMDB ↗</a>` : ''}
        <div class="series-ep-list-header">Episodes <span class="series-ep-list-count">${series.episodeCount}</span></div>
        <div class="series-ep-list">${episodesHTML || '<div style="color:var(--text-dim);font-size:0.82rem;padding:8px 0">No episodes found</div>'}</div>
      </div>
    </div>`;

  // Genre tag clicks
  body.querySelectorAll('.detail-genre-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const genre = tag.dataset.genre;
      state.genre = genre;
      state.page  = 1;
      document.getElementById('genre-select').value = genre;
      closeDetail();
      document.getElementById('director-modal').classList.add('hidden');
      if (state.discoverMode) loadDiscover(); else loadMovies();
    });
  });

  body.querySelectorAll('.series-ep-item').forEach(item => {
    item.addEventListener('click', () => {
      const uri = item.dataset.uri;
      const ep  = series.episodes.find(e => e.uri === uri);
      if (ep) openDetail(ep);
    });
  });

  modal.classList.remove('hidden');
}



// ── Infinite scroll ───────────────────────────────────────────────────────────
function setupScrollObserver() {
  const sentinel = document.getElementById('scroll-sentinel');
  if (!sentinel) return;
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && state.hasMore && !state.loading) {
      state.page++;
      sentinel.innerHTML = '<div class="scroll-loading">Loading…</div>';
      if (state.discoverMode) loadDiscover(true); else loadMovies(true);
    }
  }, { rootMargin: '400px' });
  observer.observe(sentinel);
}

// ── Discover card & detail ────────────────────────────────────────────────────
function buildDiscoverCard(film) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.dataset.id = film.id;

  const localSrc = film.posterId ? `/posters/${film.posterId}.jpg` : null;
  const cdnSrc   = POSTER_CDN(film.posterPath, 'w342');
  if (localSrc || cdnSrc) {
    const img = document.createElement('img');
    img.className    = 'card-poster';
    img.src          = localSrc || cdnSrc;
    img.alt          = film.name;
    img.loading      = 'lazy';
    img.dataset.name = film.name;
    if (localSrc && cdnSrc) img.dataset.cdn = cdnSrc;
    card.appendChild(img);
  } else {
    card.appendChild(makePlaceholder(film.name));
  }

  // "New" discover badge
  const badge = document.createElement('div');
  badge.className = 'discover-new-badge';
  badge.textContent = '✦';
  badge.title = `Not in your watchlist · directed by ${film.directors.join(', ')}`;
  card.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'card-info';

  const title = document.createElement('div');
  title.className   = 'card-title';
  title.textContent = film.name;
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className   = 'card-meta';
  meta.textContent = film.year || '';
  info.appendChild(meta);

  const dirEl = document.createElement('div');
  dirEl.className   = 'card-overview';
  dirEl.textContent = film.directors.join(', ');
  info.appendChild(dirEl);

  if (film.voteAverage) {
    const rat = document.createElement('div');
    rat.className = 'card-rating';
    const display = fmtRating(film.voteAverage, film.voteCount);
    if (display) rat.innerHTML = `<span class="star">★</span><span>${display}</span>`
      + (film.voteCount ? `<span class="votes">(${fmtVotes(film.voteCount)})</span>` : '');
    info.appendChild(rat);
  }

  card.appendChild(info);
  card.addEventListener('click', () => openDiscoverDetail(film));
  return card;
}

async function openDiscoverDetail(film) {
  const modal = document.getElementById('detail-modal');
  const body  = document.getElementById('detail-body');
  const localPoster = film.posterId ? `/posters/${film.posterId}.jpg` : null;
  const cdn         = POSTER_CDN(film.posterPath, 'w500');
  const posterSrc   = localPoster || cdn;
  let   open  = true;  // guard against stale async renders after close

  // Show immediately with what we have, then enrich with full details
  const renderBody = (details) => {
    if (!open) return;
    const runtime    = details?.runtime ?? film.runtime ?? null;
    const genres     = details?.genres?.length ? details.genres : film.genres;
    const eff        = runtime ? Math.round(runtime * state.ratio) : null;
    const inQ        = state.queue.some(m => m.id === film.id);
    const localWl    = (state.localWatchlist || new Set()).has(film.tmdbId);
    const localWd    = (state.localWatched   || new Set()).has(film.tmdbId);

    body.innerHTML = `
      <div class="detail-inner">
        <div class="detail-poster">
          ${posterSrc ? `<img src="${posterSrc}" alt="${esc(film.name)}" class="detail-poster-img">` : `<div class="detail-poster-placeholder">${initials(film.name)}</div>`}
        </div>
        <div class="detail-info">
          <h2 class="detail-title">${esc(film.name)}</h2>
          <div class="detail-meta">
            ${film.year || ''}
            ${film.voteAverage ? ` · ★ ${film.voteAverage}` : ''}
            ${film.voteCount ? ` (${fmtVotes(film.voteCount)})` : ''}
            ${eff ? ` · ⏱ ${fmtMins(eff)}` : ''}
          </div>
          ${genres?.length ? `<div class="detail-genres">${genres.map(g => `<span class="detail-genre-tag" data-genre="${esc(g)}">${esc(g)}</span>`).join('')}</div>` : ''}
          ${film.directors?.length ? `
            <div class="detail-directors">
              <span class="detail-directors-label">Directed by</span>
              ${film.directors.map(d => `<span class="detail-director-tag" data-director="${esc(d)}">${esc(d)}</span>`).join(', ')}
            </div>` : ''}
          ${film.overview ? `<div class="detail-overview">${esc(film.overview)}</div>` : ''}
          <div class="detail-discover-actions">
            ${localWd
              ? `<span class="discover-status-badge">✓ Marked as watched</span>`
              : localWl
                ? `<span class="discover-status-badge">✓ In your watchlist</span>
                   <button class="btn btn-ghost btn-sm" id="disc-remove-btn">Remove</button>`
                : `<button class="btn btn-primary btn-sm" id="disc-watchlist-btn">+ Add to Watchlist</button>
                   <button class="btn btn-ghost btn-sm" id="disc-watched-btn">✓ Mark as Watched</button>`}
            ${eff && !inQ && !localWd ? `<button class="btn btn-ghost btn-sm" id="disc-queue-btn">Add to Queue</button>` : ''}
          </div>
          <div class="detail-links" style="margin-top:12px">
            <a href="https://www.themoviedb.org/movie/${film.tmdbId}" target="_blank" rel="noopener" class="detail-link">View on TMDB ↗</a>
            <a href="https://letterboxd.com/search/films/${encodeURIComponent(film.name)}/" target="_blank" rel="noopener" class="detail-link">Search Letterboxd ↗</a>
          </div>
        </div>
      </div>`;

    body.querySelectorAll('.detail-genre-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        open = false;
        closeDetail();
        document.getElementById('director-modal').classList.add('hidden');
        state.genre = tag.dataset.genre;
        state.page  = 1;
        document.getElementById('genre-select').value = state.genre;
        if (state.discoverMode) loadDiscover(); else loadMovies();
      });
    });

    body.querySelectorAll('.detail-director-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        open = false;
        closeDetail();
        openDirectorFilmography(tag.dataset.director);
      });
    });

    async function doLocalAction(action) {
      await fetch('/api/local-library', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId: film.tmdbId, title: film.name, year: film.year, posterPath: film.posterPath, action }),
      });
      if (action === 'watchlist') {
        state.localWatchlist = state.localWatchlist || new Set();
        state.localWatchlist.add(film.tmdbId);
      } else {
        state.localWatched = state.localWatched || new Set();
        state.localWatched.add(film.tmdbId);
        state.localWatchlist?.delete(film.tmdbId);
      }
      renderBody(details);   // re-render buttons
      if (state.discoverMode) { state.page = 1; loadDiscover(); }
    }

    body.querySelector('#disc-watchlist-btn')?.addEventListener('click', () => doLocalAction('watchlist'));
    body.querySelector('#disc-watched-btn')?.addEventListener('click',   () => doLocalAction('watched'));
    body.querySelector('#disc-remove-btn')?.addEventListener('click', async () => {
      await fetch(`/api/local-library/${film.tmdbId}`, { method: 'DELETE' });
      state.localWatchlist?.delete(film.tmdbId);
      state.localWatched?.delete(film.tmdbId);
      renderBody(details);
      if (state.discoverMode) { state.page = 1; loadDiscover(); }
    });

    if (eff) {
      body.querySelector('#disc-queue-btn')?.addEventListener('click', () => {
        try {
          const queueMovie = { ...film, id: `discover-${film.tmdbId}`, runtime: runtime, ratioUsed: state.ratio };
          toggleQueue(queueMovie);
          renderQueue();
        } catch (e) { console.error('Queue error', e); }
        open = false;
        closeDetail();
      });
    }
  };

  // Render immediately with basic data
  renderBody(null);
  modal.classList.remove('hidden');
  document.getElementById('detail-close').focus();

  // Mark open=false when modal is manually closed so stale fetch doesn't re-render
  const onClose = () => { open = false; };
  document.getElementById('detail-close').addEventListener('click', onClose, { once: true });
  document.getElementById('detail-backdrop').addEventListener('click', onClose, { once: true });

  // Fetch full details in background and re-render
  try {
    const details = await fetch(`/api/tmdb/movie/${film.tmdbId}`).then(r => r.json());
    if (details?.tmdbId) renderBody(details);
  } catch {}
}

// ── Detail modal ──────────────────────────────────────────────────────────────
function openDetail(movie) {
  const modal = document.getElementById('detail-modal');
  const body  = document.getElementById('detail-body');
  const eff   = effectiveRuntime(movie);
  const inQ   = state.queue.some(m => m.id === movie.id);
  const pAttrs = posterAttrs(movie, 'w500');

  body.innerHTML = `
    <div class="detail-inner">
      <div class="detail-poster">
        ${pAttrs
          ? `<img ${pAttrs} alt="${esc(movie.name)}" style="width:100%;border-radius:var(--radius)">`
          : `<div class="detail-poster-ph">${initials(movie.name)}</div>`}
      </div>
      <div class="detail-info">
        <div class="detail-title">${esc(movie.name)}</div>
        ${movie.tagline ? `<div class="detail-tagline">"${esc(movie.tagline)}"</div>` : ''}
        <div class="detail-row">
          <div class="detail-stat">
            <div class="detail-stat-label">Year</div>
            <div class="detail-stat-value">${movie.year || '—'}</div>
          </div>
          ${movie.voteAverage ? `
          <div class="detail-stat">
            <div class="detail-stat-label">Rating (0–5)</div>
            <div class="detail-stat-value gold">★ ${fmtRating(movie.voteAverage, movie.voteCount) ?? movie.voteAverage.toFixed(1)}</div>
          </div>
          <div class="detail-stat">
            <div class="detail-stat-label">Votes</div>
            <div class="detail-stat-value">${fmtVotes(movie.voteCount)}${(movie.voteCount || 0) < 100 ? ' ⚠ low' : ''}</div>
          </div>` : ''}
          ${movie.runtime ? `
          <div class="detail-stat">
            <div class="detail-stat-label">Runtime</div>
            <div class="detail-stat-value">${fmtMins(movie.runtime)}</div>
          </div>
          ${state.ratio !== 1 ? `
          <div class="detail-stat">
            <div class="detail-stat-label">Your time (${Math.round(state.ratio * 100)}%)</div>
            <div class="detail-stat-value accent">~${fmtMins(eff)}</div>
          </div>` : ''}` : ''}
        </div>
        ${movie.overview ? `<div class="detail-overview">${esc(movie.overview)}</div>` : ''}
        ${movie.genres?.length ? `
          <div class="detail-genres">
            ${movie.genres.map(g => `<span class="detail-genre-tag" data-genre="${esc(g)}">${esc(g)}</span>`).join('')}
          </div>` : ''}
        ${movie.directors?.length ? `
          <div class="detail-directors">
            <span class="detail-directors-label">Directed by</span>
            ${movie.directors.map(d => `<span class="detail-director-tag" data-director="${esc(d)}">${esc(d)}</span>`).join(', ')}
          </div>` : ''}
        <div class="detail-actions">
          ${!movie.released ? `<span class="coming-soon-badge">🕐 Coming soon — not yet released</span>` : ''}
          <button class="btn btn-primary btn-sm" id="detail-add-btn"${!movie.released ? ' disabled title="Not released yet"' : ''}>
            ${inQ ? '✓ In Queue' : '+ Add to Queue'}
          </button>
        </div>
        ${movie.uri && !movie.uri.startsWith('local://') ? `<a class="detail-link" href="${movie.uri}" target="_blank" rel="noopener">View on Letterboxd ↗</a>` : ''}
        ${movie.imdbId ? `<a class="detail-link" href="https://www.imdb.com/title/${movie.imdbId}/" target="_blank" rel="noopener">View on IMDb ↗</a>` : ''}
        ${movie.tmdbId ? (() => {
          const ov = movie.overrideId;
          const isTV = ov && typeof ov === 'object' && ov.type === 'tv';
          const path = isTV ? `tv/${movie.tmdbId}` : `movie/${movie.tmdbId}`;
          return `<a class="detail-link" href="https://www.themoviedb.org/${path}" target="_blank" rel="noopener">View on TMDB ↗${isTV ? ' (TV)' : ''}</a>`;
        })() : ''}
        ${movie.uri?.startsWith('local://') ? `<button class="btn btn-ghost btn-sm" id="local-remove-btn" style="margin-top:8px">Remove from library</button>` : ''}
        <div class="detail-override">
          ${movie.suspectMatch ? `<div class="suspect-warning">⚠ Year mismatch — TMDB returned a different film. Use the form below to set the correct ID.</div>` : ''}
          <div class="override-current">
            ${movie.tmdbId ? `TMDB #${movie.tmdbId}` : 'No TMDB match'}
            ${movie.hasOverride ? ` &nbsp;<span class="override-badge">Override active</span>` : ''}
            &nbsp;<button class="override-toggle-btn" id="override-toggle-btn">Wrong match?</button>
          </div>
          <div class="override-form${movie.suspectMatch ? '' : ' hidden'}" id="override-form">
            <input type="text" id="override-id-input" class="override-id-input" placeholder="TMDB URL or ID">
            <a href="https://www.themoviedb.org/search?query=${encodeURIComponent(movie.name)}" target="_blank" rel="noopener" class="override-search-link">Search TMDB ↗</a>
            <button id="override-save-btn" class="btn btn-primary btn-sm">Save</button>
            <button id="override-skip-btn" class="btn btn-ghost btn-sm">Not on TMDB</button>
            ${movie.hasOverride ? `<button id="override-clear-btn" class="btn btn-ghost btn-sm">Clear override</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('detail-add-btn').addEventListener('click', () => {
    toggleQueue(movie);
    document.getElementById('detail-add-btn').textContent =
      state.queue.some(m => m.id === movie.id) ? '✓ In Queue' : '+ Add to Queue';
    renderQueue();
    renderGrid();
  });

  document.getElementById('local-remove-btn')?.addEventListener('click', async () => {
    const tmdbId = movie.uri.replace('local://movie/', '');
    await fetch(`/api/local-library/${tmdbId}`, { method: 'DELETE' });
    state.localWatchlist?.delete(parseInt(tmdbId));
    state.localWatched?.delete(parseInt(tmdbId));
    closeDetail();
    state.page = 1;
    loadMovies();
  });

  body.querySelectorAll('.detail-genre-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const genre = tag.dataset.genre;
      state.genre = genre;
      state.page  = 1;
      document.getElementById('genre-select').value = genre;
      closeDetail();
      document.getElementById('director-modal').classList.add('hidden');
      if (state.discoverMode) loadDiscover(); else loadMovies();
    });
  });

  body.querySelectorAll('.detail-director-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      closeDetail();
      openDirectorFilmography(tag.dataset.director);
    });
  });

  // Override form wiring
  document.getElementById('override-toggle-btn')?.addEventListener('click', () => {
    document.getElementById('override-form').classList.toggle('hidden');
  });

  async function applyOverride(body) {
    const btn = document.getElementById('override-save-btn') || document.getElementById('override-skip-btn');
    if (btn) btn.disabled = true;
    try {
      const res  = await fetch('/api/overrides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.movie) { openDetail(data.movie); loadMovies(); }
    } catch (e) { console.error('Override save failed', e); }
  }

  document.getElementById('override-save-btn')?.addEventListener('click', () => {
    const raw = document.getElementById('override-id-input').value.trim();
    // Accept full TMDB URL (themoviedb.org/movie/123-slug or /tv/123-slug) or plain number
    const match = raw.match(/\/(movie|tv)\/(\d+)/);
    const mediaType = match ? match[1] : 'movie';
    const id = match ? parseInt(match[2]) : parseInt(raw);
    if (!id) return;
    applyOverride({ uri: movie.uri, tmdbId: id, mediaType });
  });
  document.getElementById('override-skip-btn')?.addEventListener('click', () => {
    applyOverride({ uri: movie.uri, tmdbId: null });
  });
  document.getElementById('override-clear-btn')?.addEventListener('click', () => {
    applyOverride({ uri: movie.uri, clear: true });
  });

  modal.classList.remove('hidden');
}

function closeDetail() {
  document.getElementById('detail-modal').classList.add('hidden');
  randomModalOpen = false;
}

// ── Night plan modal ──────────────────────────────────────────────────────────
let currentNight     = [];
let pinnedInNight    = new Set();
let nightMode        = 'feature'; // 'feature' | 'shorts'
let nightDiscoverMode = false;

async function openNightPlan() {
  const mins = availableMinutes();
  if (mins < 20) { alert('Set a time budget first (e.g. 2h 30m)'); return; }

  pinnedInNight.clear();
  nightDiscoverMode = state.discoverMode;
  const modal = document.getElementById('night-modal');
  const body  = document.getElementById('night-body');
  body.innerHTML = '<div class="night-header"><h2>Planning your night…</h2></div>';
  modal.classList.remove('hidden');

  await fetchAndRenderNight([]);
}

async function fetchAndRenderNight(exclude) {
  const modal = document.getElementById('night-modal');
  const body  = document.getElementById('night-body');
  const mins  = availableMinutes();

  try {
    const params = new URLSearchParams({ minutes: mins, ratio: state.ratio, mode: nightMode });
    if (nightDiscoverMode) params.set('discover', 'true');
    if (exclude.length) params.set('exclude', exclude.join(','));
    const data = await api(`/api/movies/suggest?${params}`);
    currentNight = data.night;
    renderNightBody(data);
  } catch {
    body.innerHTML = '<div class="night-empty"><p>Could not load suggestions.</p></div>';
  }
}

function renderNightBody(data) {
  const body   = document.getElementById('night-body');
  const { night, budgetMinutes, usedMinutes, remainingMinutes } = data;

  if (!night.length) {
    body.innerHTML = `
      <div class="night-header">
        <div class="night-header-top">
          <div><h2>No suggestions</h2></div>
          ${nightTimeCtrlHTML()}
        </div>
      </div>
      <div class="night-empty">
        <p>No enriched movies fit in ${fmtMins(budgetMinutes)} with the current watch speed.</p>
        <p>Try a longer time or wait for more movies to load from TMDB.</p>
      </div>`;
    wireNightTimeCtrl();
    return;
  }

  const items = night.map((m, i) => {
    const pAttrs  = posterAttrs(m, 'w185');
    const isPinned = pinnedInNight.has(m.id);
    return `
      <div class="night-item${isPinned ? ' pinned' : ''}" data-id="${m.id}">
        ${pAttrs ? `<img class="night-item-poster" ${pAttrs} alt="${esc(m.name)}">` : `<div class="night-item-poster" style="background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:var(--text-dim)">${initials(m.name)}</div>`}
        <div class="night-item-info">
          <div class="night-item-title">${esc(m.name)}</div>
          <div class="night-item-meta">${m.year}${m.genres?.[0] ? ' · ' + m.genres[0] : ''}${m.voteAverage ? ' · ★' + m.voteAverage.toFixed(1) : ''}</div>
          <div class="night-item-runtime">~${fmtMins(m.effectiveRuntime)}${state.ratio < 1 ? ` (${fmtMins(m.runtime)})` : ''}</div>
        </div>
        <div class="night-item-btns">
          <button class="night-item-pin${isPinned ? ' active' : ''}" title="${isPinned ? 'Unpin' : 'Pin — keep on reshuffle'}" data-idx="${i}">📌</button>
          <button class="night-item-reroll" title="${isPinned ? 'Unpin to change' : 'Try a different movie'}" data-idx="${i}"${isPinned ? ' disabled' : ''}>🔄</button>
        </div>
      </div>`;
  }).join('');

  const pct    = Math.round((usedMinutes / budgetMinutes) * 100);
  const finish = finishTime(usedMinutes);
  const hasPins = pinnedInNight.size > 0;

  body.innerHTML = `
    <div class="night-header">
      <div class="night-header-top">
        <div>
          <h2>Tonight's Plan</h2>
          <p>${night.length} movie${night.length > 1 ? 's' : ''} · ${fmtMins(budgetMinutes)} budget${hasPins ? ` · ${pinnedInNight.size} pinned` : ''}</p>
        </div>
        ${nightTimeCtrlHTML()}
      </div>
      <div class="night-mode-row">
        <button class="night-mode-btn${nightMode === 'feature' ? ' active' : ''}" data-mode="feature">🎬 Feature Night</button>
        <button class="night-mode-btn${nightMode === 'shorts' ? ' active' : ''}" data-mode="shorts">⚡ Short Evening</button>
      </div>
    </div>
    <div class="night-list">${items}</div>
    <div class="night-footer">
      <div class="night-stats">
        <strong>${fmtMins(usedMinutes)}</strong> of ${fmtMins(budgetMinutes)}
        (${pct}% full · ${fmtMins(remainingMinutes)} to spare)
        <div class="night-finish-time">Finish around ${finish}</div>
      </div>
      <div class="night-footer-actions">
        <button class="btn btn-secondary btn-sm" id="night-reshuffle">🔀 ${hasPins ? 'Reshuffle free slots' : 'Shuffle'}</button>
        <button class="btn btn-primary btn-sm" id="night-add-all">+ Add All to Queue</button>
      </div>
    </div>`;

  wireNightTimeCtrl();

  // Mode toggle
  body.querySelectorAll('.night-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      nightMode = btn.dataset.mode;
      pinnedInNight.clear();
      fetchAndRenderNight([]);
    });
  });

  // Pin / unpin
  body.querySelectorAll('.night-item-pin').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const id  = currentNight[idx].id;
      if (pinnedInNight.has(id)) pinnedInNight.delete(id);
      else pinnedInNight.add(id);
      const used = currentNight.reduce((s, m) => s + m.effectiveRuntime, 0);
      renderNightBody({ night: currentNight, budgetMinutes: availableMinutes(), usedMinutes: used, remainingMinutes: availableMinutes() - used });
    });
  });

  // Re-roll individual movie (blocked if pinned)
  body.querySelectorAll('.night-item-reroll').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', async () => {
      const excludeIds = currentNight.map(m => m.id);
      const idx = parseInt(btn.dataset.idx);
      const slotBudget = currentNight[idx].effectiveRuntime;
      const params = new URLSearchParams({ minutes: slotBudget, ratio: state.ratio, mode: nightMode });
      params.set('exclude', excludeIds.join(','));
      try {
        const data = await api(`/api/movies/suggest?${params}`);
        if (data.night[0]) {
          currentNight[idx] = data.night[0];
          const used = currentNight.reduce((s, m) => s + m.effectiveRuntime, 0);
          renderNightBody({ night: currentNight, budgetMinutes: availableMinutes(), usedMinutes: used, remainingMinutes: availableMinutes() - used });
        }
      } catch {}
    });
  });

  document.getElementById('night-reshuffle')?.addEventListener('click', async () => {
    if (pinnedInNight.size === 0) {
      // Standard reshuffle
      fetchAndRenderNight(currentNight.map(m => m.id));
    } else {
      // Keep pinned movies, reshuffle the rest
      const pinned      = currentNight.filter(m => pinnedInNight.has(m.id));
      const pinnedTime  = pinned.reduce((s, m) => s + m.effectiveRuntime, 0);
      const remaining   = availableMinutes() - pinnedTime;
      if (remaining < 20) return;
      const exclude = currentNight.map(m => m.id); // exclude all current (pinned added back)
      const params = new URLSearchParams({ minutes: remaining, ratio: state.ratio });
      params.set('exclude', exclude.join(','));
      try {
        const data = await api(`/api/movies/suggest?${params}`);
        currentNight = [...pinned, ...data.night];
        const used = currentNight.reduce((s, m) => s + m.effectiveRuntime, 0);
        renderNightBody({ night: currentNight, budgetMinutes: availableMinutes(), usedMinutes: used, remainingMinutes: availableMinutes() - used });
      } catch {}
    }
  });

  document.getElementById('night-add-all')?.addEventListener('click', () => {
    currentNight.forEach(m => { if (!state.queue.some(q => q.id === m.id)) state.queue.push(m); });
    renderQueue();
    renderGrid();
    closeNightModal();
  });
}

function nightTimeCtrlHTML() {
  return `
    <div class="night-time-ctrl">
      <span class="night-time-label">Time:</span>
      <input type="number" id="night-hours" class="time-input" value="${state.hours}" min="0" max="12" style="width:48px"> h
      <input type="number" id="night-mins"  class="time-input" value="${state.mins}"  min="0" max="59" style="width:48px"> m
      <label class="night-discover-label" title="Plan from discover films instead of your watchlist">
        <input type="checkbox" id="night-discover-check" ${nightDiscoverMode ? 'checked' : ''}> ✦ Discover
      </label>
    </div>`;
}

function wireNightTimeCtrl() {
  const hoursIn = document.getElementById('night-hours');
  const minsIn  = document.getElementById('night-mins');
  const discoverCheck = document.getElementById('night-discover-check');
  if (!hoursIn) return;

  const syncTime = () => {
    const h = Math.max(0, parseInt(hoursIn.value) || 0);
    const m = Math.max(0, Math.min(59, parseInt(minsIn.value) || 0));
    state.hours = h; state.mins = m;
    const hdr = document.getElementById('hours-input');
    const mdr = document.getElementById('mins-input');
    if (hdr) hdr.value = h;
    if (mdr) mdr.value = m;
  };

  [hoursIn, minsIn].forEach(el => el.addEventListener('change', syncTime));

  discoverCheck?.addEventListener('change', () => {
    nightDiscoverMode = discoverCheck.checked;
    fetchAndRenderNight([]);
  });
}

function closeNightModal() {
  document.getElementById('night-modal').classList.add('hidden');
}

// ── Queue management ──────────────────────────────────────────────────────────
function toggleQueue(movie) {
  const idx = state.queue.findIndex(m => m.id === movie.id);
  if (idx >= 0) state.queue.splice(idx, 1);
  else          state.queue.push(movie);
  saveQueue();
}

function renderQueue() {
  const bar  = document.getElementById('queue-bar');
  const list = document.getElementById('queue-list');

  if (!state.queue.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const totalEff = state.queue.reduce((s, m) => s + (effectiveRuntime(m) || m.runtime || 90), 0);
  const budget   = availableMinutes();
  const over     = budget > 0 && totalEff > budget;

  document.getElementById('queue-time').textContent =
    `${state.queue.length} movie${state.queue.length > 1 ? 's' : ''} · ${fmtMins(totalEff)}`
    + (over ? ` (${fmtMins(totalEff - budget)} over budget!)` : '');
  document.getElementById('queue-finish').textContent =
    `Finish ~${finishTime(totalEff)}`;

  list.innerHTML = '';
  state.queue.forEach(m => {
    const localSrc = POSTER(m.posterPath, 'w92', m.posterId);
    const cdnSrc   = POSTER_CDN(m.posterPath, 'w92');
    const thumb  = document.createElement(localSrc ? 'img' : 'div');
    if (localSrc) {
      thumb.src = localSrc;
      thumb.alt = m.name;
      thumb.className = 'queue-thumb';
      thumb.dataset.name = m.name;
      if (m.posterId && cdnSrc) thumb.dataset.cdn = cdnSrc;
    } else {
      thumb.className   = 'queue-thumb-placeholder';
      thumb.textContent = initials(m.name);
    }
    thumb.title = `${m.name} — click to remove`;
    thumb.addEventListener('click', () => { toggleQueue(m); renderQueue(); renderGrid(); });
    list.appendChild(thumb);
  });
}

// ── Random pick ───────────────────────────────────────────────────────────────
let randomModalOpen = false;

async function pickRandom() {
  randomModalOpen = true;
  if (state.discoverMode) {
    const params = new URLSearchParams({ ratio: state.ratio });
    if (state.fitInTime && availableMinutes() > 0) params.set('maxRuntime', Math.floor(availableMinutes() / state.ratio));
    const data = await api(`/api/discover/random?${params}`);
    if (data.film) openDiscoverDetail(data.film);
    else alert('No matching discover movies found!');
    return;
  }
  const params = new URLSearchParams();
  if (state.fitInTime && availableMinutes() > 0) {
    params.set('maxRuntime', Math.floor(availableMinutes() / state.ratio));
  }
  const data  = await api(`/api/movies/random?${params}`);
  if (data.movie) openDetail(data.movie);
  else alert('No matching movies found!');
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Event wiring ──────────────────────────────────────────────────────────────
function wireEvents() {
  // Ratio buttons
  document.getElementById('ratio-btns').addEventListener('click', e => {
    const btn = e.target.closest('.ratio-btn');
    if (!btn) return;
    document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.ratio = parseFloat(btn.dataset.ratio);
    state.page  = 1;
    saveSettings();
    if (state.discoverMode) loadDiscover(); else loadMovies();
    renderQueue();
  });

  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sort = btn.dataset.sort;
      state.page = 1;
      if (state.discoverMode) loadDiscover(); else loadMovies();
    });
  });

  // Discover toggle
  document.getElementById('discover-btn').addEventListener('click', () => {
    state.discoverMode = !state.discoverMode;
    document.getElementById('discover-btn').classList.toggle('active', state.discoverMode);
    document.getElementById('random-btn').classList.toggle('discover-active', state.discoverMode);
    document.getElementById('plan-btn').classList.toggle('discover-active', state.discoverMode);
    // In discover mode hide filters that don't apply
    document.getElementById('show-watched-btn').style.display  = state.discoverMode ? 'none' : '';
    document.getElementById('darken-watched-btn').style.display = state.discoverMode ? 'none' : '';
    // Swap foryou sort button for affinity in discover
    document.querySelector('.sort-btn[data-sort="foryou"]').style.display = state.discoverMode ? 'none' : '';
    document.querySelector('.sort-btn[data-sort="affinity"]').style.display = state.discoverMode ? '' : 'none';
    // Reset genre/country filters — options differ between modes
    state.genre   = 'all';
    state.country = 'all';
    document.getElementById('genre-select').value   = 'all';
    document.getElementById('country-select').value = 'all';
    if (state.discoverMode) {
      // Default sort to affinity in discover mode
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.sort-btn[data-sort="affinity"]').classList.add('active');
      state.sort = 'affinity';
    } else {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      document.querySelector(`.sort-btn[data-sort="${state.sort}"]`)?.classList.add('active')
        || document.querySelector('.sort-btn[data-sort="votes"]').classList.add('active');
      state.sort = state.sort === 'affinity' ? 'votes' : state.sort;
      // Restore watchlist genres/countries
      loadStats();
    }
    state.page = 1;
    if (state.discoverMode) loadDiscover(); else loadMovies();
  });

  // Time inputs
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const onTimeChange = debounce(() => {
    state.hours = parseInt(document.getElementById('hours-input').value) || 0;
    state.mins  = parseInt(document.getElementById('mins-input').value)  || 0;
    state.page  = 1;
    saveSettings();
    if (state.fitInTime) loadMovies();
    renderQueue();
  }, 400);
  document.getElementById('hours-input').addEventListener('input', onTimeChange);
  document.getElementById('mins-input').addEventListener('input', onTimeChange);

  // Genre
  document.getElementById('genre-select').addEventListener('change', e => {
    state.genre = e.target.value;
    state.page  = 1;
    if (state.discoverMode) loadDiscover(); else loadMovies();
  });

  // Country
  document.getElementById('country-select').addEventListener('change', e => {
    state.country = e.target.value;
    state.page    = 1;
    if (state.discoverMode) loadDiscover(); else loadMovies();
  });

  // Search
  let searchTimer = null;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      state.page   = 1;
      if (state.discoverMode) loadDiscover(); else loadMovies();
    }, 300);
  });

  // Fit in time
  document.getElementById('fit-toggle').addEventListener('change', e => {
    state.fitInTime = e.target.checked;
    state.page = 1;
    if (state.discoverMode) loadDiscover(); else loadMovies();
  });

  // Show watched toggle
  document.getElementById('show-watched-btn').addEventListener('click', () => {
    state.showWatched = !state.showWatched;
    document.getElementById('show-watched-btn').classList.toggle('active', state.showWatched);
    saveSettings();
    state.page = 1;
    loadMovies();
  });

  // Darken watched toggle (re-renders cards in place, no server call needed)
  document.getElementById('darken-watched-btn').addEventListener('click', () => {
    state.darkenWatched = !state.darkenWatched;
    document.getElementById('darken-watched-btn').classList.toggle('active', state.darkenWatched);
    saveSettings();
    renderGrid();
  });

  // Broken filter toggle
  document.getElementById('broken-btn').addEventListener('click', () => {
    state.showBroken = !state.showBroken;
    document.getElementById('broken-btn').classList.toggle('active', state.showBroken);
    state.page = 1;
    loadMovies();
  });

  // Header action buttons
  document.getElementById('plan-btn').addEventListener('click', openNightPlan);
  document.getElementById('random-btn').addEventListener('click', pickRandom);

  // Queue bar
  document.getElementById('queue-plan-btn').addEventListener('click', () => {
    // Show the queue as a "plan" in the night modal
    if (!state.queue.length) return;
    pinnedInNight.clear();
    const night = state.queue.map(m => ({ ...m, effectiveRuntime: effectiveRuntime(m) || m.runtime || 90 }));
    const used  = night.reduce((s, m) => s + m.effectiveRuntime, 0);
    document.getElementById('night-modal').classList.remove('hidden');
    renderNightBody({ night, budgetMinutes: availableMinutes() || used, usedMinutes: used, remainingMinutes: Math.max(0, (availableMinutes() || used) - used) });
  });
  document.getElementById('queue-clear-btn').addEventListener('click', () => {
    state.queue = [];
    saveQueue();
    renderQueue();
    renderGrid();
  });

  // Detail modal close
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-backdrop').addEventListener('click', closeDetail);

  // Night modal close
  document.getElementById('night-close').addEventListener('click', closeNightModal);
  document.getElementById('night-backdrop').addEventListener('click', closeNightModal);

  document.getElementById('stats-btn').addEventListener('click', openStats);
  document.getElementById('stats-close').addEventListener('click', closeStats);

  document.getElementById('overrides-btn').addEventListener('click', () => {
    window.location.href = '/overrides.html';
  });

  document.getElementById('series-btn').addEventListener('click', openSeriesManager);
  document.getElementById('series-close').addEventListener('click', closeSeriesManager);
  document.getElementById('series-backdrop').addEventListener('click', closeSeriesManager);

  // Keyboard shortcuts
  document.getElementById('director-close').addEventListener('click', closeDirectorModal);
  document.getElementById('director-backdrop').addEventListener('click', closeDirectorModal);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDetail(); closeNightModal(); closeStats(); closeSeriesManager(); closeDirectorModal(); }
    if (e.key === 'Enter' && randomModalOpen) { e.preventDefault(); pickRandom(); }
  });
}

// ── Overrides panel ───────────────────────────────────────────────────────────

function closeOverridesModal() {
  document.getElementById('overrides-modal').classList.add('hidden');
}

async function openOverridesPanel() {
  const modal = document.getElementById('overrides-modal');
  const body  = document.getElementById('overrides-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="overrides-header"><h2>🔧 TMDB Overrides</h2><p>Loading…</p></div>';

  try {
    const data = await api('/api/overrides');
    renderOverridesPanel(data);
  } catch (e) {
    body.innerHTML = '<div class="overrides-header"><h2>🔧 TMDB Overrides</h2><p style="color:var(--love)">Failed to load overrides.</p></div>';
  }
}

function renderOverridesPanel(data) {
  const body = document.getElementById('overrides-body');

  const rows = data.map(o => `
    <div class="override-row" data-uri="${esc(o.uri)}">
      <div class="override-row-name" title="${esc(o.uri)}">${esc(o.name)}</div>
      <div class="override-row-year">${o.year}</div>
      <div class="override-row-value">${o.tmdbId === null ? 'Skip (no TMDB)' : `TMDB #${o.tmdbId}`}</div>
      <button class="override-row-del" data-uri="${esc(o.uri)}">Remove</button>
    </div>`).join('');

  body.innerHTML = `
    <div class="overrides-header">
      <h2>🔧 TMDB Overrides</h2>
      <p>${data.length ? `${data.length} override${data.length > 1 ? 's' : ''} active` : 'No overrides set yet.'}</p>
    </div>
    <div class="overrides-list">
      ${rows || '<div class="overrides-empty">Use "Wrong match?" in any movie\'s detail modal to set an override.</div>'}
    </div>`;

  body.querySelectorAll('.override-row-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await fetch('/api/overrides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: btn.dataset.uri, clear: true }) });
        loadMovies();
        openOverridesPanel(); // refresh list
      } catch (e) { btn.disabled = false; btn.textContent = 'Remove'; }
    });
  });
}

// ── Series management modal ───────────────────────────────────────────────────

function closeSeriesManager() {
  document.getElementById('series-modal').classList.add('hidden');
}

async function openSeriesManager() {
  const modal = document.getElementById('series-modal');
  const body  = document.getElementById('series-body');
  modal.classList.remove('hidden');
  body.innerHTML = `<div class="overrides-header"><h2>📺 Series Groups</h2><p>Loading…</p></div>`;

  try {
    const [{ candidates, known }, groups] = await Promise.all([
      api('/api/series/candidates'),
      api('/api/series/groups'),
    ]);
    renderSeriesManager(candidates, groups);
  } catch (e) {
    body.innerHTML = `<div class="overrides-header"><h2>📺 Series Groups</h2><p style="color:var(--love)">Failed to load.</p></div>`;
  }
}

function renderSeriesManager(candidates, groups) {
  const body = document.getElementById('series-body');

  const activeRows = groups.map(g => `
    <div class="override-row" data-name="${esc(g.name)}">
      <div class="override-row-name">${esc(g.name)}</div>
      <div class="override-row-value">TMDB TV #${g.tmdbTvId}</div>
      <a class="detail-link" href="https://www.themoviedb.org/tv/${g.tmdbTvId}" target="_blank" rel="noopener" style="font-size:0.72rem;margin:0">TMDB ↗</a>
      <button class="override-row-del" data-name="${esc(g.name)}">Remove</button>
    </div>`).join('');

  const unknownCandidates = candidates.filter(c => !c.known && c.count >= 2);
  const candidateRows = unknownCandidates.length ? unknownCandidates.map(c => `
    <div class="series-candidate-row" data-name="${esc(c.name)}">
      <div class="override-row-name">${esc(c.name)} <span style="color:var(--text-dim);font-weight:400;font-size:0.75rem">(${c.count} episodes)</span></div>
      <div style="font-size:0.72rem;color:var(--text-dim);flex:1">${esc(c.example)}</div>
      <button class="btn btn-primary btn-sm series-add-btn" data-name="${esc(c.name)}">+ Add</button>
    </div>`).join('')
    : `<div class="overrides-empty">No new candidates found — all detected series are already grouped.</div>`;

  body.innerHTML = `
    <div class="overrides-header">
      <h2>📺 Series Groups</h2>
      <p>Episodes with a shared name prefix are collapsed into one card in the grid.</p>
    </div>
    <div class="overrides-list">
      ${activeRows || '<div class="overrides-empty">No series configured yet.</div>'}
    </div>
    <div class="overrides-header" style="border-top:1px solid var(--border);margin-top:4px">
      <h2 style="font-size:0.9rem">Auto-discovered candidates</h2>
      <p>Prefixes appearing in 2+ movies/episodes in your library.</p>
    </div>
    <div class="overrides-list" id="series-candidates">
      ${candidateRows}
    </div>
    <div class="overrides-header" style="border-top:1px solid var(--border);margin-top:4px">
      <h2 style="font-size:0.9rem">Add manually</h2>
    </div>
    <div style="padding:12px 24px 20px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <input type="text" id="series-add-name" class="override-id-input" style="width:160px" placeholder="Series name">
      <input type="number" id="series-add-id" class="override-id-input" style="width:130px" placeholder="TMDB TV ID">
      <button class="btn btn-primary btn-sm" id="series-add-manual-btn">Add</button>
    </div>`;

  // Remove existing series
  body.querySelectorAll('.override-row-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await fetch('/api/series/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: btn.dataset.name, remove: true }) });
      loadMovies();
      openSeriesManager();
    });
  });

  // Add candidate
  body.querySelectorAll('.series-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      document.getElementById('series-add-name').value = name;
      document.getElementById('series-add-id').focus();
      btn.closest('.series-candidate-row').style.background = 'var(--surface-2)';
    });
  });

  // Add manually
  document.getElementById('series-add-manual-btn').addEventListener('click', async () => {
    const name    = document.getElementById('series-add-name').value.trim();
    const tmdbTvId = parseInt(document.getElementById('series-add-id').value);
    if (!name || !tmdbTvId) return;
    const addBtn = document.getElementById('series-add-manual-btn');
    addBtn.disabled = true; addBtn.textContent = 'Adding…';
    await fetch('/api/series/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, tmdbTvId }) });
    loadMovies();
    openSeriesManager();
  });
}



function ratingColor(r, max = 5) {
  const p = r / max;
  if (p >= 0.8) return '#00d68f';
  if (p >= 0.65) return '#f5c842';
  if (p >= 0.5)  return '#ff9f43';
  return '#ff5e5b';
}

async function openStats() {
  document.getElementById('stats-overlay').classList.remove('hidden');
  const body = document.getElementById('stats-body');
  body.innerHTML = '<div class="stats-loading">Loading your data…</div>';
  try {
    const d = await api('/api/analytics');
    renderStats(d);
  } catch (e) {
    body.innerHTML = `<div class="stats-loading">Failed to load — run <code>node enrich.js</code> first to enrich watched movies.</div>`;
  }
}

function closeStats() {
  document.getElementById('stats-overlay').classList.add('hidden');
}

function renderStats(d) {
  const body = document.getElementById('stats-body');
  const { overview, decades, genres, countries, languages, divergence, pace, seasonal,
          popularityTiers, lengthBuckets, tasteProfile, diaryTotal, totalRewatches, rewatches,
          recentPopular, rarestGems, yearProgress, yearHighlights, rareGemMinAgeYears,
          watchlistEta, radarChart, directorSpotlight, ratingEvolution, genreDecadeHeatmap } = d;

  // ── Overview cards
  const ratingDistMax = Math.max(...overview.ratingDist.map(x => x.count), 1);
  const ratingDistHTML = overview.ratingDist.map(x => `
    <div class="rating-bar-wrap">
      <div class="rating-bar-col${x.count === Math.max(...overview.ratingDist.map(r => r.count)) ? ' active' : ''}"
           style="height:${Math.round(x.count / ratingDistMax * 50)}px"
           title="${x.rating}★: ${x.count} movies"></div>
      <div class="rating-bar-label">${x.rating}</div>
    </div>`).join('');

  const daysWatched = Math.round(overview.totalRuntimeHours / 24);
  const runtimeNote = overview.enrichedPct < 90
    ? `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">~estimated (${overview.enrichedPct}% of films have runtime data — run <code>node enrich.js</code> to improve)</div>` : '';

  // ── Watchlist ETA string
  let etaStr = '—', etaNote = '';
  if (watchlistEta?.etaMonths) {
    const totalM = watchlistEta.etaMonths;
    const y = Math.floor(totalM / 12);
    const m = Math.floor(totalM % 12);
    const d = Math.round((totalM % 1) * 30);
    etaStr = y > 0
      ? `~${y}y ${m > 0 ? m + 'm' : ''}`.trim()
      : `~${m}m ${d > 0 ? d + 'd' : ''}`.trim();
    etaNote = `at your recent pace of ${watchlistEta.monthlyPace}/month`;
  }

  // ── Decades bar chart
  const maxDecCount = Math.max(...decades.map(x => x.count), 1);
  const decadesHTML = decades.map(x => `
    <div class="bar-row">
      <div class="bar-row-label">${x.label}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(x.count / maxDecCount * 100)}%;background:${ratingColor(x.avgMyRating)}"></div>
      </div>
      <div class="bar-meta">${x.count} · ★${x.avgMyRating}${x.avgTmdb ? ` <span style="color:var(--text-dim)">(crowd ${(x.avgTmdb/2).toFixed(1)})</span>` : ''}</div>
    </div>`).join('');

  // ── Genres — two bars (count + avg rating)
  const maxGenCount = Math.max(...genres.map(x => x.count), 1);
  const genresHTML = genres.map(x => `
    <div class="bar-row">
      <div class="bar-row-label wide">${esc(x.name)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(x.count / maxGenCount * 100)}%;background:${ratingColor(x.avgRating)}"></div>
      </div>
      <div class="bar-meta">${x.count} films · ★${x.avgRating}</div>
    </div>`).join('');

  // ── Countries
  const maxCCount = Math.max(...(countries[0] ? [countries[0].count] : [1]));
  const countriesHTML = countries.map(x => `
    <div class="bar-row">
      <div class="bar-row-label wide">${esc(x.name)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(x.count / maxCCount * 100)}%;background:var(--accent-dim);border:1px solid var(--accent)"></div>
      </div>
      <div class="bar-meta">${x.count}</div>
    </div>`).join('');

  // ── Languages
  const maxLCount = Math.max(...(languages[0] ? [languages[0].count] : [1]));
  const langsHTML = languages.map(x => `
    <div class="bar-row">
      <div class="bar-row-label">${esc(x.name)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(x.count / maxLCount * 100)}%;background:rgba(99,102,241,0.5)"></div>
      </div>
      <div class="bar-meta">${x.count}</div>
    </div>`).join('');

  // ── Divergence (diff is on 0-5 scale)
  const mkDivItem = (m, isGem) => {
    const pAttrs = posterAttrs(m, 'w92');
    const sign   = m.diff > 0 ? '+' : '';
    const crowd  = (m.tmdb / 2).toFixed(1);
    return `
      <div class="div-item">
        ${pAttrs ? `<img class="div-poster" ${pAttrs} alt="${esc(m.name)}">` : `<div class="div-poster"></div>`}
        <div class="div-info">
          <div class="div-title">${esc(m.name)} <span style="color:var(--text-dim);font-weight:400">${m.year}</span></div>
          <div class="div-ratings">You ★${m.myRating} · Crowd ★${crowd}</div>
        </div>
        <div class="div-badge ${isGem ? 'pos' : 'neg'}">${sign}${m.diff}</div>
      </div>`;
  };

  const gemsHTML  = divergence.hiddenGems.map(m => mkDivItem(m, true)).join('');
  const overHTML  = divergence.overrated.map(m => mkDivItem(m, false)).join('');

  // ── Pace chart — number sits above the bar, not inside it
  const maxPace = Math.max(...pace.map(x => x.count), 1);
  const now3    = new Date().toISOString().slice(0, 7);
  const paceHTML = pace.map(x => {
    const h = Math.max(Math.round(x.count / maxPace * 80), 4);
    return `
    <div class="pace-bar-wrap">
      <span class="pace-bar-num">${x.count}</span>
      <div class="pace-bar${x.month === now3 ? ' recent' : ''}" style="height:${h}px" title="${x.month}: ${x.count} movies"></div>
      <div class="pace-label">${x.month.slice(2)}</div>
    </div>`;
  }).join('');

  // ── Seasonal (by month of year)
  const maxSeas = Math.max(...(seasonal||[]).map(x => x.count), 1);
  const seasHTML = (seasonal||[]).map(x => {
    const h = Math.max(Math.round(x.count / maxSeas * 80), 4);
    return `
    <div class="pace-bar-wrap">
      <span class="pace-bar-num">${x.count || ''}</span>
      <div class="pace-bar" style="height:${h}px" title="${x.name}: ${x.count}"></div>
      <div class="pace-label">${x.name}</div>
    </div>`;
  }).join('');

  // ── Film length buckets
  const maxLenCount = Math.max(...(lengthBuckets||[]).map(t => t.count), 1);
  const lenHTML = (lengthBuckets||[]).map(t => `
    <div class="tier-row">
      <div class="tier-label">${t.label} <div class="tier-sub">${t.sublabel}</div></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(t.count/maxLenCount*100)}%;background:rgba(245,200,66,0.25);border:1px solid var(--accent)"></div>
      </div>
      <div class="bar-meta">${t.count}</div>
    </div>`).join('');

  // ── Popularity tiers
  const maxTCount = Math.max(...popularityTiers.map(t => t.count), 1);
  const tierColors = ['var(--success)', '#4ade80', 'var(--accent)', '#fb923c', 'var(--love)'];
  const tiersHTML = popularityTiers.map((t, i) => `
    <div class="tier-row">
      <div class="tier-label">${t.label} <div class="tier-sub">${t.sublabel}</div></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(t.count/maxTCount*100)}%;background:${tierColors[i]};opacity:0.7"></div>
      </div>
      <div class="bar-meta">${t.count}</div>
    </div>`).join('');

  // ── Rewatches — poster grid
  const rewatchHTML = (rewatches||[]).map(r => {
    const pAttrs = posterAttrs(r, 'w92');
    return `
    <div class="rewatch-item">
      ${pAttrs
        ? `<img class="rewatch-poster" ${pAttrs} alt="${esc(r.name)}">`
        : `<div class="rewatch-poster rewatch-poster-ph">${initials(r.name)}</div>`}
      <div class="rewatch-count">${r.count}×</div>
      <div class="rewatch-name">${esc(r.name)}</div>
    </div>`;
  }).join('');

  // ── Recent watches — poster grid cards
  const mkRecentItem = (m) => {
    const pAttrs = posterAttrs(m, 'w154');
    const rating = m.myRating ? `★${m.myRating}` : '';
    const date = m.watchedDate ? m.watchedDate.slice(5).replace('-', '/') : '';
    const votes = fmtVotes(m.voteCount);
    return `
      <div class="recent-poster-card" title="${esc(m.name)} (${m.year}) — ${votes} votes${rating ? `, you ${rating}` : ''}">
        <div class="recent-poster-wrap">
          ${pAttrs
            ? `<img class="recent-poster" ${pAttrs} alt="${esc(m.name)}" loading="lazy">`
            : `<div class="recent-poster recent-poster-ph">${initials(m.name)}</div>`}
          <span class="recent-poster-badge">${votes}</span>
        </div>
        <div class="recent-poster-title">${esc(m.name)}</div>
        ${rating || date ? `<div class="recent-poster-meta">${rating ? `<span class="recent-poster-rating">${rating}</span>` : ''}${rating && date ? ' · ' : ''}${date ? `<span class="recent-poster-date">${date}</span>` : ''}</div>` : ''}
      </div>`;
  };
  const recentPopularHTML = (recentPopular||[]).map(m => mkRecentItem(m)).join('');
  const rarestGemsHTML = (rarestGems||[]).map(m => mkRecentItem(m)).join('');

  // ── Year highlights — milestones + busiest week
  const yh = yearHighlights;
  const mkMilestoneItem = (m) => {
    const pAttrs = posterAttrs(m, 'w154');
    return `
    <div class="milestone-item${m.kind ? ` milestone-${m.kind}` : ''}" title="${esc(m.name)} (${m.year})">
      ${pAttrs
        ? `<img class="milestone-poster" ${pAttrs} alt="${esc(m.name)}" loading="lazy">`
        : `<div class="milestone-poster milestone-poster-ph">${initials(m.name)}</div>`}
      <div class="milestone-label">${m.label}</div>
      <div class="milestone-date">${m.dateLabel}</div>
    </div>`;
  };
  const statsBodyEl = document.getElementById('stats-body');
  const milestoneMaxPerRow = Math.max(3, Math.floor(((statsBodyEl?.clientWidth || 1100) - 48) / 112));
  const milestoneRows = splitEvenRows(yh?.milestones || [], milestoneMaxPerRow);
  const milestonesHTML = milestoneRows.map(row =>
    `<div class="milestone-row" style="--milestone-cols:${row.length}">${row.map(mkMilestoneItem).join('')}</div>`
  ).join('');
  const weekMax = Math.max(...(yh?.weeklyWatches || []).map(w => w.count), 1);
  const weekBarsHTML = (yh?.weeklyWatches || []).map(w => {
    const h = Math.max(Math.round(w.count / weekMax * 88), w.count ? 3 : 1);
    const callout = w.isPeak && yh?.busiestWeek ? `
      <div class="week-peak-callout">
        <div class="week-peak-num">${w.count} films</div>
        <div class="week-peak-meta">Week ${w.week}</div>
        <div class="week-peak-range">${yh.busiestWeek.rangeLabel}</div>
      </div>` : '';
    return `
    <div class="week-bar-wrap" title="Week ${w.week}: ${w.count} films">
      ${callout}
      <div class="week-bar${w.isPeak ? ' peak' : ''}" style="height:${h}px"></div>
    </div>`;
  }).join('');

  // ── Taste profile
  const tasteGenHTML  = tasteProfile.topGenres.map(x => `<div class="taste-chip">${esc(x.genre)} <span class="taste-chip-score">★${x.score}</span></div>`).join('');
  const tasteDecHTML  = tasteProfile.topDecades.map(x => `<div class="taste-chip">${x.decade}s <span class="taste-chip-score">★${x.score}</span></div>`).join('');

  // ── Radar Chart (Cinephile DNA) — SVG spider chart
  const radarSize = 320, radarCenter = radarSize / 2, radarRadius = 100;
  const radarAxes = radarChart || [];
  const radarPoints = radarAxes.map((a, i) => {
    const angle = (Math.PI * 2 * i / radarAxes.length) - Math.PI / 2;
    const r = radarRadius * (a.value / 100);
    return { x: radarCenter + r * Math.cos(angle), y: radarCenter + r * Math.sin(angle), ...a };
  });
  const radarPolygon = radarPoints.map(p => `${p.x},${p.y}`).join(' ');
  const radarGrids = [0.25, 0.5, 0.75, 1].map(scale => {
    const pts = radarAxes.map((_, i) => {
      const angle = (Math.PI * 2 * i / radarAxes.length) - Math.PI / 2;
      return `${radarCenter + radarRadius * scale * Math.cos(angle)},${radarCenter + radarRadius * scale * Math.sin(angle)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
  }).join('');
  const radarAxisLines = radarAxes.map((_, i) => {
    const angle = (Math.PI * 2 * i / radarAxes.length) - Math.PI / 2;
    return `<line x1="${radarCenter}" y1="${radarCenter}" x2="${radarCenter + radarRadius * Math.cos(angle)}" y2="${radarCenter + radarRadius * Math.sin(angle)}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;
  }).join('');
  const radarLabels = radarAxes.map((a, i) => {
    const angle = (Math.PI * 2 * i / radarAxes.length) - Math.PI / 2;
    const lx = radarCenter + (radarRadius + 38) * Math.cos(angle);
    const ly = radarCenter + (radarRadius + 38) * Math.sin(angle);
    return `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="var(--text-mid)" font-size="11" font-weight="600">${a.axis}</text>
            <text x="${lx}" y="${ly + 14}" text-anchor="middle" dominant-baseline="middle" fill="var(--text-dim)" font-size="9">${a.value}</text>`;
  }).join('');
  const radarHTML = radarAxes.length ? `
    <div class="radar-container">
      <svg viewBox="0 0 ${radarSize} ${radarSize}" class="radar-svg">
        ${radarGrids}${radarAxisLines}
        <polygon points="${radarPolygon}" fill="rgba(245,200,66,0.15)" stroke="var(--accent)" stroke-width="2"/>
        ${radarPoints.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5"/>`).join('')}
        ${radarLabels}
      </svg>
      <div class="radar-legend">${radarAxes.map(a => `<div class="radar-legend-item"><span class="radar-legend-dot"></span>${a.axis}: ${a.description}</div>`).join('')}</div>
    </div>` : '';

  // ── Director Spotlight
  const dirSpotHTML = (directorSpotlight || []).map(d => `
    <div class="dir-spot-row">
      <div class="dir-spot-name">${esc(d.name)}</div>
      <div class="dir-spot-meta">${d.count} films · ★${d.avgRating}</div>
      <div class="dir-spot-range">
        <span class="dir-spot-best" title="Best: ${esc(d.best.name)}">▲ ${esc(d.best.name)} (★${d.best.myRating})</span>
        ${d.best.name !== d.worst.name ? `<span class="dir-spot-worst" title="Worst: ${esc(d.worst.name)}">▼ ${esc(d.worst.name)} (★${d.worst.myRating})</span>` : ''}
      </div>
    </div>`).join('');

  // ── Rating Evolution
  const maxEvoCount = Math.max(...(ratingEvolution||[]).map(x => x.count), 1);
  const evoHTML = (ratingEvolution || []).map(x => {
    const h = Math.max(Math.round((x.avg / 5) * 70), 4);
    return `
    <div class="evo-bar-wrap">
      <span class="evo-bar-num">★${x.avg.toFixed(1)}</span>
      <div class="evo-bar" style="height:${h}px;opacity:${0.4 + (x.count / maxEvoCount) * 0.6}" title="${x.quarter}: ★${x.avg.toFixed(2)} (${x.count} films)"></div>
      <div class="evo-label">${x.quarter.replace('-', '\n')}</div>
    </div>`;
  }).join('');

  // ── Genre × Decade Heatmap
  const hm = genreDecadeHeatmap || { genres: [], decades: [], cells: [] };
  // Find min/max ratings in the heatmap for relative coloring
  let hmMin = 5, hmMax = 0;
  hm.cells.forEach(row => row.forEach(cell => {
    if (cell) { hmMin = Math.min(hmMin, cell.avg); hmMax = Math.max(hmMax, cell.avg); }
  }));
  const hmRange = hmMax - hmMin || 1;
  const hmCellHTML = hm.genres.map((g, gi) => `
    <div class="hm-row">
      <div class="hm-row-label">${esc(g)}</div>
      ${hm.decades.map((d, di) => {
        const cell = hm.cells[gi]?.[di];
        if (!cell) return `<div class="hm-cell empty"></div>`;
        const t = (cell.avg - hmMin) / hmRange;
        const hue = Math.round(t * 120);
        const sat = 60 + t * 20;
        const lum = 18 + t * 20;
        return `<div class="hm-cell" style="background:hsl(${hue},${sat}%,${lum}%)" title="${g} ${d}s: ★${cell.avg} (${cell.count} films)"><span class="hm-val">${cell.avg}</span></div>`;
      }).join('')}
    </div>`).join('');
  const hmHeaderHTML = hm.decades.map(d => `<div class="hm-col-label">${d}s</div>`).join('');
  const noCountry = !countries.length;
  const noLang    = !languages.length;
  const avgPerMonth = diaryTotal ? (diaryTotal / Math.max(pace.length, 1)).toFixed(1) : '?';

  body.innerHTML = `
    <div class="stats-section">
      <div class="stats-overview">
        <div class="stat-card"><div class="stat-card-value">${overview.total.toLocaleString()}</div><div class="stat-card-label">Movies rated</div></div>
        <div class="stat-card"><div class="stat-card-value">${diaryTotal ? diaryTotal.toLocaleString() : '–'}</div><div class="stat-card-label">Diary entries</div></div>
        <div class="stat-card"><div class="stat-card-value">★ ${overview.avgRating}</div><div class="stat-card-label">Avg rating (0–5)</div></div>
        <div class="stat-card"><div class="stat-card-value">${overview.totalRuntimeHours.toLocaleString()}h</div><div class="stat-card-label">Est. watch time</div></div>
        <div class="stat-card"><div class="stat-card-value">${daysWatched} days</div><div class="stat-card-label">That's how many days</div></div>
        <div class="stat-card"><div class="stat-card-value">${avgPerMonth}</div><div class="stat-card-label">Movies/month (avg)</div></div>
        ${totalRewatches ? `<div class="stat-card"><div class="stat-card-value">${totalRewatches}</div><div class="stat-card-label">Total rewatches</div></div>` : ''}
      </div>
      ${runtimeNote}
      <div style="margin-top:12px">
        <div class="stats-section-title">Rating distribution (how you scored movies)</div>
        <div class="rating-dist" style="margin-top:8px">${ratingDistHTML}</div>
      </div>
    </div>

    ${yearProgress ? `
    <div class="stats-section">
      <div class="stats-section-title">${yearProgress.year} progress — day ${yearProgress.dayOfYear} of ${yearProgress.daysInYear}</div>
      <div class="stats-overview">
        <div class="stat-card"><div class="stat-card-value">${yearProgress.uniqueMovies.toLocaleString()}</div><div class="stat-card-label">Unique films this year</div></div>
        <div class="stat-card"><div class="stat-card-value">${yearProgress.totalWithRepeats.toLocaleString()}</div><div class="stat-card-label">Total watches (incl. rewatches)</div></div>
        <div class="stat-card"><div class="stat-card-value">${yearProgress.avgPerDay}</div><div class="stat-card-label">Films per day (avg)</div></div>
        <div class="stat-card"><div class="stat-card-value">${yearProgress.hoursWatched.toLocaleString()}h</div><div class="stat-card-label">Est. hours since Jan 1</div></div>
      </div>
    </div>` : ''}

    ${yh?.milestones?.length ? `
    <div class="stats-section">
      <div class="stats-section-title">Diary milestones — ${yh.year}</div>
      <div class="milestone-grid">${milestonesHTML}</div>
    </div>` : ''}

    ${yh?.weeklyWatches?.length ? `
    <div class="stats-section">
      <div class="stats-section-title">Most watched week of ${yh.year}</div>
      <div class="week-chart">
        <div class="week-bars">${weekBarsHTML}</div>
        <div class="week-months">
          <span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span>
        </div>
      </div>
    </div>` : ''}

    ${watchlistEta ? `
    <div class="stats-section">
      <div class="stats-section-title">Watchlist countdown</div>
      <div class="stats-overview">
        <div class="stat-card"><div class="stat-card-value">${watchlistEta.remaining.toLocaleString()}</div><div class="stat-card-label">Movies left to watch</div></div>
        <div class="stat-card"><div class="stat-card-value">${watchlistEta.hoursLeft.toLocaleString()}h</div><div class="stat-card-label">Est. hours remaining</div></div>
        <div class="stat-card"><div class="stat-card-value">${watchlistEta.monthlyPace}/mo</div><div class="stat-card-label">Your recent pace</div></div>
        <div class="stat-card"><div class="stat-card-value" style="color:var(--accent)">${etaStr}</div><div class="stat-card-label">${etaNote || 'to finish watchlist'}</div></div>
      </div>
    </div>` : ''}

    <div class="stats-section">
      <div class="stats-section-title">Watching pace — movies per month (last 2 years)</div>
      <div class="pace-chart">${paceHTML || '<div style="color:var(--text-dim)">No diary data found</div>'}</div>
    </div>

    ${seasHTML ? `
    <div class="stats-section">
      <div class="stats-section-title">Seasonal watching — avg movies per month (across years)</div>
      <div class="pace-chart">${seasHTML}</div>
    </div>` : ''}

    ${(recentPopular?.length || rarestGems?.length) ? `
    <div class="stats-section">
      <div class="stats-section-title">Recent watches — popularity vs obscurity</div>
      <div class="recent-watches-board">
        <div class="recent-watches-col">
          <div class="recent-watches-heading">
            <div class="divergence-col-title gem">🔥 Most popular lately</div>
            <div class="recent-watches-caption">2K+ votes · last 100 · newest first</div>
          </div>
          <div class="recent-poster-grid">${recentPopularHTML || '<div class="recent-watches-empty">Need diary + TMDB data</div>'}</div>
        </div>
        <div class="recent-watches-col">
          <div class="recent-watches-heading">
            <div class="divergence-col-title gem">💎 Rarest gems</div>
            <div class="recent-watches-caption">Bottom 25% votes · last 100 · ${rareGemMinAgeYears ?? 2}+ yrs old · newest first</div>
          </div>
          <div class="recent-poster-grid">${rarestGemsHTML || '<div class="recent-watches-empty">Need diary + TMDB data</div>'}</div>
        </div>
      </div>
    </div>` : ''}

    <div class="stats-section">
      <div class="stats-section-title">By decade — bar width = films watched, color = your avg rating</div>
      <div class="bar-chart">${decadesHTML}</div>
    </div>

    ${genres.length ? `
    <div class="stats-section">
      <div class="stats-section-title">Genres — sorted by films watched, colored by avg rating</div>
      <div class="bar-chart">${genresHTML}</div>
    </div>` : ''}

    <div class="stats-section">
      <div class="stats-section-title">You vs The Crowd — minimum 1★ gap on 0–5 scale</div>
      <div class="divergence-grid">
        <div class="divergence-col">
          <div class="divergence-col-title gem">💎 You loved it, crowd was meh</div>
          ${gemsHTML || '<div style="color:var(--text-dim);font-size:0.82rem">Not enough data yet — run <code>node enrich.js</code></div>'}
        </div>
        <div class="divergence-col">
          <div class="divergence-col-title over">🙄 Crowd loved it, you didn't</div>
          ${overHTML || '<div style="color:var(--text-dim);font-size:0.82rem">Not enough data yet — run <code>node enrich.js</code></div>'}
        </div>
      </div>
    </div>

    ${noCountry && noLang ? `
    <div class="stats-section">
      <div class="stats-section-title">Country & language breakdown</div>
      <div style="color:var(--text-dim);font-size:0.85rem">
        Run <code>node enrich.js</code> to add country/language data (one-time, ~2 min).
      </div>
    </div>` : `
    ${!noCountry ? `
    <div class="stats-section">
      <div class="stats-section-title">Top countries of origin</div>
      <div class="bar-chart">${countriesHTML}</div>
    </div>` : ''}
    ${!noLang ? `
    <div class="stats-section">
      <div class="stats-section-title">Original language</div>
      <div class="bar-chart">${langsHTML}</div>
    </div>` : ''}`}

    <div class="stats-section">
      <div class="stats-section-title">Film length preference</div>
      <div class="tier-list">${lenHTML || '<div style="color:var(--text-dim)">Run node enrich.js for runtime data</div>'}</div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">How mainstream do you watch?</div>
      <div class="tier-list">${tiersHTML}</div>
    </div>

    ${rewatches && rewatches.length ? `
    <div class="stats-section">
      <div class="stats-section-title">Most rewatched films</div>
      <div class="rewatch-grid">${rewatchHTML}</div>
    </div>` : ''}

    <div class="stats-section">
      <div class="stats-section-title">Your taste profile — powers "For You ✦" sort</div>
      <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:8px">Built from your ratings — genres and eras you consistently rate highest</div>
      <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em">Favourite genres</div>
      <div class="taste-chips">${tasteGenHTML || '<span style="color:var(--text-dim);font-size:0.8rem">Need more rated movies to compute</span>'}</div>
      <div style="font-size:0.72rem;color:var(--text-dim);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.06em">Favourite decades</div>
      <div class="taste-chips">${tasteDecHTML || '<span style="color:var(--text-dim);font-size:0.8rem">Need more rated movies to compute</span>'}</div>
    </div>

    ${radarHTML ? `
    <div class="stats-section">
      <div class="stats-section-title">Cinephile DNA — your viewer personality</div>
      ${radarHTML}
    </div>` : ''}

    ${dirSpotHTML ? `
    <div class="stats-section">
      <div class="stats-section-title">Director spotlight — your most-watched filmmakers</div>
      <div class="dir-spot-list">${dirSpotHTML}</div>
    </div>` : ''}

    ${evoHTML ? `
    <div class="stats-section">
      <div class="stats-section-title">Rating evolution — are you getting pickier?</div>
      <div class="pace-chart evo-chart">${evoHTML}</div>
    </div>` : ''}

    ${hm.genres.length ? `
    <div class="stats-section">
      <div class="stats-section-title">Genre × Decade — where your taste shines (color = rating)</div>
      <div class="heatmap-grid">
        <div class="hm-row hm-header"><div class="hm-row-label"></div>${hmHeaderHTML}</div>
        ${hmCellHTML}
      </div>
    </div>` : ''}`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Global poster fallback: local /posters/{id}.jpg → TMDB CDN → placeholder
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  if (img.dataset.cdn) {
    // local file failed → try CDN
    img.src = img.dataset.cdn;
    delete img.dataset.cdn;
  } else if (img.dataset.name) {
    // CDN also failed (or no CDN) → show initials placeholder
    img.replaceWith(makePlaceholder(img.dataset.name));
  }
}, true);

async function init() {
  loadSettings();
  loadQueue();
  wireEvents();
  renderQueue();

  // Set first sort button active
  document.querySelector('.sort-btn[data-sort="votes"]').classList.add('active');

  // Sync ratio button active state from saved settings
  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.ratio) === state.ratio);
  });

  // Sync watched buttons from saved settings
  document.getElementById('show-watched-btn').classList.toggle('active', state.showWatched);
  document.getElementById('darken-watched-btn').classList.toggle('active', state.darkenWatched);
  // Sync discover-active on random/plan if discover mode is restored from settings
  document.getElementById('random-btn').classList.toggle('discover-active', state.discoverMode);
  document.getElementById('plan-btn').classList.toggle('discover-active', state.discoverMode);

  // Hide broken button until we know the count (updateEnrichBar will show it if needed)
  document.getElementById('broken-btn').style.display = 'none';

  // Sync time inputs from state
  document.getElementById('hours-input').value = state.hours;
  document.getElementById('mins-input').value  = state.mins;

  // Load local library state for discover action buttons
  try {
    const lib = await fetch('/api/local-library').then(r => r.json());
    state.localWatchlist = new Set((lib.watchlist || []).map(e => e.tmdbId));
    state.localWatched   = new Set((lib.watched   || []).map(e => e.tmdbId));
  } catch { state.localWatchlist = new Set(); state.localWatched = new Set(); }

  await loadStats();
  await loadMovies();
  setupScrollObserver();
}

// ── Director filmography ──────────────────────────────────────────────────────

function closeDirectorModal() {
  document.getElementById('director-modal').classList.add('hidden');
}

async function openDirectorFilmography(name) {
  const modal = document.getElementById('director-modal');
  const body  = document.getElementById('director-body');
  modal.classList.remove('hidden');
  body.innerHTML = `<div class="director-film-loading">Loading filmography…</div>`;

  const data = await fetch(`/api/director/filmography?name=${encodeURIComponent(name)}`).then(r => r.json());

  if (!data.person) {
    body.innerHTML = `<div class="director-film-loading">No results found for "${esc(name)}".</div>`;
    return;
  }

  const { person, movies } = data;
  const inList    = movies.filter(m => m.inWatchlist || m.watched).length;
  const avatarHtml = person.profilePath
    ? `<img class="director-avatar" src="https://image.tmdb.org/t/p/w185${esc(person.profilePath)}" alt="">`
    : `<div class="director-avatar-ph">🎬</div>`;

  body.innerHTML = `
    <div class="director-header">
      <div class="director-header-row">
        ${avatarHtml}
        <div>
          <div class="director-name">${esc(person.name)}</div>
          <div class="director-count">${movies.length} film${movies.length !== 1 ? 's' : ''}${inList ? ` · ${inList} in your library` : ''}</div>
        </div>
      </div>
    </div>
    <div class="director-film-grid" id="dir-film-grid"></div>`;

  const grid = body.querySelector('#dir-film-grid');
  movies.forEach(m => {
    const card = document.createElement('div');
    card.className = `dir-film-card${m.watched ? ' watched' : ''}`;
    card.title = m.overview || m.title;

    const posterHtml = m.posterId
      ? `<img class="dir-film-poster" src="/posters/${m.posterId}.jpg" alt="${esc(m.title)}" loading="lazy">`
      : m.posterPath
        ? `<img class="dir-film-poster" src="https://image.tmdb.org/t/p/w185${esc(m.posterPath)}" alt="${esc(m.title)}" loading="lazy">`
        : `<div class="dir-film-poster-ph">🎬</div>`;

    const badgeHtml = m.inWatchlist
      ? `<span class="dir-film-badge in-watchlist">Watchlist</span>`
      : m.watched
        ? `<span class="dir-film-badge watched">Watched</span>`
        : '';

    card.innerHTML = `
      ${posterHtml}
      ${badgeHtml}
      <div class="dir-film-info">
        <div class="dir-film-title">${esc(m.title)}</div>
        <div class="dir-film-year">${m.year || ''}${m.voteAverage ? ` · ★ ${m.voteAverage}` : ''}${m.runtime ? ` · ${fmtMins(m.runtime)}` : ''}</div>
        ${m.genres?.length ? `<div class="dir-film-genres">${m.genres.slice(0, 2).join(', ')}</div>` : ''}
      </div>`;

    card.addEventListener('click', () => {
      openDiscoverDetail({
        id:          `discover-${m.tmdbId}`,
        source:      'discover',
        tmdbId:      m.tmdbId,
        name:        m.title,
        year:        m.year,
        posterPath:  m.posterPath,
        posterId:    m.posterId,
        overview:    m.overview,
        voteAverage: m.voteAverage,
        voteCount:   m.voteCount,
        runtime:     m.runtime,
        genres:      m.genres || [],
        directors:   [name],
      });
    });

    grid.appendChild(card);
  });
}

init();
