#!/usr/bin/env bash
set -euo pipefail

container="${POSTGRES_CONTAINER:-qintopia-postgres}"
user="${POSTGRES_USER:-qintopia}"
password="${POSTGRES_PASSWORD:-qintopia}"
host_port="${POSTGRES_HOST_PORT:-55432}"
run_id="$$_$(date +%s)_${RANDOM}"
database="qintopia_cold_start_${run_id}"
port="$((42000 + RANDOM % 10000))"
workdir="$(mktemp -d)"
cookie_jar="$workdir/cookies.txt"
app_log="$workdir/app.log"
app_pid=""
app_container=""

cleanup() {
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" >/dev/null 2>&1 || true
    wait "$app_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$app_container" ]]; then
    docker rm -f "$app_container" >/dev/null 2>&1 || true
  fi
  docker exec "$container" dropdb -U "$user" --if-exists "$database" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

docker exec "$container" createdb -U "$user" "$database"
database_url="postgres://$user:$password@127.0.0.1:$host_port/$database"

if [[ -n "${VERIFY_APP_IMAGE:-}" ]]; then
  app_container="qintopia-cold-start-${run_id//_/-}"
  docker run --detach --init --name "$app_container" \
    --add-host host.docker.internal:host-gateway \
    -p "127.0.0.1:$port:4100" \
    -e "DATABASE_URL=postgres://$user:$password@host.docker.internal:$host_port/$database" \
    -e PORT=4100 \
    -e "WEB_ORIGIN=http://127.0.0.1:$port" \
    -e SESSION_COOKIE_SECURE=false \
    -e SEED_DEMO_DATA=true \
    -e LOG_LEVEL=warn \
    "$VERIFY_APP_IMAGE" >/dev/null
else
  DATABASE_URL="$database_url" npm run db:migrate
  DATABASE_URL="$database_url" npm run db:seed
  npm run build

  DATABASE_URL="$database_url" PORT="$port" WEB_ORIGIN="http://127.0.0.1:$port" SESSION_COOKIE_SECURE=false LOG_LEVEL=warn \
    node --import tsx apps/api/src/main.ts >"$app_log" 2>&1 &
  app_pid="$!"
fi

ready=false
for _ in {1..60}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  if [[ -n "$app_container" ]]; then
    docker logs "$app_container" >&2 || true
  else
    sed -n '1,200p' "$app_log" >&2
  fi
  printf 'Cold-start API did not become ready on port %s.\n' "$port" >&2
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:$port/health/live" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$port/" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$port/api/v1/openapi.json" >/dev/null
curl --fail --silent --show-error -c "$cookie_jar" -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"demo-pass-2026"}' "http://127.0.0.1:$port/api/v1/auth/login" >/dev/null
curl --fail --silent --show-error -b "$cookie_jar" "http://127.0.0.1:$port/api/v1/me" >/dev/null

printf 'Cold start verified: migrations, seed, demo login, Web, OpenAPI, liveness, and readiness on isolated database %s.\n' "$database"
