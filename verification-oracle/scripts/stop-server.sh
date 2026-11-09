#!/bin/sh
# Stop the VerificationOracle dev server.
#
# Why this exists: `npm run dev` spawns `tsx src/server.ts` as a child. Killing
# the npm wrapper alone leaves the child holding port 4021. This script finds
# both by matching the project path and sends SIGTERM, then SIGKILL to any
# survivors. Scoped to this project directory only — it will not kill other
# projects' servers.
#
# Usage:
#   npm run stop                 # stop the server
#   npm run stop -- --dry-run    # show what would be killed, kill nothing

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-4021}"
DRY_RUN=0

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

find_pids() {
  # Anything whose command line references this project and either the server
  # source or `npm run dev` — covers the npm wrapper and the tsx/node child.
  ps -eo pid=,args= \
    | grep "$ROOT" \
    | grep -E "src/server\.ts|npm run dev(\s|$)" \
    | grep -v grep \
    | grep -v stop-server.sh \
    | awk '{print $1}'
}

PIDS=$(find_pids)

if [ -z "$PIDS" ]; then
  echo "No VerificationOracle server processes found."
  exit 0
fi

PID_LIST=$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')
echo "VerificationOracle server PIDs found:"
ps -p "$PID_LIST" -o pid=,lstart=,args=

if [ "$DRY_RUN" = "1" ]; then
  echo "(dry run) Nothing killed."
  exit 0
fi

echo "Stopping (SIGTERM): $PIDS"
kill $PIDS 2>/dev/null
sleep 1

REMAINING=$(find_pids)
if [ -n "$REMAINING" ]; then
  echo "Some processes survived SIGTERM — sending SIGKILL: $REMAINING"
  kill -9 $REMAINING 2>/dev/null
  sleep 1
fi

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "WARNING: port $PORT is still in use."
  exit 1
fi

echo "Server stopped. Port $PORT is free."
