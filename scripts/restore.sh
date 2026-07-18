#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_RESTORE:-false}" != "true" ]]; then
  printf 'Refusing restore. Set ALLOW_RESTORE=true and restore only into a new database.\n' >&2
  exit 2
fi

backup="${1:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
target="${2:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
container="${POSTGRES_CONTAINER:-qintopia-postgres}"
user="${POSTGRES_USER:-qintopia}"
live_database="${POSTGRES_DB:-qintopia}"

if [[ "$target" == "$live_database" ]]; then
  printf 'Refusing to restore over the configured live database %s.\n' "$live_database" >&2
  exit 2
fi
if [[ ! "$target" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
  printf 'Refusing unsafe target database name: %s\n' "$target" >&2
  exit 2
fi
test -s "$backup"
target_exists="$(docker exec "$container" psql -U "$user" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$target'")"
if [[ "$target_exists" == "1" ]]; then
  printf 'Refusing restore because target database %s already exists. Choose a new database name.\n' "$target" >&2
  exit 2
fi
docker exec "$container" createdb -U "$user" "$target"
docker exec -i "$container" pg_restore -U "$user" -d "$target" --no-owner --no-privileges < "$backup"
required_migrations="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name IN ('001_initial.sql','002_immutability.sql','003_active_coverage_uniqueness.sql','004_security_identity_guards.sql','005_core_identity_and_entitlement_guards.sql','006_property_scoped_idempotency.sql')")"
if [[ "$required_migrations" != "6" ]]; then
  printf 'Restore target %s is missing required migrations (found %s of 6).\n' "$target" "$required_migrations" >&2
  exit 1
fi
printf 'Restored %s into new database %s\n' "$backup" "$target"
