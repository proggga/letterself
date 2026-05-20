#!/usr/bin/env python3
"""
letterboxd_out.py — find movies currently out of the Letterboxd Top list.

Usage:
    python3 letterboxd_out.py <input.csv>
    python3 letterboxd_out.py <input.csv> <output.csv>
    python3 letterboxd_out.py <input.csv> <output.csv> --top500 <export.csv>

Reads TMDB_API_KEY from .env in the same directory as this script.
Years are fetched from TMDB and cached in tmdb-title-cache.json.
Manual title/year corrections live in tmdb-title-overrides.json.
--top500: current Letterboxd Top 500 export; films still present there are excluded.
"""

import csv
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path


# ---------------------------------------------------------------------------
# Title aliases: maps a normalized variant → normalized canonical key.
# Add entries here whenever the same film appears under different spellings.
# ---------------------------------------------------------------------------
ALIASES: dict[str, str] = {
    # La Commune (Paris, 1871) — short title used for IN, full title for OUT
    "la commune":                                   "la commune paris 1871",
    # São Paulo, Sociedade Anônima — three different title translations in the log
    "sao paulo sa":                                 "sao paulo sociedade anonima",
    "sao paulo s a":                                "sao paulo sociedade anonima",
    "sao paulo the anonymous society":              "sao paulo sociedade anonima",
    # The Last Faust — alternate title form
    "the last faust filme demencia":                "the last faust",
    # Filme Demência = Movie Dementia (same film, different language title)
    "filme demencia":                               "movie dementia",
    # Neon Genesis Evangelion: The End of Evangelion — abbreviated on one entry
    "neon genesis evangelion eoe":                  "neon genesis evangelion the end of evangelion",
    # Typo in the spreadsheet: "One Upon" instead of "Once Upon"
    "one upon a time in anatolia":                  "once upon a time in anatolia",
}

# Preferred display name for each canonical key (overrides first-seen title).
CANONICAL_DISPLAY: dict[str, str] = {
    "la commune paris 1871":                                "La Commune (Paris, 1871)",
    "sao paulo sociedade anonima":                          "São Paulo, Sociedade Anônima",
    "the last faust":                                       "The Last Faust",
    "neon genesis evangelion the end of evangelion":        "Neon Genesis Evangelion: The End of Evangelion",
    "once upon a time in anatolia":                         "Once Upon a Time in Anatolia",
    "movie dementia":                                       "Movie Dementia",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def clean_title(raw: str) -> str:
    title = raw.strip()
    title = re.sub(r'\s+(at|was|from)\s+#?\s*\d+\s*$', '', title, flags=re.IGNORECASE)
    return title.strip().strip(',').strip()


def normalize(title: str) -> str:
    s = title.lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-z0-9 ]', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def canonical_key(title: str) -> str:
    key = normalize(title)
    return ALIASES.get(key, key)


def parse_cell(cell: str) -> list[str]:
    titles = []
    for line in cell.split('\n'):
        t = clean_title(line)
        if t:
            titles.append(t)
    return titles


