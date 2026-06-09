import asyncio
import httpx
import urllib.parse
from datetime import datetime

TMDB_BASE = "https://api.themoviedb.org/3"
THIS_YEAR = datetime.now().year


def is_suspect_year(letterboxd_year: int, tmdb_year: int) -> bool:
    if not letterboxd_year or not tmdb_year:
        return False
    diff = abs(letterboxd_year - tmdb_year)
    threshold = 1 if letterboxd_year >= THIS_YEAR - 1 else 3
    return diff > threshold


def build_entry(d: dict) -> dict:
    return {
        "tmdbId": d.get("id"),
        "runtime": d.get("runtime") or None,
        "overview": d.get("overview", ""),
        "voteAverage": round((d.get("vote_average") or 0) * 10) / 10,
        "voteCount": d.get("vote_count") or 0,
        "posterPath": d.get("poster_path"),
        "backdropPath": d.get("backdrop_path"),
        "genres": [g["name"] for g in d.get("genres", [])],
        "tagline": d.get("tagline", ""),
        "imdbId": d.get("imdb_id"),
        "countries": [c["name"] for c in d.get("production_countries", [])],
        "language": d.get("original_language"),
        "releaseDate": d.get("release_date"),
        "directors": [c["name"] for c in d.get("credits", {}).get("crew", []) if c.get("job") == "Director"],
    }


def build_tv_entry(d: dict) -> dict:
    runtimes = d.get("episode_run_time", [])
    return {
        "tmdbId": d.get("id"),
        "mediaType": "tv",
        "runtime": runtimes[0] if runtimes else None,
        "overview": d.get("overview", ""),
        "voteAverage": round((d.get("vote_average") or 0) * 10) / 10,
        "voteCount": d.get("vote_count") or 0,
        "posterPath": d.get("poster_path"),
        "backdropPath": d.get("backdrop_path"),
        "genres": [g["name"] for g in d.get("genres", [])],
        "tagline": d.get("tagline", ""),
        "imdbId": None,
        "countries": [c["name"] for c in d.get("production_countries", [])],
        "language": d.get("original_language"),
        "releaseDate": d.get("first_air_date"),
        "directors": [c["name"] for c in d.get("created_by", [])],
    }


class TMDBEnricher:
    def __init__(self, api_key: str, max_concurrent: int = 6):
        self.api_key = api_key
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.client = None

    async def _fetch(self, url: str, attempt: int = 0) -> dict | None:
        async with self.semaphore:
            try:
                resp = await self.client.get(url)
                if resp.status_code == 429:
                    delay = 2 * min(attempt + 1, 5)
                    await asyncio.sleep(delay)
                    return await self._fetch(url, attempt + 1)
                if resp.status_code != 200:
                    return None
                return resp.json()
            except Exception:
                return None

    async def _enrich_one(self, name: str, year: str, uri: str) -> dict:
        qname = urllib.parse.quote(name)

        # Search movie with year
        r = await self._fetch(f"{TMDB_BASE}/search/movie?query={qname}&primary_release_year={year}&api_key={self.api_key}&language=en-US")
        hit = r["results"][0] if r and r.get("results") else None

        # Fallback: search without year
        if not hit:
            r = await self._fetch(f"{TMDB_BASE}/search/movie?query={qname}&api_key={self.api_key}&language=en-US")
            yn = int(year) if year else 0
            if r and r.get("results"):
                for m in r["results"]:
                    m_year = int(m.get("release_date", "0")[:4] or "0")
                    if abs(m_year - yn) <= 2:
                        hit = m
                        break

        # TV fallback
        if not hit:
            tv_r = await self._fetch(f"{TMDB_BASE}/search/tv?query={qname}&first_air_date_year={year}&api_key={self.api_key}&language=en-US")
            tv_hit = tv_r["results"][0] if tv_r and tv_r.get("results") else None
            if not tv_hit:
                tv_r = await self._fetch(f"{TMDB_BASE}/search/tv?query={qname}&api_key={self.api_key}&language=en-US")
                yn = int(year) if year else 0
                if tv_r and tv_r.get("results"):
                    for t in tv_r["results"]:
                        t_year = int(t.get("first_air_date", "0")[:4] or "0")
                        if abs(t_year - yn) <= 2:
                            tv_hit = t
                            break
            if tv_hit:
                tv_year = int(tv_hit.get("first_air_date", "0")[:4] or "0")
                yn = int(year) if year else 0
                if not is_suspect_year(yn, tv_year):
                    d = await self._fetch(f"{TMDB_BASE}/tv/{tv_hit['id']}?api_key={self.api_key}&language=en-US&append_to_response=credits")
                    if d:
                        return build_tv_entry(d)
            return {"notFound": True}

        # Year sanity check
        yn = int(year) if year else 0
        hit_year = int(hit.get("release_date", "0")[:4] or "0")
        if is_suspect_year(yn, hit_year):
            return {"notFound": True, "suspectMatch": True}

        # Fetch full details
        d = await self._fetch(f"{TMDB_BASE}/movie/{hit['id']}?api_key={self.api_key}&language=en-US&append_to_response=credits")
        if d:
            return build_entry(d)
        return {"failed": True}

    async def enrich_movies(self, movies: list[dict], progress_callback=None) -> dict:
        """
        Enrich a list of movies with TMDB data.
        movies: list of dicts with keys 'Name', 'Year', 'Letterboxd URI'
        Returns: dict keyed by Letterboxd URI with TMDB data
        """
        cache = {}
        total = len(movies)

        self.client = httpx.AsyncClient(timeout=30.0)
        try:
            batch_size = 20
            done = 0
            for i in range(0, total, batch_size):
                batch = movies[i:i + batch_size]
                tasks = [
                    self._enrich_one(m["Name"], m.get("Year", ""), m["Letterboxd URI"])
                    for m in batch
                ]
                results = await asyncio.gather(*tasks)
                for m, result in zip(batch, results):
                    cache[m["Letterboxd URI"]] = result
                done += len(batch)
                if progress_callback:
                    progress_callback(min(done, total), total)
                await asyncio.sleep(0.05)
        finally:
            await self.client.aclose()

        return cache


def enrich_sync(movies: list[dict], api_key: str, progress_callback=None) -> dict:
    """Synchronous wrapper for enrichment."""
    enricher = TMDBEnricher(api_key)
    return asyncio.run(enricher.enrich_movies(movies, progress_callback))
