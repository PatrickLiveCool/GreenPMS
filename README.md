# QinTopia PMS Core Operations MVP

QinTopia PMS is the source of truth for room/bed inventory, orders, stay fulfillment, member-night coverage, immutable pricing revisions, and manually recorded collection facts. The Web client and external-agent API use the same authenticated `/api/v1` command handlers and PostgreSQL transactions.

## Prerequisites

- Node.js 22 or newer and npm 10 or newer
- Docker Engine with Compose v2 for the one-command path
- PostgreSQL 16 is always used for runtime and integration tests; there is no SQLite or in-memory fallback
- Playwright Chromium for browser acceptance: `npx playwright install chromium`

## Start with Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The Compose demo profile sets `SEED_DEMO_DATA=true`; the app waits for PostgreSQL, applies migrations, inserts idempotent demo data, and starts the built API/Web server. A production image run does not seed public demo credentials unless that flag is explicitly enabled.

## Start for development

```bash
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

If the local Docker installation has no Compose plugin, start the same database directly:

```bash
docker run --name qintopia-postgres \
  -e POSTGRES_USER=qintopia \
  -e POSTGRES_PASSWORD=qintopia \
  -e POSTGRES_DB=qintopia \
  -p 55432:5432 -d docker.m.daocloud.io/library/postgres:16-alpine
```

Set `POSTGRES_IMAGE=postgres:16-alpine` when Docker Hub is directly reachable. The Compose default is a transparent mirror of the official image because it is reachable from the current development environment.

Open:

- Web: `http://127.0.0.1:4173` in development, `http://127.0.0.1:4100` in the Docker build
- OpenAPI UI: `http://127.0.0.1:4100/docs`
- OpenAPI 3.1 JSON: `http://127.0.0.1:4100/api/v1/openapi.json`
- Liveness: `http://127.0.0.1:4100/health/live`
- Readiness: `http://127.0.0.1:4100/health/ready`

## Demo identities

| Client | Credential | Effective access |
|---|---|---|
| Web operator | `operator` / `demo-pass-2026` | WRITE on `prop_qintopia_demo` |
| External agent | Bearer `qtp_demo_read_token_2026` | READ ceiling |
| External agent | Bearer `qtp_demo_write_token_2026` | WRITE ceiling |

Tokens are opaque; only SHA-256 hashes are stored. A Token is bound to one real subject and one property, and its effective access is the intersection of the subject's current grant and the Token ceiling. `ISSUE_TOKEN`, `ROTATE_TOKEN`, and `REVOKE_TOKEN` use the same Preview/Confirm/Receipt protocol. For issue or rotation, the client must generate a cryptographically secure 256-bit `qtp_` base64url `tokenSecret` and submit it in the Preview request. The server hashes it before persistence; neither the Preview nor the Receipt returns the secret. A rotated Token is revoked immediately, so the client must retain the replacement secret it generated.

## Agent command protocol

Every business write requires `Idempotency-Key` and `X-Correlation-ID`. `POST /api/v1/quotes` is the one low-risk, single-stage command: READ access is sufficient, it does not use Preview/Confirm, and it returns `{ quote, receipt }`. The Quote row, `CREATE_QUOTE` execution, audit entry, and permanent Receipt commit in one transaction. Replaying the same key and payload returns that same Quote and Receipt.

High-risk commands are two-stage:

1. `POST /api/v1/command-previews` with a command type and input.
2. Present the returned effect to a human or policy gate.
3. `POST /api/v1/command-previews/{previewId}/confirm` with the Preview's exact `propertyId` and `commandType`, `confirmation: true`, its exact `effectHash` as `expectedEffectHash`, and a structured reason.
4. Store the returned `commandId` and `receiptId`.

Confirm locks and revalidates authorization, aggregate versions, inventory day slots, membership ledger state, and the locked pricing policy. A changed or expired Preview returns a durable `NOT_EXECUTED` Receipt and performs zero domain writes. Replaying the same subject/command/idempotency key and request returns the original Receipt; changing the request returns `IDEMPOTENCY_KEY_REUSED`.

