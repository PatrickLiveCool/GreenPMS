#!/usr/bin/env bash
set -euo pipefail

container="${POSTGRES_CONTAINER:-qintopia-postgres}"
user="${POSTGRES_USER:-qintopia}"
live_database="${POSTGRES_DB:-qintopia}"
run_id="$$_$(date +%s)_${RANDOM}"
source_database="qintopia_restore_source_${run_id}"
target_database="qintopia_restore_verify_${run_id}"
workdir="$(mktemp -d)"
bootstrap="$workdir/bootstrap.dump"
restore_point="$workdir/restore-point.dump"
boundary_marker="__qintopia_restore_boundary_$$_$(date +%s)_${RANDOM}__"
sentinel_property_id="prop_restore_sentinel_${run_id}"
trap 'docker exec "$container" dropdb -U "$user" --if-exists "$source_database" >/dev/null 2>&1 || true; docker exec "$container" dropdb -U "$user" --if-exists "$target_database" >/dev/null 2>&1 || true; rm -rf "$workdir"' EXIT

docker exec "$container" pg_dump -U "$user" -Fc "$live_database" > "$bootstrap"
docker exec "$container" createdb -U "$user" "$source_database"
docker exec -i "$container" pg_restore -U "$user" -d "$source_database" --no-owner --no-privileges < "$bootstrap"
docker exec "$container" psql -U "$user" -d "$source_database" -v ON_ERROR_STOP=1 -c "INSERT INTO properties(id, code, name, timezone, currency) VALUES ('$sentinel_property_id', '$sentinel_property_id', 'Restore sentinel', 'Asia/Shanghai', 'CNY')" >/dev/null

docker exec "$container" pg_dump -U "$user" -Fc "$source_database" > "$restore_point"
docker exec "$container" psql -U "$user" -d "$source_database" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(name) VALUES ('$boundary_marker')" >/dev/null

ALLOW_RESTORE=true POSTGRES_CONTAINER="$container" POSTGRES_USER="$user" POSTGRES_DB="$live_database" ./scripts/restore.sh "$restore_point" "$target_database" >/dev/null

source_marker="$(docker exec "$container" psql -U "$user" -d "$source_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name = '$boundary_marker'")"
target_marker="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name = '$boundary_marker'")"
target_sentinel="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM properties WHERE id = '$sentinel_property_id'")"
required_migrations="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name IN ('001_initial.sql','002_immutability.sql','003_active_coverage_uniqueness.sql','004_security_identity_guards.sql','005_core_identity_and_entitlement_guards.sql','006_property_scoped_idempotency.sql')")"
one_stay_violations="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM orders o LEFT JOIN stays s ON s.order_id=o.id GROUP BY o.id HAVING count(s.id) <> 1' | wc -l | tr -d ' ')"
missing_revisions="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM orders WHERE current_revision_id IS NULL')"
room_bed_conflicts="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM inventory_room_days r JOIN inventory_bed_days b ON b.room_id=r.room_id AND b.service_date=r.service_date WHERE r.whole_claim_id IS NOT NULL AND b.bed_claim_id IS NOT NULL')"

test "$source_marker" = "1"
test "$target_marker" = "0"
test "$target_sentinel" = "1"
test "$required_migrations" = "6"
test "$one_stay_violations" = "0"
test "$missing_revisions" = "0"
test "$room_bed_conflicts" = "0"
printf 'Backup/restore verified: sentinel data, recovery boundary, migrations, Stay cardinality, revision references, and room/bed exclusion are valid.\n'