def parse_date(s: str) -> datetime:
    for fmt in ("%B %d, %Y", "%B %Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return datetime(1, 1, 1)


# ---------------------------------------------------------------------------
# TMDB
# ---------------------------------------------------------------------------

def load_env(script_dir: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    env_file = script_dir / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def tmdb_search_year(title: str, api_key: str) -> str:
    """Return the 4-digit release year string from TMDB, or '' if not found."""
    url = (
        "https://api.themoviedb.org/3/search/movie?"
        + urllib.parse.urlencode({"api_key": api_key, "query": title})
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if results:
            date = results[0].get("release_date", "")
            return date[:4] if date else ""
    except Exception:
        pass
    return ""


def fetch_years(titles: list[str], api_key: str, cache_path: Path) -> dict[str, str]:
    """Return title → year dict, fetching missing titles concurrently."""
    cache: dict[str, str] = {}
    if cache_path.exists():
        cache = json.loads(cache_path.read_text(encoding="utf-8"))

    missing = [t for t in titles if t not in cache]
    if not missing:
        return cache

    results: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(tmdb_search_year, t, api_key): t for t in missing}
        done = 0
        for future in as_completed(futures):
            title = futures[future]
            year = future.result()
            results[title] = year
            done += 1
            print(f"  [{done}/{len(missing)}] {title} → {year or '?'}")

    cache.update(results)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    return cache


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(csv_path: str, out_path: str | None = None, top500_path: str | None = None, kicks_path: str | None = None, min_kicks: int = 4) -> None:
    path = Path(csv_path)
    if not path.exists():
        sys.exit(f"File not found: {csv_path}")

    with open(path, 'r', encoding='utf-8') as f:
        rows = list(csv.reader(f))

    data_rows = [r for r in rows[1:] if len(r) >= 3 and r[0].strip()]
    data_rows.reverse()  # process oldest → newest

    display:  dict[str, str] = {}
    state:    dict[str, str] = {}
    out_date: dict[str, str] = {}
    out_count: dict[str, int] = {}

    for row in data_rows:
        date = row[0].strip()
        for title in parse_cell(row[1]):
            key = canonical_key(title)
            state[key] = 'in'
            if key not in display:
                display[key] = CANONICAL_DISPLAY.get(key, title)
        for title in parse_cell(row[2]):
            key = canonical_key(title)
            state[key] = 'out'
            out_date[key] = date
            out_count[key] = out_count.get(key, 0) + 1
            if key not in display:
                display[key] = CANONICAL_DISPLAY.get(key, title)

    # --- Filter against live Top 500 export ---
    top500_keys: set[str] = set()
    script_dir = Path(__file__).parent
    if top500_path is None:
        exports = sorted(script_dir.glob("*export*.csv"))
        if exports:
            top500_path = str(exports[-1])
            print(f"Auto-detected Top 500 export: {exports[-1].name}\n")
    if top500_path:
        p500 = Path(top500_path)
        if not p500.exists():
            sys.exit(f"File not found: {top500_path}")
        with open(p500, encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                top500_keys.add(canonical_key(row['Title']))

    all_out = [(display[k], out_date.get(k, "")) for k, s in state.items() if s == 'out']
    if top500_keys:
        still_in = [t for t, _ in all_out if canonical_key(t) in top500_keys]
        currently_out = [(t, d) for t, d in all_out if canonical_key(t) not in top500_keys]
        if still_in:
            print(f"Excluded {len(still_in)} film(s) still present in Top 500: {', '.join(still_in)}\n")
    else:
        currently_out = all_out

    # Movies that were on the list during the top-250 era but disappeared
    # somewhere in the top-250 → top-500 transition without being logged.
    UNLOGGED_REMOVALS = {
        "Annie Hall": "1977",
        "Badlands": "1973",
        "Brazil": "1985",
        "Creed": "2015",
        "Drive": "2011",
        "Dunkirk": "2017",
        "Guardians of the Galaxy": "2014",
        "Harold and Maude": "1971",
        "Manchester by the Sea": "2016",
        "Out of the Past": "1947",
        "Spotlight": "2015",
        "The Earrings of Madame de...": "1953",
        "Toy Story 3": "2010",
        "Up": "2009",
    }
    for title, year in UNLOGGED_REMOVALS.items():
        key = canonical_key(title)
        if state.get(key) != 'out':
            state[key] = 'out'
            out_date[key] = "February 23, 2026"
            if key not in display:
                display[key] = title
            currently_out.append((title, "February 23, 2026"))

    # --- TMDB year lookup ---
    env = load_env(script_dir)
    api_key = env.get("TMDB_API_KEY", "")
    year_map: dict[str, str] = {}

    if api_key:
        cache_path = script_dir / "tmdb-title-cache.json"
        existing = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
        titles_needed = [title for title, _ in currently_out]
        new_count = sum(1 for t in titles_needed if t not in existing)
        if new_count:
            print(f"Fetching years from TMDB for {new_count} new titles...\n")
        year_map = fetch_years(titles_needed, api_key, cache_path)
    else:
        print("Warning: TMDB_API_KEY not found in .env — Year column will be empty.\n")

    # --- Manual overrides (title and/or year) ---
    # Format: { "Input Title": { "title": "Output Title", "year": "YYYY" } }
    output_title: dict[str, str] = {}  # display title → overridden output title
    overrides_path = script_dir / "tmdb-title-overrides.json"
    if overrides_path.exists():
        for input_title, override in json.loads(overrides_path.read_text(encoding="utf-8")).items():
            if "year" in override:
                year_map[input_title] = override["year"]
            if "title" in override:
                output_title[input_title] = override["title"]

    # Inject years for unlogged removals
    for title, year in UNLOGGED_REMOVALS.items():
        year_map[title] = year

    currently_out.sort(key=lambda x: (-parse_date(x[1]).toordinal(), -(int(year_map.get(x[0], "0") or "0"))))

    # --- Print ---
    print(f"\nMovies currently OUT of the list ({len(currently_out)} total):\n")
    print(f"  {'#':>3}  {'Year':<6}  {'Date dropped out':<22}  Title")
    print(f"  {'-'*3}  {'-'*6}  {'-'*22}  {'-'*40}")
    for i, (title, date) in enumerate(currently_out, 1):
        year = year_map.get(title, "")
        print(f"  {i:3}.  {year:<6}  {date:<22}  {output_title.get(title, title)}")

    # --- Write CSV ---
    if out_path:
        unlogged_keys = {canonical_key(t) for t in UNLOGGED_REMOVALS}
        with open(out_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(["Title", "Year", "Review"])
            for title, date in currently_out:
                key = canonical_key(title)
                count = out_count.get(key, 0)
                if key in unlogged_keys:
                    review = "removal not logged; likely dropped during the 250-to-500 expansion (Feb 23, 2026)"
                elif count > 1:
                    review = f"was kicked out {date} (kicked {count} times total)"
                else:
                    review = f"was kicked out {date}" if date else ""
                writer.writerow([output_title.get(title, title), year_map.get(title, ""), review])
        print(f"\nSaved to {out_path}")

    # --- Most kicked movies ---
    if kicks_path:
        kicked_many = []
        for key, count in out_count.items():
            if count >= min_kicks:
                title = display.get(key, key)
                year = year_map.get(title, "")
                in_top500 = key in top500_keys if top500_keys else None
                kicked_many.append((title, year, count, in_top500))
        kicked_many.sort(key=lambda x: (-x[2], x[0]))

        print(f"\nMovies kicked {min_kicks}+ times ({len(kicked_many)} total):\n")
        print(f"  {'#':>3}  {'Year':<6}  {'Kicks':<6}  {'Status':<8}  Title")
        print(f"  {'-'*3}  {'-'*6}  {'-'*6}  {'-'*8}  {'-'*40}")
        for i, (title, year, count, in500) in enumerate(kicked_many, 1):
            status = "in" if in500 else "out"
            print(f"  {i:3}.  {year:<6}  {count:<6}  {status:<8}  {output_title.get(title, title)}")

        with open(kicks_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(["Title", "Year", "Review"])
            for title, year, count, in500 in kicked_many:
                key = canonical_key(title)
                last_date = out_date.get(key, "")
                if in500:
                    review = f"was kicked {count} times (survived)"
                else:
                    review = f"was kicked {count} times (kicked on {last_date})"
                writer.writerow([output_title.get(title, title), year, review])
        print(f"\nSaved to {kicks_path}")


if __name__ == '__main__':
    parser = ArgumentParser(description='Find movies out of the Letterboxd Top list.')
    parser.add_argument('input_csv', help='Update notes CSV')
    parser.add_argument('output_csv', nargs='?', help='Output CSV file')
    parser.add_argument('--top500', metavar='FILE', help='Current Top 500 export CSV to exclude still-present films')
    parser.add_argument('--kicks', metavar='FILE', help='Output CSV for movies kicked N+ times (use --min-kicks to set threshold)')
    parser.add_argument('--min-kicks', type=int, default=4, metavar='N', help='Minimum kick count for --kicks output (default: 4)')
    args = parser.parse_args()
    main(args.input_csv, args.output_csv, args.top500, args.kicks, args.min_kicks)
