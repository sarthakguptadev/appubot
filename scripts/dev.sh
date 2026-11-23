#!/usr/bin/env bash
# One-shot dev bootstrap: install, build the MCP bridge + Swift helper, then launch the desktop app.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install
pnpm -C packages/mcp-bridge build
if command -v swift >/dev/null 2>&1; then (cd native/appubot-helper && swift build -c release); else echo "swift not found; skipping native helper (teach mode will use manual fallback)"; fi
exec pnpm dev:desktop
