# Movie Night

Browse your Letterboxd watchlist, pick a movie night, and explore personal stats — ratings, pace, streaks, and more.

## Setup

1. **Install deps**

```bash
make install
```

Deps come from the public npm registry (`registry.npmjs.org`). A project `.npmrc` pins that so a private npm mirror config won’t break installs.

2. **Add a TMDB API key**

Get a free key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api), then:

```bash
cp .env.example .env
# edit .env and set TMDB_API_KEY=your_key_here
```

3. **Add your Letterboxd export**

The repo includes an empty `archive/` folder. Export your data from [letterboxd.com/settings/data](https://letterboxd.com/settings/data), unzip it, and drop the folder into `archive/`:

```text
archive/
  letterboxd-you-2026-08-04-…/
    watchlist.csv
    ratings.csv
    watched.csv
    diary.csv
    …
```

The app uses the latest folder in `archive/`.

4. **Enrich + run**

```bash
make rebuild   # fetch TMDB metadata + posters (first time / after a new export)
make run       # start → http://localhost:3000
```

That's it — open the browser and enjoy.

## Commands

| Command | What it does |
|---------|----------------|
| `make run` | Start the server |
| `make rebuild` | Enrich from TMDB + download posters |
| `make enrich` | Fetch / refresh TMDB metadata only |
| `make clean-cache` | Delete `tmdb-cache.json` (full re-enrich next time) |
| `make clean-posters` | Delete cached poster images |
| `make dev` | Start with auto-reload |

Optional: set `PORT=3000` in `.env` to change the port.
