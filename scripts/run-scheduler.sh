#!/bin/sh
# Persist successful runs so container restarts do not repeat scheduled work.
set -eu
state_dir="${SCHEDULER_STATE_DIR:-/app/data/scheduler}"
mkdir -p "$state_dir"
while true; do
  today=$(date -u +%F)
  week=$(date -u +%G-%V)
  last_daily=$(cat "$state_dir/daily" 2>/dev/null || true)
  if [ "$last_daily" != "$today" ]; then
    if node src/cron.js; then
      printf '%s\n' "$today" > "$state_dir/daily.tmp"
      mv "$state_dir/daily.tmp" "$state_dir/daily"
    fi
  fi
  last_weekly=$(cat "$state_dir/weekly" 2>/dev/null || true)
  if [ "$last_weekly" != "$week" ]; then
    if node src/recommend.js; then
      printf '%s\n' "$week" > "$state_dir/weekly.tmp"
      mv "$state_dir/weekly.tmp" "$state_dir/weekly"
    fi
  fi
  sleep 3600
done
