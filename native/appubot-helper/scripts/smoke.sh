#!/usr/bin/env bash
# Builds appubot-helper and exercises the read-only commands via argv mode.
# Safe to run: it never clicks, types or changes app state.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== swift build -c release"
if ! swift build -c release 2>&1 | tail -n 3; then
  echo "build failed" >&2
  exit 1
fi
BIN=".build/release/appubot-helper"
[ -x "$BIN" ] || { echo "binary missing: $BIN" >&2; exit 1; }

run() {
  local cmd="$1" params="${2:-}"
  [ -n "$params" ] || params='{}'
  echo
  echo "== $cmd $params"
  local out
  out="$("$BIN" "$cmd" "$params" 2>/dev/null)"
  echo "exit=$?"
  printf '%s\n' "$out" | cut -c1-600
}

run ping
run permissions
run screen_size
run displays
run running_apps
run list_windows

echo
echo "== screenshot {} -> /tmp/appubot-shot.png"
SHOT_JSON="$("$BIN" screenshot '{}' 2>/dev/null)"
if printf '%s' "$SHOT_JSON" | grep -q '"ok":true'; then
  printf '%s' "$SHOT_JSON" | grep -o '"image_base64":"[^"]*"' | sed -e 's/^"image_base64":"//' -e 's/"$//' | base64 -D > /tmp/appubot-shot.png
  echo "meta: $(printf '%s' "$SHOT_JSON" | sed 's/"image_base64":"[^"]*"/"image_base64":"<omitted>"/' | cut -c1-600)"
  echo "file: /tmp/appubot-shot.png  bytes=$(stat -f%z /tmp/appubot-shot.png)"
  sips -g pixelWidth -g pixelHeight /tmp/appubot-shot.png | tail -n 2
else
  echo "screenshot failed: $(printf '%s' "$SHOT_JSON" | cut -c1-600)"
fi

run clipboard_get
run cursor_position
run frontmost_app
run focused_window
run ax_focused_element
echo
echo "smoke test done"
