#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing dependencies..."
cd "$APP_ROOT"
npm install

echo ""
echo "Done. Set ANTHROPIC_API_KEY in .env, then: node server.mjs"
