import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
import zipfile
import io
import asyncio
from analytics import compute_analytics
from tmdb import TMDBEnricher

st.set_page_config(page_title="Letterboxd Stats", page_icon="🎬", layout="wide")

st.markdown("""
<style>
    .block-container { padding-top: 2rem; }
    .metric-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 12px; padding: 16px 20px; text-align: center; }
    .metric-value { font-size: 1.8rem; font-weight: 800; color: #f5c842; }
    .metric-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.06em; }
    .director-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
    .gem-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 10px; margin-bottom: 6px; }
</style>
""", unsafe_allow_html=True)


def parse_zip(uploaded_file) -> dict:
    """Parse a Letterboxd ZIP export into DataFrames."""
    csvs = {}
    with zipfile.ZipFile(io.BytesIO(uploaded_file.read())) as zf:
        for name in zf.namelist():
            if name.endswith(".csv"):
                base = name.split("/")[-1].replace(".csv", "")
                csvs[base] = pd.read_csv(zf.open(name)).fillna("")
    return csvs


def df_to_dicts(df: pd.DataFrame) -> list[dict]:
    return df.to_dict("records")


def render_metric(label: str, value: str):
    st.markdown(f"""
    <div class="metric-card">
        <div class="metric-value">{value}</div>
        <div class="metric-label">{label}</div>
    </div>""", unsafe_allow_html=True)


def render_overview(data: dict):
    st.subheader("Overview")
    ov = data["overview"]
    cols = st.columns(6)
    metrics = [
        ("Movies rated", f"{ov['total']:,}"),
        ("Diary entries", f"{data['diaryTotal']:,}"),
        ("Avg rating", f"★ {ov['avgRating']}"),
        ("Watch time", f"{ov['totalRuntimeHours']:,}h"),
        ("Days watched", str(round(ov['totalRuntimeHours'] / 24))),
        ("Rewatches", str(data["totalRewatches"])),
    ]
    for col, (label, value) in zip(cols, metrics):
        with col:
            render_metric(label, value)


def render_rating_distribution(data: dict):
    dist = data["overview"]["ratingDist"]
    df = pd.DataFrame(dist)
    fig = px.bar(df, x="rating", y="count", color_discrete_sequence=["#f5c842"],
                 labels={"rating": "Rating", "count": "Movies"})
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=250, margin=dict(t=30, b=30))
    fig.update_xaxes(dtick=0.5)
    st.plotly_chart(fig, use_container_width=True)


def render_watchlist_eta(data: dict):
    eta = data["watchlistEta"]
    if not eta:
        return
    st.subheader("Watchlist Countdown")
    cols = st.columns(4)
    total_months = eta["etaMonths"]
    if total_months:
        y = int(total_months // 12)
        m = int(total_months % 12)
        eta_str = f"~{y}y {m}m" if y > 0 else f"~{m}m"
    else:
        eta_str = "—"
    items = [
        ("Movies left", f"{eta['remaining']:,}"),
        ("Hours remaining", f"{eta['hoursLeft']:,}h"),
        ("Your pace", f"{eta['monthlyPace']}/mo"),
        ("Time to finish", eta_str),
    ]
    for col, (label, value) in zip(cols, items):
        with col:
            render_metric(label, value)


def render_pace(data: dict):
    st.subheader("Watching Pace — Last 24 Months")
    pace = data["pace"]
    if not pace:
        st.info("No diary data found")
        return
    df = pd.DataFrame(pace)
    fig = px.bar(df, x="month", y="count", color_discrete_sequence=["#f5c842"],
                 labels={"month": "", "count": "Movies"})
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=280, margin=dict(t=10, b=30))
    st.plotly_chart(fig, use_container_width=True)


def render_seasonal(data: dict):
    st.subheader("Seasonal Watching — Avg Movies per Month")
    seasonal = data["seasonal"]
    df = pd.DataFrame(seasonal)
    fig = px.bar(df, x="name", y="count", color_discrete_sequence=["#6366f1"],
                 labels={"name": "", "count": "Avg movies"})
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=250, margin=dict(t=10, b=30))
    st.plotly_chart(fig, use_container_width=True)


def render_decades(data: dict):
    st.subheader("By Decade")
    decades = data["decades"]
    df = pd.DataFrame(decades)
    fig = go.Figure()
    fig.add_trace(go.Bar(x=df["label"], y=df["count"], name="Your films",
                         marker_color=df["avgMyRating"].apply(rating_color),
                         hovertemplate="%{x}: %{y} films, ★%{customdata:.1f}<extra></extra>",
                         customdata=df["avgMyRating"]))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=280, margin=dict(t=10, b=30),
                      xaxis_title="", yaxis_title="Films")
    st.plotly_chart(fig, use_container_width=True)


