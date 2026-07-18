#!/usr/bin/env bash
set -euo pipefail
umask 077

container="${POSTGRES_CONTAINER:-qintopia-postgres}"
database="${POSTGRES_DB:-qintopia}"
user="${POSTGRES_USER:-qintopia}"
timestamp="$(date +%Y%m%d-%H%M%S)"
output="${1:-backups/${database}-${timestamp}.dump}"
output_directory="$(dirname "$output")"
temporary=""
trap 'if [[ -n "$temporary" ]]; then rm -f "$temporary"; fi' EXIT

mkdir -p "$output_directory"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
docker exec "$container" pg_dump -U "$user" -Fc "$database" > "$temporary"
test -s "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$output"
temporary=""
chmod 600 "$output"
printf 'Backup written: %s\n' "$output"
