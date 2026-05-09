#!/usr/bin/env bash
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

APP_DIR="/Users/bmilhizer/career-ops"
INTERVAL_SECONDS="${CAREER_OPS_SCAN_INTERVAL_SECONDS:-21600}"
LOCK_DIR="/tmp/career-ops-scan.lock"

cd "$APP_DIR" || exit 1

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

echo "[scan-loop] started at $(timestamp), interval=${INTERVAL_SECONDS}s"

while true; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
    echo "[scan-loop] scan cycle started at $(timestamp)"

    /opt/homebrew/bin/npm run scan
    scan_status=$?
    if [ "$scan_status" -ne 0 ]; then
      echo "[scan-loop] portal scan exited with status ${scan_status}"
    fi

    /opt/homebrew/bin/npm run scan:linkedin
    linkedin_status=$?
    if [ "$linkedin_status" -ne 0 ]; then
      echo "[scan-loop] linkedin scan exited with status ${linkedin_status}"
    fi

    echo "[scan-loop] scan cycle finished at $(timestamp)"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    trap - EXIT
  else
    echo "[scan-loop] another scan is already running; skipped at $(timestamp)"
  fi

  sleep "$INTERVAL_SECONDS"
done
