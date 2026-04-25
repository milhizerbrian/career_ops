#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V2="/Users/bmilhizer/xxv2"

echo "Preparing data symlinks in $V2..."
# tracker.json lives at xxv2 root, but we read it via data/ — create an inner symlink
mkdir -p "$V2/data"
if [ ! -e "$V2/data/tracker.json" ] && [ ! -L "$V2/data/tracker.json" ]; then
  ln -s "$V2/tracker.json" "$V2/data/tracker.json"
  echo "  Linked xxv2/data/tracker.json -> ../tracker.json"
fi

echo "Creating app symlinks..."
for dir in data config output reports; do
  target="$APP_ROOT/$dir"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "  $dir already exists, skipping"
  else
    ln -s "$V2/$dir" "$target"
    echo "  Linked $dir -> $V2/$dir"
  fi
done

echo "Installing dependencies..."
cd "$APP_ROOT"
npm install

echo ""
echo "Done. Copy .env and set ANTHROPIC_API_KEY, then: node server.mjs"
