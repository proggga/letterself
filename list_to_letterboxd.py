#!/usr/bin/env python3
"""
Convert list.txt (ranked film list) to a Letterboxd-importable CSV with TMDB IDs.

Usage:
    python3 list_to_letterboxd.py
    python3 list_to_letterboxd.py list.txt list_tmdb.csv

Reads TMDB_API_KEY from .env.
Caches lookups in list-tmdb-cache.json.
"""

from __future__ import annotations

import csv
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

THIS_YEAR = datetime.now().year
TMDB_BASE = "https://api.themoviedb.org/3"
MULTI_WORD_COUNTRIES = (
    "Soviet Union",
    "United States",
    "United Kingdom",
    "South Korea",
    "New Zealand",
    "Hong Kong",
)


def load_api_key(script_dir: Path) -> str:
    env_file = script_dir / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "TMDB_API_KEY":
                return value.strip().strip('"').strip("'")
    return ""


EXPECTED_COUNTRY_ALIASES: dict[str, set[str]] = {
    "China": {"China"},
    "Hong Kong": {"Hong Kong", "China"},
    "Taiwan": {"Taiwan"},
    "Japan": {"Japan"},
    "France": {"France"},
    "Italy": {"Italy"},
    "United States": {"United States"},
    "United Kingdom": {"United Kingdom"},
    "South Korea": {"South Korea"},
    "Soviet Union": {"Soviet Union", "Russia"},
}


