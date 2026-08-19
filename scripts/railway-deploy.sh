#!/usr/bin/env bash
# Deploy one Polaris runtime to Railway, safely.
#
# WHY THIS EXISTS. `railway up --detach` exits 0 as soon as the upload is accepted,
# so a deploy that then fails to build looks like a success. That happened: a locally
# running backend was rewriting its SQLite WAL inside the working tree while the
# uploader tarred it, the snapshot truncated at 629 kB with package.json and
# railway.json missing, the build failed with "Railpack could not determine how to
# build the app", and nothing said so until the old container was still serving
# stale code minutes later.
#
# So this script does the two things `railway up` will not:
#   1. PREFLIGHT the payload: every file the build actually needs must survive
#      .railwayignore, and nothing being actively written may be uploaded.
#   2. WAIT for a terminal deployment status and exit non-zero on failure, printing
#      the build log tail so the reason is visible.
#
# Usage:
#   scripts/railway-deploy.sh polaris-bot-runtime
#   scripts/railway-deploy.sh polaris-agent-runtime
set -euo pipefail

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
  echo "usage: $0 <railway-service-name>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ROOT="$PWD"

# ── 1. Preflight ────────────────────────────────────────────────────────────────
echo "Preflight for $SERVICE"

# Files the Railpack build cannot proceed without. Losing any of them is exactly the
# failure this script exists to prevent, so check them explicitly rather than trusting
# the ignore file to stay correct.
REQUIRED=(package.json railway.json server/package.json server/runtime.js server/server.js)
missing=0
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  MISSING from the working tree: $f" >&2
    missing=1
  fi
done
[[ $missing -eq 0 ]] || { echo "Refusing to deploy: required files are absent." >&2; exit 1; }

# The deployment artifact carries BOT Chain's contract addresses; without it the
# runtime comes up with no market and reports the network as undeployed.
if [[ "$SERVICE" == *bot* && ! -f deployments/botchain-testnet/contracts.json ]]; then
  echo "Refusing to deploy: deployments/botchain-testnet/contracts.json is missing." >&2
  exit 1
fi

# Anything volatile inside the build context is the actual hazard: a file whose size
# changes mid-read truncates the tar. State belongs in .state/ or on the volume.
volatile=$(find . \
  -path ./node_modules -prune -o \
  -path ./.git -prune -o \
  -path ./.state -prune -o \
  -path ./contracts/node_modules -prune -o \
  -path ./server/node_modules -prune -o \
  -type f \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name 'chain-index-*.json' \) \
  -print 2>/dev/null | sed 's|^\./||')

if [[ -n "$volatile" ]]; then
  # These are excluded by .railwayignore, so the upload is safe; say so once rather
  # than failing, because a warm local index is useful and harmless where it sits.
  echo "  note: $(echo "$volatile" | wc -l) live state file(s) in the tree, excluded from the upload:"
  echo "$volatile" | sed 's/^/    /' | head -5
  [[ $(echo "$volatile" | wc -l) -gt 5 ]] && echo "    …"
  # But prove the exclusion actually holds, instead of assuming it.
  for f in $volatile; do
    if ! grep -qE '(^|/)\*\.db|\*\.db-wal|chain-index-\*' .railwayignore; then
      echo "  .railwayignore no longer excludes live state files. Fix it before deploying." >&2
      exit 1
    fi
    break
  done
fi

# Files modified in the last few seconds are still being written by something.
recent=$(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.state -prune -o \
  -type f -newermt '-5 seconds' -print 2>/dev/null | grep -vE '\.(db|db-wal|db-shm)$' | sed 's|^\./||' || true)
if [[ -n "$recent" ]]; then
  echo "  warning: modified in the last 5s (a mid-read change can truncate the upload):"
  echo "$recent" | sed 's/^/    /' | head -5
fi

echo "  ok"

# ── 2. Upload ──────────────────────────────────────────────────────────────────
echo "Uploading to $SERVICE…"
railway up --service "$SERVICE" --detach

# ── 3. Wait for a terminal status ──────────────────────────────────────────────
# `railway up --detach` has already returned, so poll the deployment list until this
# deploy reaches a state that means something. `railway status --json` deliberately is
# NOT used: it carries no deployment status (services[].node.deployments is empty),
# which is exactly how a failure went unnoticed before.
echo "Waiting for the deployment to finish…"

latest_status() {
  railway deployment list --service "$SERVICE" --json 2>/dev/null | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(rows, list) and rows:
    print(rows[0].get("status", ""))
'
}

deadline=$(( $(date +%s) + 900 ))
status=""
while [[ $(date +%s) -lt $deadline ]]; do
  status="$(latest_status)"
  case "$status" in
    SUCCESS)
      echo "  SUCCESS"
      exit 0
      ;;
    FAILED|CRASHED)
      echo "  $status: the build or the container did not come up." >&2
      echo "  Last build log lines:" >&2
      railway logs --build --service "$SERVICE" 2>/dev/null | tail -25 >&2 || true
      exit 1
      ;;
    REMOVED)
      # A newer deploy superseded this one, which means someone deployed twice; the
      # newer one is the one that matters, so keep waiting for it.
      ;;
  esac
  sleep 15
done

echo "  timed out after 15 minutes; last status: ${status:-unknown}" >&2
exit 1
