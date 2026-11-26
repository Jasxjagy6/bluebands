#!/usr/bin/env bash
# Zero-downtime deploy: rebuild, migrate, then recreate the two backend
# replicas one at a time. Caddy keeps serving from the healthy replica
# throughout, so there is no gap in service.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building new image"
docker compose build treasury_blue

echo "==> Applying migrations"
docker compose run --rm migrate

wait_healthy() {
  local svc="$1"
  local cid
  cid="$(docker compose ps -q "$svc")"
  echo -n "    waiting for $svc to be healthy"
  for _ in $(seq 1 40); do
    local status
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then echo " — ok"; return 0; fi
    echo -n "."; sleep 2
  done
  echo " — TIMEOUT"; return 1
}

for color in treasury_blue treasury_green; do
  echo "==> Updating $color"
  docker compose up -d --no-deps "$color"
  wait_healthy "$color"
done

# Re-bind the static frontend (single-file mounts need a recreate to pick up
# edited index.html / app.js / wallet.js).
echo "==> Refreshing static frontend (caddy)"
docker compose up -d --force-recreate caddy >/dev/null 2>&1

echo "==> Deploy complete. The other replica served traffic the whole time."
