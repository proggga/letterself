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
    # The Last Faust — also logged as "Filme Demência" (original Portuguese title)
    "filme demencia":                               "the last faust",
    "the last faust filme demencia":                "the last faust",
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
    return datetime.min


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

def main(csv_path: str, out_path: str | None = None, top500_path: str | None = None) -> None:
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

    currently_out.sort(key=lambda x: (-parse_date(x[1]).timestamp(), x[0]))

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

    # --- Print ---
    print(f"\nMovies currently OUT of the list ({len(currently_out)} total):\n")
    print(f"  {'#':>3}  {'Year':<6}  {'Date dropped out':<22}  Title")
    print(f"  {'-'*3}  {'-'*6}  {'-'*22}  {'-'*40}")
    for i, (title, date) in enumerate(currently_out, 1):
        year = year_map.get(title, "")
        print(f"  {i:3}.  {year:<6}  {date:<22}  {output_title.get(title, title)}")

    # --- Write CSV ---
    if out_path:
        with open(out_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(["Title", "Year"])
            for title, _ in currently_out:
                writer.writerow([output_title.get(title, title), year_map.get(title, "")])
        print(f"\nSaved to {out_path}")


if __name__ == '__main__':
    parser = ArgumentParser(description='Find movies out of the Letterboxd Top list.')
    parser.add_argument('input_csv', help='Update notes CSV')
    parser.add_argument('output_csv', nargs='?', help='Output CSV file')
    parser.add_argument('--top500', metavar='FILE', help='Current Top 500 export CSV to exclude still-present films')
    args = parser.parse_args()
    main(args.input_csv, args.output_csv, args.top500)
