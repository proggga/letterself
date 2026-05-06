.PHONY: help run start dev enrich posters rebuild install clean-cache clean-posters

# Default target
help:
	@echo "Movie Night — available targets:"
	@echo ""
	@echo "  make run            Rebuild (enrich + posters) then start the server"
	@echo "  make dev            Start the server with auto-reload (--watch)"
	@echo ""
	@echo "  make enrich         Fetch TMDB metadata for all movies (watchlist + ratings)"
	@echo "  make posters        Download poster images to public/posters/"
	@echo "  make rebuild        Full rebuild: enrich → download posters"
	@echo ""
	@echo "  make install        Install npm dependencies"
	@echo ""
	@echo "  make clean-cache    Delete tmdb-cache.json (forces full re-enrich)"
	@echo "  make clean-posters  Delete all cached poster images"

# ── Server ────────────────────────────────────────────────────────────────────

run: rebuild
	node server.js

start:
	node server.js

dev:
	node --watch server.js

# ── Data pipeline ─────────────────────────────────────────────────────────────

enrich:
	node enrich.js

posters: tmdb-cache.json
	node download-posters.js

# Full rebuild from scratch (assumes cache already exists; run enrich first if needed)
rebuild: enrich posters
	@echo "✅ Rebuild complete."

tmdb-cache.json:
	@echo "tmdb-cache.json not found — running enrich first..."
	node enrich.js

# ── Setup ─────────────────────────────────────────────────────────────────────

install:
	npm install

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean-cache:
	rm -f tmdb-cache.json
	@echo "Cache deleted. Run 'make enrich' to rebuild."

clean-posters:
	rm -rf public/posters/
	@echo "Posters deleted. Run 'make posters' to re-download."