def render_genres(data: dict):
    st.subheader("Top Genres")
    genres = data["genres"]
    if not genres:
        return
    df = pd.DataFrame(genres)
    fig = go.Figure(go.Bar(
        y=df["name"], x=df["count"], orientation="h",
        marker_color=df["avgRating"].apply(rating_color),
        hovertemplate="%{y}: %{x} films, ★%{customdata:.1f}<extra></extra>",
        customdata=df["avgRating"],
    ))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=400, margin=dict(t=10, l=120),
                      yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig, use_container_width=True)


def render_divergence(data: dict):
    st.subheader("You vs The Crowd")
    div = data["divergence"]
    col1, col2 = st.columns(2)
    with col1:
        st.markdown("**💎 Hidden Gems** — you loved it, crowd didn't")
        for m in div["hiddenGems"]:
            crowd = f"{m['tmdb'] / 2:.1f}"
            st.markdown(f"""<div class="gem-card">
                <strong>{m['name']}</strong> ({m['year']})<br/>
                You ★{m['myRating']} · Crowd ★{crowd} · <span style="color:#4ade80">+{m['diff']}</span>
            </div>""", unsafe_allow_html=True)
    with col2:
        st.markdown("**🙄 Overrated** — crowd loved it, you didn't")
        for m in div["overrated"]:
            crowd = f"{m['tmdb'] / 2:.1f}"
            st.markdown(f"""<div class="gem-card">
                <strong>{m['name']}</strong> ({m['year']})<br/>
                You ★{m['myRating']} · Crowd ★{crowd} · <span style="color:#f87171">{m['diff']}</span>
            </div>""", unsafe_allow_html=True)


def render_countries(data: dict):
    countries = data["countries"]
    if not countries:
        return
    st.subheader("Top Countries")
    df = pd.DataFrame(countries)
    fig = go.Figure(go.Bar(y=df["name"], x=df["count"], orientation="h",
                           marker_color="rgba(99,102,241,0.6)"))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=380, margin=dict(t=10, l=140),
                      yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig, use_container_width=True)


def render_languages(data: dict):
    languages = data["languages"]
    if not languages:
        return
    st.subheader("Original Languages")
    df = pd.DataFrame(languages)
    fig = go.Figure(go.Bar(y=df["name"], x=df["count"], orientation="h",
                           marker_color="rgba(99,102,241,0.5)"))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=320, margin=dict(t=10, l=100),
                      yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig, use_container_width=True)


def render_length_buckets(data: dict):
    st.subheader("Film Length Preference")
    buckets = data["lengthBuckets"]
    df = pd.DataFrame(buckets)
    fig = go.Figure(go.Bar(y=df["label"], x=df["count"], orientation="h",
                           marker_color="rgba(245,200,66,0.5)",
                           hovertemplate="%{y} (%{customdata}): %{x} films<extra></extra>",
                           customdata=df["sublabel"]))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=220, margin=dict(t=10, l=80),
                      yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig, use_container_width=True)


def render_popularity(data: dict):
    st.subheader("How Mainstream Do You Watch?")
    tiers = data["popularityTiers"]
    df = pd.DataFrame(tiers)
    colors = ["#22c55e", "#4ade80", "#f5c842", "#fb923c", "#ef4444"]
    fig = go.Figure(go.Bar(y=df["label"], x=df["count"], orientation="h",
                           marker_color=colors,
                           hovertemplate="%{y} (%{customdata}): %{x} films<extra></extra>",
                           customdata=df["sublabel"]))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=220, margin=dict(t=10, l=100),
                      yaxis=dict(autorange="reversed"))
    st.plotly_chart(fig, use_container_width=True)


def render_taste_profile(data: dict):
    st.subheader("Taste Profile")
    tp = data["tasteProfile"]
    col1, col2 = st.columns(2)
    with col1:
        st.markdown("**Favourite Genres**")
        for g in tp["topGenres"]:
            st.markdown(f"• {g['genre']} — ★{g['score']}")
    with col2:
        st.markdown("**Favourite Decades**")
        for d in tp["topDecades"]:
            st.markdown(f"• {d['decade']}s — ★{d['score']}")