After a network interruption query either:

```text
GET /api/v1/commands/{commandId}
GET /api/v1/command-results?propertyId=prop_qintopia_demo&commandType=CREATE_QUOTE&idempotencyKey=...
GET /api/v1/command-results?propertyId=prop_qintopia_demo&commandType=CREATE_ORDER&idempotencyKey=...
GET /api/v1/receipts/{receiptId}
```

Results are `EXECUTED`, `NOT_EXECUTED`, or `UNKNOWN`. Do not retry an `UNKNOWN` command with a new key.

`CREATE_QUOTE` is a low-risk single-stage command: READ access is sufficient and Preview/Confirm do not apply, but both command headers, a durable Receipt, audit, idempotent replay, and recovery still apply. Expired Quotes cannot create an order, but their rows are retained and the durable Receipt permanently embeds the original Quote snapshot; only unexpired Quotes count toward the per-subject/property active quota.

## Pricing boundary

Published seed policies are deliberately finite:

- `policy_transient_v1`: fixed CNY 120.00 per uncovered night, within one calendar month
- `policy_free_v1`: zero cash amount while still claiming inventory

Weekly, monthly, rolling, and cross-month calculations return `PRICING_POLICY_UNCONFIGURED`. They will only be published after real, user-supplied pricing cases define their cycle boundaries, proration, and rounding. Coverage is a set of service dates and inventory units backed by ROOM_NIGHT or BED_NIGHT lots; it is formed before cash lines and is never converted to a discount or cash value.

The only recomputed amount fields are:

- `currentContractAmount`
- `netRecordedCollection`
- `collectionDifference`

They do not mean paid, settled, receivable, refundable, recognized revenue, or external bank confirmation.

## Verification

With PostgreSQL running:

```bash
npm run verify
npm run test:integration
npm run build
npm run test:contract
npm run test:e2e
npm run verify:cold-start
./scripts/verify-backup-restore.sh
```

The database suites terminate connections to, drop, and recreate dedicated databases. By default these are `qintopia_test`, `qintopia_command_protocol`, `qintopia_quote_command`, `qintopia_database_invariants`, `qintopia_security_integration`, `qintopia_receipt_references`, `qintopia_security_contract`, `qintopia_agent_journey_contract`, `qintopia_effect_contract`, and `qintopia_e2e`. Never point a test database environment variable at a database containing retained data. The suites use independent connections to prove whole-room/bed mutual exclusion, different-bed coexistence, stale Preview rollback, idempotency, Receipt atomicity, stay changes, collections/refunds, fulfillment, and Token lifecycle.

## Backup and restore

Create a compressed PostgreSQL backup:

```bash
./scripts/backup.sh
```

Restore into a database name that does not already exist. The script refuses both the configured live database and every existing target database:

```bash
ALLOW_RESTORE=true ./scripts/restore.sh backups/qintopia-YYYYMMDD-HHMMSS.dump qintopia_restored
```

Run the automated recovery proof:

```bash
./scripts/verify-backup-restore.sh
```

Container name, database, and database user can be overridden with `POSTGRES_CONTAINER`, `POSTGRES_DB`, and `POSTGRES_USER`.

## Repository map

- `packages/contracts` - stable DTO vocabulary, command types, error codes, IDs, Receipts
- `packages/domain` - date, pricing, access ordering, hashing, and amount invariants
- `packages/db` - PostgreSQL migration, seed, day-slot locking, repositories, command transactions
- `apps/api` - authentication, `/api/v1`, OpenAPI, health/readiness, static Web hosting
- `apps/web` - operational room board, order workspace, and mobile fulfillment
- `tests` - domain, real-PostgreSQL integration, OpenAPI contract, and browser E2E tests
- `docs/pricing-facts` - schema and intake format for real pricing golden cases

No previous PMS, migration adapter, compatibility service, projection write-back, payment gateway, accounting ledger, dynamic formula engine, Redis, or queue is used.
