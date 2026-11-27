#!/usr/bin/env bash
# Roll the two API replicas separately. Pause the signing worker for schema
# changes, then rebind frontend mounts after both replicas support the new UI.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building new image"
docker compose build treasury_blue

echo "==> Applying migrations"
docker compose stop custody_worker
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
docker compose up -d --no-deps custody_worker

# Migration 033 defaults enrollment off. Both serving API replicas must enforce
# player factors before anyone can enroll; an older login must never bypass MFA.
echo "==> Enabling player authenticator enrollment"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U treasury -d empireblox_treasury \
  -c "update settings set value='true'::jsonb where key='player_2fa_available';"

# Re-bind the static frontend (single-file mounts need a recreate to pick up
# edited index.html / app.js / wallet.js).
echo "==> Refreshing static frontend (caddy)"
docker compose up -d --no-deps --force-recreate caddy >/dev/null 2>&1

echo "==> Deploy complete. API replicas are healthy and frontend mounts are refreshed."