def render_radar(data: dict):
    st.subheader("Cinephile DNA")
    radar = data["radarChart"]
    if not radar:
        return

    categories = [r["axis"] for r in radar]
    values = [r["value"] for r in radar]
    values_closed = values + [values[0]]
    categories_closed = categories + [categories[0]]

    fig = go.Figure()
    fig.add_trace(go.Scatterpolar(
        r=values_closed, theta=categories_closed,
        fill="toself", fillcolor="rgba(245,200,66,0.15)",
        line=dict(color="#f5c842", width=2),
        marker=dict(size=8, color="#f5c842"),
    ))
    fig.update_layout(
        polar=dict(
            radialaxis=dict(visible=True, range=[0, 100], showticklabels=False, gridcolor="rgba(255,255,255,0.1)"),
            angularaxis=dict(gridcolor="rgba(255,255,255,0.1)", color="#aaa"),
            bgcolor="rgba(0,0,0,0)",
        ),
        template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
        showlegend=False, height=400, margin=dict(t=30, b=30),
    )
    col1, col2 = st.columns([2, 1])
    with col1:
        st.plotly_chart(fig, use_container_width=True)
    with col2:
        st.markdown("**Your Scores**")
        for r in radar:
            st.markdown(f"• **{r['axis']}** ({r['value']}) — {r['description']}")


def render_directors(data: dict):
    st.subheader("Director Spotlight")
    directors = data["directorSpotlight"]
    if not directors:
        return
    for d in directors:
        best_info = f"▲ {d['best']['name']} (★{d['best']['myRating']})"
        worst_info = f"▼ {d['worst']['name']} (★{d['worst']['myRating']})" if d['best']['name'] != d['worst']['name'] else ""
        st.markdown(f"""<div class="director-card">
            <strong>{d['name']}</strong> — {d['count']} films · ★{d['avgRating']}<br/>
            <span style="color:#4ade80">{best_info}</span>
            {f'<span style="color:#888;margin-left:12px">{worst_info}</span>' if worst_info else ''}
        </div>""", unsafe_allow_html=True)


def render_rating_evolution(data: dict):
    st.subheader("Rating Evolution — Are You Getting Pickier?")
    evo = data["ratingEvolution"]
    if not evo:
        return
    df = pd.DataFrame(evo)
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=df["quarter"], y=df["avg"], mode="lines+markers",
        line=dict(color="#f5c842", width=2), marker=dict(size=8, color="#f5c842"),
        hovertemplate="%{x}: ★%{y:.2f} (%{customdata} films)<extra></extra>",
        customdata=df["count"],
    ))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=280, margin=dict(t=10, b=30),
                      yaxis=dict(title="Avg Rating", range=[max(0, df["avg"].min() - 0.5), 5]))
    st.plotly_chart(fig, use_container_width=True)


def render_heatmap(data: dict):
    st.subheader("Genre × Decade — Where Your Taste Shines")
    hm = data["genreDecadeHeatmap"]
    if not hm["genres"]:
        return

    # Build matrix
    z = []
    text = []
    for gi, genre in enumerate(hm["genres"]):
        row = []
        text_row = []
        for di, decade in enumerate(hm["decades"]):
            cell = hm["cells"][gi][di]
            if cell:
                row.append(cell["avg"])
                text_row.append(f"★{cell['avg']} ({cell['count']} films)")
            else:
                row.append(None)
                text_row.append("")
        z.append(row)
        text.append(text_row)

    fig = go.Figure(go.Heatmap(
        z=z, x=[f"{d}s" for d in hm["decades"]], y=hm["genres"],
        text=text, texttemplate="%{text}", textfont=dict(size=10),
        colorscale=[[0, "#1a1a2e"], [0.5, "#b45309"], [1, "#22c55e"]],
        hovertemplate="%{y} %{x}: %{text}<extra></extra>",
        showscale=True, colorbar=dict(title="Rating", tickvals=[]),
    ))
    fig.update_layout(template="plotly_dark", paper_bgcolor="rgba(0,0,0,0)",
                      plot_bgcolor="rgba(0,0,0,0)", height=350, margin=dict(t=10, l=120))
    st.plotly_chart(fig, use_container_width=True)


def render_rewatches(data: dict):
    rewatches = data["rewatches"]
    if not rewatches:
        return
    st.subheader("Most Rewatched Films")
    cols = st.columns(min(6, len(rewatches)))
    for i, r in enumerate(rewatches[:12]):
        with cols[i % 6]:
            if r.get("posterPath"):
                st.image(f"https://image.tmdb.org/t/p/w154{r['posterPath']}", width=100)
            st.markdown(f"**{r['count']}×** {r['name']}")


