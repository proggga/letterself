#!/usr/bin/env python3
"""Validate list_tmdb.csv / list2_tmdb.csv against list.txt / list2.txt."""

from __future__ import annotations

import csv
import difflib
import json
import re
from pathlib import Path

from list_to_letterboxd import (
    cache_key_for,
    country_matches,
    director_matches,
    director_name_matches,
    normalize_name,
    parse_list_txt,
    paths_for_list,
)

SCRIPT_DIR = Path(__file__).parent
DIRECTOR_RATIO_OK = 0.72


def name_similarity(a: str, b: str) -> float:
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    if director_name_matches(a, b):
        return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def best_director_similarity(expected: str, csv_directors: str) -> float:
    if not csv_directors.strip():
        return 0.0
    parts = [p.strip() for p in csv_directors.split(",") if p.strip()]
    return max(name_similarity(expected, part) for part in parts)


def review_country(review: str) -> str:
    bits = [b.strip() for b in review.split("·")]
    return bits[-1].split(" · ")[0] if bits else ""


def parse_rank(review: str) -> int | None:
    head = review.split(" · ", 1)[0].strip()
    m = re.match(r"#(\d+)", head)
    return int(m.group(1)) if m else None


def validate_list(list_path: Path) -> dict:
    _, cache_path, overrides_path = paths_for_list(SCRIPT_DIR, list_path)
    csv_path = SCRIPT_DIR / f"{list_path.stem}_tmdb.csv"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    overrides = json.loads(overrides_path.read_text(encoding="utf-8")) if overrides_path.exists() else {}

    csv_rows: dict[int, dict] = {}
    with csv_path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rank = parse_rank(row["Review"])
            if rank is not None:
                csv_rows[rank] = row

    entries = parse_list_txt(list_path)
    results = {
        "name": list_path.name,
        "csv": csv_path.name,
        "total": len(entries),
        "ok": [],
        "director_warn": [],
        "director_fail": [],
        "country_fail": [],
        "no_tmdb": [],
        "excluded": [],
        "missing_csv": [],
    }

    for entry in entries:
        key = cache_key_for(entry)
        if key in overrides and overrides[key] == "exclude":
            results["excluded"].append(entry)
            continue

        row = csv_rows.get(entry["rank"])
        cached = cache.get(key, {})
        if not row:
            results["missing_csv"].append(entry)
            continue

        tmdb_id = row["tmdbID"].strip()
        csv_directors = row["Directors"].strip()
        sim = best_director_similarity(entry["director"], csv_directors)
        tmdb_countries = cached.get("countries") or []
        country_ok = country_matches(entry["country"], tmdb_countries) if tmdb_countries else True

        item = {
            "rank": entry["rank"],
            "title": entry["title"],
            "year": entry["year"],
            "expected_director": entry["director"],
            "csv_director": csv_directors,
            "director_sim": round(sim, 2),
            "expected_country": entry["country"],
            "tmdb_countries": ", ".join(tmdb_countries) if tmdb_countries else "?",
            "tmdb_id": tmdb_id or None,
        }

        if not tmdb_id:
            results["no_tmdb"].append(item)
            continue

        director_ok = director_matches(entry["director"], [d.strip() for d in csv_directors.split(",")])
        if not director_ok and sim < DIRECTOR_RATIO_OK:
            results["director_fail"].append(item)
        elif not director_ok:
            results["director_warn"].append(item)

        if not country_ok:
            results["country_fail"].append(item)

        if director_ok and country_ok:
            results["ok"].append(item)

    return results


def print_report(results: dict) -> None:
    total = results["total"]
    matched = total - len(results["excluded"]) - len(results["missing_csv"])
    ok = len(results["ok"])
    print(f"\n{'=' * 60}")
    print(f"{results['name']} → {results['csv']}")
    print(f"{'=' * 60}")
    print(f"Entries in list:     {total}")
    print(f"In CSV:              {matched}")
    print(f"Excluded from CSV:   {len(results['excluded'])}")
    print(f"Director+country OK: {ok} / {matched - len(results['no_tmdb'])} with tmdbID")
    print(f"Director FAIL:       {len(results['director_fail'])}")
    print(f"Director WARN:       {len(results['director_warn'])}  (fuzzy ok, strict fail)")
    print(f"Country FAIL:        {len(results['country_fail'])}")
    print(f"No tmdbID:           {len(results['no_tmdb'])}")
    if results["missing_csv"]:
        print(f"Missing from CSV:    {len(results['missing_csv'])}")

    if results["director_fail"]:
        print("\nDirector mismatches (likely wrong film):")
        for x in sorted(results["director_fail"], key=lambda i: i["rank"]):
            print(
                f"  #{x['rank']:>3} {x['title']} ({x['year']})  "
                f"list: {x['expected_director']}  csv: {x['csv_director']}  sim={x['director_sim']}"
            )

    if results["country_fail"]:
        print("\nCountry mismatches:")
        for x in sorted(results["country_fail"], key=lambda i: i["rank"]):
            print(
                f"  #{x['rank']:>3} {x['title']} ({x['year']})  "
                f"list: {x['expected_country']}  tmdb: {x['tmdb_countries']}  id={x['tmdb_id']}"
            )

    if results["no_tmdb"]:
        print("\nNo tmdbID:")
        for x in sorted(results["no_tmdb"], key=lambda i: i["rank"]):
            print(f"  #{x['rank']:>3} {x['title']} ({x['year']}) — {x['expected_director']}, {x['expected_country']}")


def main() -> None:
    for list_name in ("list.txt", "list2.txt"):
        path = SCRIPT_DIR / list_name
        if path.exists():
            print_report(validate_list(path))


if __name__ == "__main__":
    main()
