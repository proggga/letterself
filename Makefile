.PHONY: help run start dev enrich posters rebuild install clean-posters

# Default target
help:
	@echo "Movie Night — available targets:"
	@echo ""
	@echo "  make run            Start the server (http://localhost:3000)"
	@echo "  make start          Same as make run"
	@echo "  make dev            Start with auto-reload (--watch)"
	@echo ""
	@echo "  make enrich         Fetch TMDB metadata (keeps existing cache order)"
	@echo "  make posters        Download poster images to public/posters/"
	@echo "  make rebuild        Full rebuild: enrich → posters"
	@echo ""
	@echo "  make install        Install npm dependencies"
	@echo ""
	@echo "  make clean-posters  Delete all cached poster images"

# ── Server ────────────────────────────────────────────────────────────────────

run:
	node server.js

start: run

dev:
	node --watch server.js

# ── Data pipeline ─────────────────────────────────────────────────────────────

enrich:
	node enrich.js

posters: tmdb-cache.json
	node download-posters.js

rebuild: enrich posters
	@echo "✅ Rebuild complete."

tmdb-cache.json:
	@echo "tmdb-cache.json not found — running enrich first..."
	node enrich.js

# ── Setup ─────────────────────────────────────────────────────────────────────

install:
	npm install

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean-posters:
	rm -rf public/posters/
	@echo "Posters deleted. Run 'make posters' to re-download."

diff:
	python3 letterboxd_out.py "../Letterboxd Top 500 Updates - Update Notes.csv" out.csv
	diff out.csv out.csv.back