def rating_color(rating):
    if rating >= 4.5:
        return "#22c55e"
    elif rating >= 4.0:
        return "#4ade80"
    elif rating >= 3.5:
        return "#f5c842"
    elif rating >= 3.0:
        return "#fb923c"
    else:
        return "#ef4444"


# ── Main App ──────────────────────────────────────────────────────────────────

st.title("🎬 Letterboxd Stats Analyzer")
st.markdown("Upload your Letterboxd data export (ZIP) to see detailed analytics about your watching habits.")

# Get TMDB key
try:
    tmdb_key = st.secrets["TMDB_API_KEY"]
except Exception:
    tmdb_key = ""

uploaded = st.file_uploader("Upload your Letterboxd export (.zip)", type=["zip"],
                            help="Go to letterboxd.com/settings/data/ → Export Your Data")

if uploaded:
    if "csvs" not in st.session_state or st.session_state.get("_uploaded_name") != uploaded.name:
        csvs = parse_zip(uploaded)
        st.session_state["csvs"] = csvs
        st.session_state["_uploaded_name"] = uploaded.name
        st.session_state["tmdb_cache"] = {}
        st.session_state["enriched"] = False

    csvs = st.session_state["csvs"]

    # Show what we found
    found = {k: len(v) for k, v in csvs.items()}
    st.success(f"Found: {', '.join(f'{k} ({v} rows)' for k, v in found.items())}")

    watchlist = df_to_dicts(csvs.get("watchlist", pd.DataFrame()))
    ratings_list = df_to_dicts(csvs.get("ratings", pd.DataFrame()))
    diary = df_to_dicts(csvs.get("diary", pd.DataFrame()))
    watched = df_to_dicts(csvs.get("watched", pd.DataFrame()))

    # TMDB Enrichment
    if not st.session_state.get("enriched") and tmdb_key:
        all_movies_map = {}
        for m in ratings_list:
            all_movies_map[m.get("Letterboxd URI", "")] = m
        for m in watchlist:
            all_movies_map[m.get("Letterboxd URI", "")] = m
        all_movies = list(all_movies_map.values())

        st.markdown("---")
        st.markdown("**Enriching movies with TMDB data** (genres, directors, countries, runtime...)")
        progress_bar = st.progress(0)
        status_text = st.empty()

        def update_progress(done, total):
            progress_bar.progress(min(done / total, 1.0))
            status_text.text(f"Enriching: {done}/{total} movies...")

        enricher = TMDBEnricher(tmdb_key)
        cache = asyncio.run(enricher.enrich_movies(all_movies, update_progress))
        st.session_state["tmdb_cache"] = cache
        st.session_state["enriched"] = True
        progress_bar.progress(1.0)
        status_text.text(f"Done! Enriched {sum(1 for v in cache.values() if v.get('tmdbId'))} / {len(all_movies)} movies.")
        st.rerun()

    elif not tmdb_key:
        st.warning("No TMDB API key configured. Add it to `.streamlit/secrets.toml` for full analytics (genres, directors, countries, radar chart).")
        st.session_state["enriched"] = True

    # Compute analytics
    if st.session_state.get("enriched"):
        tmdb_cache = st.session_state.get("tmdb_cache", {})
        data = compute_analytics(watchlist, ratings_list, diary, watched, tmdb_cache)

        st.markdown("---")

        # Render all sections
        render_overview(data)
        st.markdown("")
        render_rating_distribution(data)

        render_watchlist_eta(data)
        render_pace(data)
        render_seasonal(data)

        render_radar(data)

        render_decades(data)

        col1, col2 = st.columns(2)
        with col1:
            render_genres(data)
        with col2:
            render_countries(data)

        render_languages(data)
        render_divergence(data)

        col1, col2 = st.columns(2)
        with col1:
            render_length_buckets(data)
        with col2:
            render_popularity(data)

        render_rewatches(data)
        render_taste_profile(data)
        render_directors(data)
        render_rating_evolution(data)
        render_heatmap(data)

else:
    st.markdown("""
    ### How to get your Letterboxd data:
    1. Go to [letterboxd.com/settings/data/](https://letterboxd.com/settings/data/)
    2. Click **Export Your Data**
    3. Download the ZIP file
    4. Upload it here!
    """)
