# ADR 0002 — SQLite first, Postgres later

- Status: accepted
- Date: 2026-05-23
- Phase: 1.2 (recap, authored during 1.7 close-out)
- Related: `docs/dev/plans/overall.md` §3 (non-goals), §4
  (technical foundation), §11.7 (deferred Postgres);
  `docs/dev/plans/phase-01-system-foundation.md` §4.2 row "1.2",
  §11.2 (open question on SQLite driver); `AGENTS.md` §Platforms.

---

## Context

The overall plan (§3 non-goals) commits to "PostgreSQL on day one"
being **out of scope** for v1, and (§4) names SQLite as the primary DB.
Phase 1.2 implemented this — `apps/server/src/storage/sqlite.ts` opens
`bunny2.sqlite` in the data-dir via `bun:sqlite`, with a hand-rolled
migrations runner (`migrations.ts`) and SQL files under
`apps/server/src/storage/migrations/`. This ADR records why SQLite
first, why `bun:sqlite` specifically, and the rules that keep a future
Postgres migration cheap.

Constraints that drove the call:

1. **Portable, local-first**: the product is an Electron-wrapped app
   the user runs on their own machine (ADR 0004). A server-side DB
   contradicts that shape.
2. **Single-process, single-writer** in phase 1. SQLite's per-process
   contention is a non-issue at this scale.
3. **Multi-platform**: macOS, Linux, Windows (`AGENTS.md` §Platforms).
   The DB driver must work on all three with zero extra dependencies.
4. **Future federation / multi-tenant** (overall plan §3, "Later"
   section) implies the schema must stay translatable to Postgres.

---

## Decision

### 1. SQLite is the primary DB for phase 1

The primary DB is a file (`bunny2.sqlite`) inside the per-user
data-dir resolved by `apps/server/src/config/paths.ts::resolveDataDir`
(`BUNNY2_DATA_DIR` env wins over the config value). Telemetry
(`llm_calls`) and the event log (`events`) live in the same file as
domain data, per overall plan §4 ("Telemetry storage: same SQLite as
primary data").

### 2. `bun:sqlite` is the driver

We use the built-in `bun:sqlite` (Bun ships an in-runtime SQLite
binding). Rejected:

- `better-sqlite3` — mature, but requires Node-compat shim under Bun,
  ships a native `.node`, and complicates the portable build (an
  extra OS×arch matrix). The phase-1 open question (§11.2) leaned
  `bun:sqlite` "unless a missing feature blocks us"; no blocker
  surfaced in 1.2/1.3.
- `drizzle-orm` / `kysely` with migrations — too much lock-in for
  phase 1. Phase-1 plan §11.3 explicitly favored hand-rolled SQL;
  revisit at phase 4 when entity CRUD lands.

### 3. Migrations are hand-rolled SQL files + a tiny runner

- Files: `apps/server/src/storage/migrations/<NNNN>_<name>.sql`.
- Runner: `applyMigrations(db, migrations)` in
  `apps/server/src/storage/migrations.ts`. A `schema_migrations`
  table tracks applied ids; each migration runs in a transaction.
- The id stored in `schema_migrations` is the filename (without
  `.sql`), so the `currentSchemaVersion(db)` helper that powers
  `/status` is the human-readable name.

### 4. Schema rules to keep Postgres-portability open

- **No SQLite-only SQL.** No `WITHOUT ROWID`, no `STRICT` tables (yet
  — revisit when Postgres equivalence is firmed up), no `JSON1`-only
  functions in WHERE clauses. JSON columns are typed as `TEXT` and
  parsed in code; this works identically on Postgres `JSONB` later
  with a column-type change only.
- **UUIDs as TEXT.** Postgres has a native `uuid` type; SQLite does
  not. Stored as `TEXT` for now; conversion is trivial.
- **Timestamps as ISO 8601 TEXT.** `occurred_at`, `started_at`,
  `ended_at`, etc. Avoids the SQLite `REAL` julian-date footgun and
  ports to Postgres `timestamptz` cleanly.
- **Foreign keys on.** `PRAGMA foreign_keys = ON` is set at every
  `openDatabase()`. Postgres-style integrity from day one.
- **WAL mode.** `PRAGMA journal_mode = WAL` for read-during-write.

---

## When do we revisit?

A switch to Postgres becomes interesting when **at least one** of:

1. Multi-process write contention shows up — phase 5 introduces
   scheduled tasks; if a future worker process needs to write
   concurrently, SQLite's reader/writer model becomes the bottleneck.
2. Multi-server federation lands (overall plan "Later"). Federation
   implies a backing store reachable from multiple hosts.
3. A specific Postgres feature is genuinely needed: `JSONB` indexing,
   `GIN`/`GiST`, partitioning, replication.

When that day comes, the migration is: rewrite `migrations/*.sql`
through a SQL dialect translator, swap `bun:sqlite` for `postgres.js`
(or similar), and re-test the integration suite against a real
Postgres instance.

---

## Consequences

**Positive**

- Zero extra runtime dependencies; SQLite ships in-Bun.
- One file in the data-dir contains everything; backup is `cp
bunny2.sqlite ...`.
- Migrations are deterministic and inspectable — no ORM-generated
  shape drift.
- Test setup is `openDatabase(mkdtempSync(...))` — every test gets a
  fresh DB in under a millisecond.

**Negative / accepted**

- No concurrent multi-writer story. Acceptable for phase 1; the
  in-memory bus and the single Bun server are also single-process.
- Hand-rolled migrations means we'll write boilerplate for every
  schema change. Acceptable through phase 4; revisit then.
- `bun:sqlite`'s API surface differs from `better-sqlite3` — if we
  ever swap, calls have to be ported. Localized to
  `apps/server/src/storage/*`, so the blast radius is small.

---

## Alternatives considered

1. **Postgres from day one.** Rejected: contradicts the portable
   local-first product shape and forces every user to run an extra
   service.
2. **Drizzle ORM / Kysely + migration tool.** Rejected for phase 1
   per plan §11.3. Revisit at phase 4 (entity CRUD).
3. **`better-sqlite3` via Node-compat.** Rejected: extra native
   build matrix, no clear benefit over `bun:sqlite` at our scale.
4. **DuckDB as the primary store.** Rejected: optimized for analytics,
   not the OLTP/event-log workload we have. May appear later for
   embedded reporting — orthogonal decision.

---

## Status

Accepted. No phase 1.x deliverable hit a SQLite limit. Re-evaluate at
phase 4 (entity CRUD) or phase 5 (scheduled tasks), whichever first
introduces multi-process writes.

## Follow-ups

- Phase 4 plan must decide whether to introduce a migration generator
  / ORM, or keep hand-rolling SQL. Reference this ADR in that decision.
- A Postgres compatibility test (run the same schema against a real
  Postgres in CI) is **not** worth it before phase 4; revisit then.
