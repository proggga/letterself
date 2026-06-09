from datetime import datetime
from collections import defaultdict
import math

LANG_NAMES = {
    "en": "English", "fr": "French", "ko": "Korean", "ja": "Japanese",
    "it": "Italian", "de": "German", "es": "Spanish", "zh": "Mandarin",
    "pt": "Portuguese", "ru": "Russian", "hi": "Hindi", "sv": "Swedish",
    "da": "Danish", "nl": "Dutch", "pl": "Polish", "no": "Norwegian",
    "tr": "Turkish", "ar": "Arabic", "th": "Thai", "fi": "Finnish",
    "hu": "Hungarian", "cs": "Czech", "ro": "Romanian", "id": "Indonesian",
    "uk": "Ukrainian", "fa": "Persian", "el": "Greek", "he": "Hebrew",
    "bn": "Bengali", "ta": "Tamil", "te": "Telugu", "vi": "Vietnamese",
}


def compute_analytics(watchlist: list[dict], ratings: list[dict],
                      diary: list[dict], watched: list[dict],
                      tmdb_cache: dict) -> dict:
    """Compute all analytics from parsed CSVs and TMDB cache."""

    # Build rated movies with TMDB data
    rated_movies = []
    for r in ratings:
        uri = r.get("Letterboxd URI", "")
        c = tmdb_cache.get(uri) or {}
        rated_movies.append({
            "name": r.get("Name", ""),
            "year": _int(r.get("Year", 0)),
            "myRating": _float(r.get("Rating", 0)),
            "uri": uri,
            "tmdbId": c.get("tmdbId"),
            "runtime": c.get("runtime"),
            "voteAverage": c.get("voteAverage"),
            "voteCount": c.get("voteCount"),
            "genres": c.get("genres", []),
            "countries": c.get("countries", []),
            "language": c.get("language"),
            "posterPath": c.get("posterPath"),
            "directors": c.get("directors", []),
            "enriched": bool(c.get("tmdbId")),
        })

    all_rated = [m for m in rated_movies if m["myRating"] > 0]
    E = [m for m in rated_movies if m["enriched"] and m["myRating"] > 0]

    # Overview
    with_runtime = [m for m in E if m["runtime"]]
    known_minutes = sum(m["runtime"] for m in with_runtime)
    avg_runtime = known_minutes / len(with_runtime) if with_runtime else 100
    total_minutes = sum(m["runtime"] or avg_runtime for m in all_rated)
    avg_rating = round(sum(m["myRating"] for m in all_rated) / len(all_rated) * 10) / 10 if all_rated else 0
    enriched_pct = round(len(with_runtime) / len(all_rated) * 100) if all_rated else 0

    rating_dist = {}
    r = 0.5
    while r <= 5.0:
        rating_dist[str(round(r, 1))] = 0
        r += 0.5
    for m in rated_movies:
        k = str(round(m["myRating"], 1))
        if k in rating_dist:
            rating_dist[k] += 1

    overview = {
        "total": len(all_rated),
        "enriched": len(with_runtime),
        "enrichedPct": enriched_pct,
        "avgRating": avg_rating,
        "totalRuntimeHours": round(total_minutes / 60),
        "ratingDist": [{"rating": float(k), "count": v} for k, v in rating_dist.items()],
    }

    # Decades
    dec_map = defaultdict(lambda: {"count": 0, "mySum": 0, "tmdbSum": 0, "tmdbN": 0})
    for m in all_rated:
        if not m["year"] or m["year"] < 1880:
            continue
        d = (m["year"] // 10) * 10
        dec_map[d]["count"] += 1
        dec_map[d]["mySum"] += m["myRating"]
        if m["voteAverage"]:
            dec_map[d]["tmdbSum"] += m["voteAverage"]
            dec_map[d]["tmdbN"] += 1
    decades = sorted([
        {
            "decade": d, "label": f"{d}s", "count": v["count"],
            "avgMyRating": round(v["mySum"] / v["count"] * 10) / 10,
            "avgTmdb": round(v["tmdbSum"] / v["tmdbN"] * 10) / 10 if v["tmdbN"] else None,
        }
        for d, v in dec_map.items()
    ], key=lambda x: x["decade"])

    # Genres (top 15)
    g_map = defaultdict(lambda: {"count": 0, "sum": 0})
    for m in E:
        for g in m["genres"]:
            g_map[g]["count"] += 1
            g_map[g]["sum"] += m["myRating"]
    genres = sorted([
        {"name": name, "count": v["count"], "avgRating": round(v["sum"] / v["count"] * 10) / 10}
        for name, v in g_map.items()
    ], key=lambda x: -x["count"])[:15]

    # Countries (top 15)
    c_map = defaultdict(int)
    for m in E:
        for c in m["countries"]:
            c_map[c] += 1
    countries = sorted([{"name": n, "count": c} for n, c in c_map.items()], key=lambda x: -x["count"])[:15]

    # Languages (top 12)
    l_map = defaultdict(int)
    for m in E:
        if m["language"]:
            l_map[m["language"]] += 1
    languages = sorted([
        {"code": code, "name": LANG_NAMES.get(code, code.upper()), "count": count}
        for code, count in l_map.items()
    ], key=lambda x: -x["count"])[:12]

    # Divergence (You vs Crowd)
    divergence_list = []
    for m in E:
        if m["voteAverage"] and (m["voteCount"] or 0) >= 500:
            diff = round((m["myRating"] - m["voteAverage"] / 2) * 10) / 10
            divergence_list.append({
                "name": m["name"], "year": m["year"], "posterPath": m["posterPath"],
                "tmdbId": m["tmdbId"], "myRating": m["myRating"],
                "tmdb": m["voteAverage"], "diff": diff,
            })
    divergence_list.sort(key=lambda x: -x["diff"])
    hidden_gems = [m for m in divergence_list if m["diff"] >= 1.0][:12]
    overrated = sorted([m for m in divergence_list if m["diff"] <= -1.0], key=lambda x: x["diff"])[:12]

    # Watching pace (from diary, last 24 months)
    pace_map = defaultdict(int)
    for e in diary:
        date = e.get("Watched Date") or e.get("Date", "")
        if not date:
            continue
        ym = date[:7]
        pace_map[ym] += 1
    pace = sorted([{"month": k, "count": v} for k, v in pace_map.items()], key=lambda x: x["month"])[-24:]

    # Seasonal watching (avg per month, exclude current incomplete month)
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    season_map = [0] * 12
    season_years = [set() for _ in range(12)]
    now_year = str(datetime.now().year)
    now_month = datetime.now().month - 1
    for e in diary:
        date = e.get("Watched Date") or e.get("Date", "")
        if not date or len(date) < 7:
            continue
        mo = int(date[5:7]) - 1
        yr = date[:4]
        if 0 <= mo < 12:
            if yr == now_year and mo == now_month:
                continue
            season_map[mo] += 1
            season_years[mo].add(yr)
    seasonal = [
        {"name": month_names[i], "count": round(season_map[i] / max(len(season_years[i]), 1) * 10) / 10}
        for i in range(12)
    ]

    # Rewatches
    rewatch_map = defaultdict(int)
    for e in diary:
        if (e.get("Rewatch") or "").lower() == "yes":
            rewatch_map[e.get("Name", "")] += 1
    total_rewatches = sum(rewatch_map.values())

    # Build name→rating lookup
    name_to_rating = {}
    for r in ratings:
        name_to_rating[r.get("Name", "")] = _float(r.get("Rating", 0))

    rewatches = sorted([
        {
            "name": name, "count": count + 1,
            "myRating": name_to_rating.get(name, 0),
            "posterPath": tmdb_cache.get(
                next((r.get("Letterboxd URI", "") for r in ratings if r.get("Name") == name), ""), {}
            ).get("posterPath"),
        }
        for name, count in rewatch_map.items() if count >= 2
    ], key=lambda x: (-x["count"], -x["myRating"]))

    # Film length buckets
    length_buckets = [
        {"label": "Short", "sublabel": "< 80 min", "count": 0},
        {"label": "Standard", "sublabel": "80–110 min", "count": 0},
        {"label": "Feature", "sublabel": "110–140 min", "count": 0},
        {"label": "Long", "sublabel": "140–180 min", "count": 0},
        {"label": "Epic", "sublabel": "180+ min", "count": 0},
    ]
    for m in with_runtime:
        rt = m["runtime"]
        if rt < 80:
            length_buckets[0]["count"] += 1
        elif rt < 110:
            length_buckets[1]["count"] += 1
        elif rt < 140:
            length_buckets[2]["count"] += 1
        elif rt < 180:
            length_buckets[3]["count"] += 1
        else:
            length_buckets[4]["count"] += 1

    # Popularity tiers (TMDB scale)
    tiers = [
        {"label": "Hidden gem", "sublabel": "< 500 votes", "count": 0},
        {"label": "Arthouse", "sublabel": "500 – 2K", "count": 0},
        {"label": "Mid-range", "sublabel": "2K – 8K", "count": 0},
        {"label": "Popular", "sublabel": "8K – 20K", "count": 0},
        {"label": "Blockbuster", "sublabel": "20K+", "count": 0},
    ]
    for m in E:
        v = m["voteCount"] or 0
        if v < 500:
            tiers[0]["count"] += 1
        elif v < 2000:
            tiers[1]["count"] += 1
        elif v < 8000:
            tiers[2]["count"] += 1
        elif v < 20000:
            tiers[3]["count"] += 1
        else:
            tiers[4]["count"] += 1

    # Watchlist ETA
    watched_uris = set(w.get("Letterboxd URI", "") for w in watched)
    remaining = [w for w in watchlist if w.get("Letterboxd URI", "") not in watched_uris]
    remaining_with_rt = [tmdb_cache.get(w.get("Letterboxd URI", ""), {}).get("runtime") for w in remaining]
    remaining_with_rt = [r for r in remaining_with_rt if r]
    avg_rt = sum(remaining_with_rt) / len(remaining_with_rt) if remaining_with_rt else 105
    watchlist_hours_left = round(len(remaining) * avg_rt * 0.88 / 60)

    cutoff_3m = datetime.now().timestamp() - 91 * 86400
    cutoff_3m_str = datetime.fromtimestamp(cutoff_3m).strftime("%Y-%m-%d")
    recent_3m = sum(1 for e in diary if (e.get("Watched Date") or e.get("Date", "")) >= cutoff_3m_str)
    monthly_pace = recent_3m / 3
    eta_months = round(len(remaining) / monthly_pace * 10) / 10 if monthly_pace > 0 else None

    watchlist_eta = {
        "remaining": len(remaining),
        "hoursLeft": watchlist_hours_left,
        "monthlyPace": round(monthly_pace * 10) / 10,
        "etaMonths": eta_months,
    }

    # Taste profile
    genre_map = defaultdict(lambda: {"sum": 0, "count": 0})
    decade_map = defaultdict(lambda: {"sum": 0, "count": 0})
    for m in rated_movies:
        if not m["enriched"]:
            continue
        rating = m["myRating"]
        if not rating:
            continue
        for g in m["genres"]:
            genre_map[g]["sum"] += rating
            genre_map[g]["count"] += 1
        decade = (m["year"] // 10) * 10 if m["year"] else 0
        if decade:
            decade_map[decade]["sum"] += rating
            decade_map[decade]["count"] += 1

    top_genres = sorted([
        {"genre": g, "score": round(v["sum"] / v["count"] * 10) / 10}
        for g, v in genre_map.items() if v["count"] >= 3
    ], key=lambda x: -x["score"])[:5]
    top_decades = sorted([
        {"decade": d, "score": round(v["sum"] / v["count"] * 10) / 10}
        for d, v in decade_map.items() if v["count"] >= 3
    ], key=lambda x: -x["score"])[:5]

    # Cinephile DNA Radar Chart
    total_e = len(E) or 1
    unique_countries = set()
    for m in E:
        for c in m["countries"]:
            unique_countries.add(c)
    explorer_score = min(100, round(len(unique_countries) / 80 * 100))

    indie_count = sum(1 for m in E if (m["voteCount"] or 0) < 10000)
    indie_score = round(indie_count / total_e * 100)

    with_crowd = [m for m in E if m["voteAverage"] and (m["voteCount"] or 0) >= 100]
    avg_divergence = sum(m["voteAverage"] / 2 - m["myRating"] for m in with_crowd) / len(with_crowd) if with_crowd else 0
    critic_score = min(100, max(0, round(50 + avg_divergence * 25)))

    binger_score = min(100, round(monthly_pace / 60 * 100))

    retro_count = sum(1 for m in all_rated if m["year"] and m["year"] < 2000)
    retro_score = min(100, round(retro_count / (len(all_rated) or 1) * 130))

    # Loyalist
    rewatch_rate = sum(rewatch_map.values()) / len(diary) if diary else 0
    dir_count_map = defaultdict(int)
    for m in E:
        for d in m["directors"]:
            dir_count_map[d] += 1
    top_dir_share = sum(sorted(dir_count_map.values(), reverse=True)[:3]) / total_e if dir_count_map else 0
    loyalist_score = min(100, round((rewatch_rate * 200 + top_dir_share * 200) / 2))

    radar_chart = [
        {"axis": "Explorer", "value": explorer_score, "description": f"{len(unique_countries)} countries"},
        {"axis": "Indie", "value": indie_score, "description": f"{indie_count} films < 10K votes"},
        {"axis": "Critic", "value": critic_score,
         "description": f"{abs(avg_divergence):.1f}★ {'harsher' if avg_divergence > 0 else 'gentler'} than crowd"},
        {"axis": "Binger", "value": binger_score, "description": f"{round(monthly_pace * 10) / 10} movies/month"},
        {"axis": "Retro", "value": retro_score, "description": f"{retro_count} pre-2000 films"},
        {"axis": "Loyalist", "value": loyalist_score, "description": f"{total_rewatches} rewatches"},
    ]

    # Director Spotlight (top 10)
    dir_films = defaultdict(list)
    for m in E:
        for d in m["directors"]:
            dir_films[d].append({"name": m["name"], "year": m["year"], "myRating": m["myRating"], "posterPath": m["posterPath"]})
    director_spotlight = sorted([
        {
            "name": name,
            "count": len(films),
            "avgRating": round(sum(f["myRating"] for f in films) / len(films) * 10) / 10,
            "best": max(films, key=lambda f: f["myRating"]),
            "worst": min(films, key=lambda f: f["myRating"]),
        }
        for name, films in dir_films.items() if len(films) >= 2
    ], key=lambda x: -x["count"])[:10]

    # Rating Evolution (quarterly)
    quarter_map = defaultdict(lambda: {"sum": 0, "count": 0})
    for e in diary:
        date = e.get("Watched Date") or e.get("Date", "")
        rating = _float(e.get("Rating", 0))
        if not date or not rating:
            continue
        y = date[:4]
        q = math.ceil(int(date[5:7]) / 3)
        key = f"{y}-Q{q}"
        quarter_map[key]["sum"] += rating
        quarter_map[key]["count"] += 1
    rating_evolution = sorted([
        {"quarter": k, "avg": round(v["sum"] / v["count"] * 100) / 100, "count": v["count"]}
        for k, v in quarter_map.items()
    ], key=lambda x: x["quarter"])[-16:]

    # Genre × Decade Heatmap
    gd_map = {}
    heat_genres = set()
    heat_decades = set()
    for m in E:
        decade = (m["year"] // 10) * 10 if m["year"] else 0
        if not decade:
            continue
        for g in m["genres"]:
            key = f"{g}|{decade}"
            if key not in gd_map:
                gd_map[key] = {"sum": 0, "count": 0}
            gd_map[key]["sum"] += m["myRating"]
            gd_map[key]["count"] += 1
            heat_genres.add(g)
            heat_decades.add(decade)

    # Top 8 genres with >= 5 movies
    genre_totals = defaultdict(int)
    for key, v in gd_map.items():
        g = key.split("|")[0]
        genre_totals[g] += v["count"]
    top_heat_genres = sorted(
        [g for g in heat_genres if genre_totals[g] >= 5],
        key=lambda g: -genre_totals[g]
    )[:8]
    sorted_heat_decades = sorted(heat_decades)

    cells = []
    for g in top_heat_genres:
        row = []
        for d in sorted_heat_decades:
            cell = gd_map.get(f"{g}|{d}")
            if cell:
                row.append({"avg": round(cell["sum"] / cell["count"] * 10) / 10, "count": cell["count"]})
            else:
                row.append(None)
        cells.append(row)

    genre_decade_heatmap = {
        "genres": top_heat_genres,
        "decades": sorted_heat_decades,
        "cells": cells,
    }

    return {
        "overview": overview,
        "diaryTotal": len(diary),
        "totalRewatches": total_rewatches,
        "rewatches": rewatches,
        "watchlistEta": watchlist_eta,
        "decades": decades,
        "genres": genres,
        "countries": countries,
        "languages": languages,
        "divergence": {"hiddenGems": hidden_gems, "overrated": overrated},
        "pace": pace,
        "seasonal": seasonal,
        "popularityTiers": tiers,
        "lengthBuckets": length_buckets,
        "tasteProfile": {"topGenres": top_genres, "topDecades": top_decades},
        "radarChart": radar_chart,
        "directorSpotlight": director_spotlight,
        "ratingEvolution": rating_evolution,
        "genreDecadeHeatmap": genre_decade_heatmap,
    }


def _int(v) -> int:
    try:
        return int(v)
    except (ValueError, TypeError):
        return 0


def _float(v) -> float:
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0