def normalize_name(name: str) -> str:
    s = name.lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def expected_director_names(raw: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s*&\s*", raw) if part.strip()]


def director_name_matches(expected: str, candidate: str) -> bool:
    exp_norm = normalize_name(expected)
    cand_norm = normalize_name(candidate)
    if not exp_norm or not cand_norm:
        return False
    if exp_norm == cand_norm or exp_norm in cand_norm or cand_norm in exp_norm:
        return True

    exp_tokens = set(exp_norm.split())
    cand_tokens = set(cand_norm.split())
    if exp_tokens.issubset(cand_tokens) or cand_tokens.issubset(exp_tokens):
        return True
    if len(exp_tokens & cand_tokens) >= 2:
        return True
    if exp_tokens & cand_tokens:
        return True

    exp_parts = exp_norm.split()
    cand_parts = cand_norm.split()
    if exp_parts and cand_parts and exp_parts[-1] == cand_parts[-1]:
        return True
    if exp_parts and cand_parts and exp_parts[0] == cand_parts[0]:
        return True

    exp_compact = exp_norm.replace(" ", "")
    cand_compact = cand_norm.replace(" ", "")
    if exp_compact and cand_compact and sorted(exp_compact) == sorted(cand_compact):
        return True
    return False


def director_matches(expected_raw: str, tmdb_directors: list[str]) -> bool:
    if not tmdb_directors:
        return True
    return any(
        director_name_matches(expected, tmdb_director)
        for expected in expected_director_names(expected_raw)
        for tmdb_director in tmdb_directors
    )


def country_matches(expected: str, production_countries: list[str]) -> bool:
    if not production_countries:
        return True
    allowed = EXPECTED_COUNTRY_ALIASES.get(expected, {expected})
    if any(country in allowed for country in production_countries):
        return True
    asian = {"China", "Hong Kong", "Taiwan", "Japan"}
    if expected in asian or expected in {"France", "Italy", "United States", "United Kingdom", "South Korea"}:
        return any(country in asian for country in production_countries)
    return False


def is_suspect_year(expected: int, actual: int) -> bool:
    if not expected or not actual:
        return False
    return abs(expected - actual) > 2


def parse_meta(line: str) -> tuple[str, str, int]:
    match = re.search(r" (\d{4})$", line)
    if not match:
        raise ValueError(f"Cannot parse year from: {line!r}")
    year = int(match.group(1))
    rest = line[: match.start()]
    for country in MULTI_WORD_COUNTRIES:
        if rest.endswith(country):
            return rest[: -len(country)].strip(), country, year
    director, country = rest.rsplit(" ", 1)
    return director.strip(), country.strip(), year


def parse_list_txt(path: Path) -> list[dict]:
    blocks = re.split(r"\n\n+", path.read_text(encoding="utf-8").strip())
    entries: list[dict] = []

    for block in blocks:
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if len(lines) < 3:
            continue

        if re.match(r"#\s*(\d+)", lines[0]):
            rank = int(re.match(r"#\s*(\d+)", lines[0]).group(1))
            title = lines[1].title()
            director, country, year = parse_meta(lines[2])
            entries.append(
                {
                    "rank": rank,
                    "title": title,
                    "search_title": title,
                    "year": year,
                    "director": director,
                    "country": country,
                    "skip": False,
                }
            )
            continue

        if len(lines) < 4:
            continue

        title = lines[0]
        rank_match = re.match(r"#\s*(\d+)", lines[1])
        rank = int(rank_match.group(1)) if rank_match else 0

        if rank_match is None:
            continue

        skip = False
        if lines[2].lower() == "series":
            search_title = lines[3].title()
            title = search_title
            meta_line = lines[4]
            skip = True
        else:
            search_title = title
            meta_line = lines[3]

        director, country, year = parse_meta(meta_line)
        entries.append(
            {
                "rank": rank,
                "title": title,
                "search_title": search_title,
                "year": year,
                "director": director,
                "country": country,
                "skip": skip,
            }
        )

    return entries


def tmdb_get(url: str, attempt: int = 0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            if resp.status == 429:
                time.sleep(2 * min(attempt + 1, 5))
                return tmdb_get(url, attempt + 1)
            return json.loads(resp.read())
    except Exception:
        return None


def pick_by_year(results: list[dict], year: int, date_key: str) -> list[dict]:
    ranked: list[tuple[int, dict]] = []
    for item in results:
        item_year = int((item.get(date_key) or "0")[:4] or "0")
        if not item_year:
            continue
        distance = abs(item_year - year)
        if distance <= 2:
            ranked.append((distance, item))
    ranked.sort(key=lambda pair: pair[0])
    return [item for _, item in ranked]


def collect_search_results(title: str, year: int, api_key: str) -> list[dict]:
    q = urllib.parse.quote(normalize_search_title(title))
    key = urllib.parse.urlencode({"api_key": api_key, "language": "en-US"})
    seen: set[int] = set()
    ordered: list[dict] = []

    def add_results(results: list[dict] | None) -> None:
        if not results:
            return
        for item in results:
            tmdb_id = item.get("id")
            if not tmdb_id or tmdb_id in seen:
                continue
            seen.add(tmdb_id)
            ordered.append(item)

    data = tmdb_get(f"{TMDB_BASE}/search/movie?query={q}&primary_release_year={year}&{key}")
    add_results(data.get("results") if data else None)

    for offset in (-1, 1, -2, 2):
        alt_year = year + offset
        if alt_year < 1888:
            continue
        data = tmdb_get(
            f"{TMDB_BASE}/search/movie?query={q}&primary_release_year={alt_year}&{key}"
        )
        add_results(data.get("results") if data else None)

    data = tmdb_get(f"{TMDB_BASE}/search/movie?query={q}&{key}")
    add_results(pick_by_year(data.get("results", []) if data else [], year, "release_date"))
    return ordered


def movie_details(tmdb_id: int, api_key: str) -> dict | None:
    key = urllib.parse.urlencode({"api_key": api_key, "language": "en-US"})
    return tmdb_get(f"{TMDB_BASE}/movie/{tmdb_id}?{key}&append_to_response=credits")


def build_movie_result(entry: dict, details: dict, cache_key: str) -> dict:
    directors = [
        c["name"]
        for c in details.get("credits", {}).get("crew", [])
        if c.get("job") == "Director"
    ]
    countries = [c["name"] for c in details.get("production_countries", [])]
    hit_year = int((details.get("release_date") or "0")[:4] or "0")
    return {
        "cache_key": cache_key,
        "tmdbId": details["id"],
        "title": details.get("title") or entry["search_title"],
        "year": hit_year or entry["year"],
        "directors": directors,
        "countries": countries,
    }


def validate_cached_match(entry: dict, cached: dict) -> bool:
    if cached.get("skipped") or cached.get("excluded"):
        return True
    if not cached.get("tmdbId"):
        return False
    if is_suspect_year(entry["year"], cached.get("year") or 0):
        return False
    if not director_matches(entry["director"], cached.get("directors") or []):
        return False
    if not country_matches(entry["country"], cached.get("countries") or []):
        return False
    return True


def normalize_search_title(title: str) -> str:
    return re.sub(r"[,':]+", " ", title).strip()


def cache_key_for(entry: dict) -> str:
    return f"{entry['search_title']}:{entry['year']}"


Override = int | None | str | dict


def apply_override(
    entry: dict, override: Override, api_key: str, cache_key: str
) -> dict | None:
    if override is None:
        return {"cache_key": cache_key, "tmdbId": None, "skipped": True, "reason": "series"}
    if override == "exclude":
        return {"cache_key": cache_key, "excluded": True}

    if isinstance(override, dict):
        if override.get("exclude"):
            return {"cache_key": cache_key, "excluded": True}
        tmdb_id = override["id"]
        output_title = override.get("title")
        output_review = override.get("review")
    else:
        tmdb_id = override
        output_title = None
        output_review = None

    key = urllib.parse.urlencode({"api_key": api_key, "language": "en-US"})
    details = movie_details(tmdb_id, api_key)
    result: dict = {"cache_key": cache_key, "tmdbId": tmdb_id}
    if output_title:
        result["outputTitle"] = output_title
    if output_review:
        result["outputReview"] = output_review
    if details:
        built = build_movie_result(entry, details, cache_key)
        result.update({k: v for k, v in built.items() if k != "cache_key"})
    return result


def lookup_tmdb(entry: dict, api_key: str, overrides: dict[str, Override]) -> dict:
    title = entry["search_title"]
    year = entry["year"]
    cache_key = cache_key_for(entry)

    if entry.get("skip"):
        return {"cache_key": cache_key, "tmdbId": None, "skipped": True, "reason": "series"}

    if cache_key in overrides:
        result = apply_override(entry, overrides[cache_key], api_key, cache_key)
        if result:
            return result

    for hit in collect_search_results(title, year, api_key)[:12]:
        details = movie_details(hit["id"], api_key)
        if not details:
            continue

        directors = [
            c["name"]
            for c in details.get("credits", {}).get("crew", [])
            if c.get("job") == "Director"
        ]
        countries = [c["name"] for c in details.get("production_countries", [])]
        hit_year = int((details.get("release_date") or "0")[:4] or "0")

        if is_suspect_year(year, hit_year):
            continue
        if not director_matches(entry["director"], directors):
            continue
        if not country_matches(entry["country"], countries):
            continue

        return build_movie_result(entry, details, cache_key)

    return {"cache_key": cache_key, "tmdbId": None, "notFound": True, "suspectMatch": True}


def load_overrides(overrides_path: Path) -> dict[str, Override]:
    if not overrides_path.exists():
        return {}
    return json.loads(overrides_path.read_text(encoding="utf-8"))


def paths_for_list(script_dir: Path, in_path: Path) -> tuple[Path, Path, Path]:
    stem = in_path.stem
    out_path = script_dir / f"{stem}_tmdb.csv"
    cache_path = script_dir / f"{stem}-tmdb-cache.json"
    overrides_path = script_dir / f"{stem}-tmdb-overrides.json"
    return out_path, cache_path, overrides_path


def enrich_entries(
    entries: list[dict],
    api_key: str,
    cache_path: Path,
    overrides: dict[str, Override],
) -> dict[str, dict]:
    cache: dict[str, dict] = {}
    if cache_path.exists():
        cache = json.loads(cache_path.read_text(encoding="utf-8"))

    to_fetch = []
    for entry in entries:
        cache_key = cache_key_for(entry)
        if cache_key not in cache:
            to_fetch.append(entry)
        elif entry.get("skip") or cache_key in overrides:
            to_fetch.append(entry)
        elif not validate_cached_match(entry, cache[cache_key]):
            to_fetch.append(entry)

    if not to_fetch:
        return cache

    print(f"Looking up {len(to_fetch)} titles on TMDB...\n")
    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(lookup_tmdb, entry, api_key, overrides): entry for entry in to_fetch
        }
        done = 0
        for future in as_completed(futures):
            entry = futures[future]
            result = future.result()
            cache_key = result["cache_key"]
            results[cache_key] = {k: v for k, v in result.items() if k != "cache_key"}
            done += 1
            status = result.get("tmdbId") or "NOT FOUND"
            print(f"  [{done}/{len(to_fetch)}] #{entry['rank']:>3} {entry['title']} ({entry['year']}) -> {status}")
            time.sleep(0.05)

    cache.update(results)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    return cache


def write_csv(
    entries: list[dict], cache: dict[str, dict], out_path: Path
) -> tuple[int, int, list[dict]]:
    found = 0
    missing = 0
    skipped_series: list[dict] = []

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["tmdbID", "Title", "Year", "Directors", "Review"])

        for entry in entries:
            cache_key = cache_key_for(entry)
            hit = cache.get(cache_key, {})
            if hit.get("excluded"):
                continue

            tmdb_id = hit.get("tmdbId")
            directors = hit.get("directors") or [entry["director"]]
            director_str = ", ".join(directors)
            review = hit.get("outputReview") or f"#{entry['rank']} · {entry['country']}"
            output_title = hit.get("outputTitle") or entry["title"]

            if hit.get("skipped"):
                skipped_series.append(entry)
                writer.writerow(
                    [
                        "",
                        output_title,
                        entry["year"],
                        director_str,
                        review,
                    ]
                )
                continue

            if tmdb_id:
                found += 1
                writer.writerow(
                    [
                        tmdb_id,
                        output_title,
                        entry["year"],
                        director_str,
                        review,
                    ]
                )
            else:
                missing += 1
                note = "no confident movie match" if hit.get("suspectMatch") else "TMDB not found"
                writer.writerow(
                    [
                        "",
                        output_title,
                        entry["year"],
                        director_str,
                        f"{review} · {note}",
                    ]
                )

    return found, missing, skipped_series


def main() -> None:
    script_dir = Path(__file__).parent
    in_path = Path(sys.argv[1]) if len(sys.argv) > 1 else script_dir / "list.txt"
    default_out, cache_path, overrides_path = paths_for_list(script_dir, in_path)
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else default_out

    if not in_path.exists():
        sys.exit(f"File not found: {in_path}")

    api_key = load_api_key(script_dir)
    if not api_key:
        sys.exit("TMDB_API_KEY not found in .env")

    entries = parse_list_txt(in_path)
    print(f"Parsed {len(entries)} entries from {in_path.name}\n")

    overrides = load_overrides(overrides_path)
    cache = enrich_entries(entries, api_key, cache_path, overrides)
    found, missing, skipped_series = write_csv(entries, cache, out_path)

    print(f"\nSaved {out_path} — {found} with tmdbID, {missing} without")
    if missing:
        print(f"Rows without tmdbID can be fixed in {overrides_path.name} and re-running.")
    if skipped_series:
        print(f"\nTV series in CSV without tmdbID ({len(skipped_series)}) — also add to list description:\n")
        for entry in skipped_series:
            print(f"  #{entry['rank']}  {entry['title']} ({entry['year']}) — {entry['director']}")


if __name__ == "__main__":
    main()
