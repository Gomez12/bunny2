# Risk — SQLite → Postgres migration pain

- Status: low likelihood; mitigated by schema discipline
- Owner / area: storage (`apps/server/src/storage/`,
  `apps/server/src/storage/migrations/`)
- Related: `docs/dev/plans/overall.md` §3 (non-goals: Postgres
  on day one), §8 ("Later"), §9 (risk row 7);
  ADR [`0002`](../decisions/0002-sqlite-first-postgres-later.md);
  placeholder plan
  [`docs/dev/plans/phase-XX-postgres-option.md`](../plans/phase-XX-postgres-option.md)
  (tasklist row only; doc not yet authored — see
  "Mitigation gaps" below).

---

## Description

ADR 0002 fixes SQLite as the primary store for phase 1, with the
schema rules designed to keep a future Postgres migration cheap.
The risk: drift between intent and code. Each migration is a
chance to silently introduce something SQLite-only — a
`JSON1`-only function in a WHERE clause, `WITHOUT ROWID`, a
`STRICT` table — that compiles fine on `bun:sqlite` but breaks
the Postgres translation later.

Three concrete drift modes:

1. **SQLite-only SQL slips into a migration.** No automated
   check today flags `json_extract(...)` in a WHERE clause, an
   `AUTOINCREMENT`-as-id, or a SQLite-style `INSERT OR REPLACE`.
2. **Code reaches into `bun:sqlite` APIs that don't have a
   Postgres analogue.** `db.run(...)` returning a `lastInsertRowid`
   integer, `pragma`-tuned reads, the synchronous query API
   shape.
3. **`events` / `bus_outbox` / `llm_calls` shape.** The phase
   5 durable bus and the phase 1 telemetry table both keep JSON
   blobs as `TEXT` and parse in code — Postgres-portable by
   ADR 0002 §4. A future "let's index that JSON" optimisation
   that uses `json_each` on a SQLite expression-index would
   bind us; the same query on Postgres would be a `JSONB GIN`
   index.

A Postgres switch becomes interesting when **any one** of:

1. **Multi-process write contention** — already partially in
   play: phase 5 split `--role=web` / `--role=worker` /
   `--role=all` against the same SQLite file. WAL + the durable
   bus's claim/lease design currently absorb this; a heavier
   workload (more worker hosts, real concurrent writers) flips
   the calculus.
2. **Federation** — multiple servers per overall §"Later"; needs
   a backing store reachable from multiple hosts.
3. **A specific Postgres feature is genuinely needed** — `JSONB`
   indexing, `GIN` / `GiST`, partitioning, replication.

## Impact

Medium. Not user-visible at first; entirely operator/maintainer
cost. A "ten new migrations from now" Postgres switch could
take days if drift compounds; a "switch on first need with
clean schema" can be a few hours of test runs and a dialect
translator.

## Likelihood

Low. The constraints are documented (ADR 0002 §4); recent
phases (5–8) have respected them — no `JSON1`-only WHERE
clauses, JSON stored as `TEXT`, UUIDs as `TEXT`, timestamps as
ISO-8601 `TEXT`, foreign keys on, WAL mode on. The risk binds
gradually as the schema grows.

## Mitigation

### Schema discipline (ADR 0002 §4)

1. **No SQLite-only SQL.** No `WITHOUT ROWID`, no `STRICT`
   tables, no `JSON1`-only functions in WHERE clauses. JSON
   columns are `TEXT` and parsed in code (`bus_outbox.payload_json`,
   `llm_calls.request` / `response`, `entity_translations`
   payload columns all follow this).
2. **UUIDs as `TEXT`.** Postgres has native `uuid`; the
   migration is a column-type change only.
3. **Timestamps as ISO-8601 `TEXT`.** Avoids SQLite's
   `REAL` julian-date footgun; ports cleanly to Postgres
   `timestamptz`.
4. **Foreign keys on.** `PRAGMA foreign_keys = ON` at every
   `openDatabase()`. Postgres-style integrity from day one.
5. **WAL mode.** `PRAGMA journal_mode = WAL` — no
   reader-blocks-writer surprises that would mask
   contention until the Postgres day arrives.

### Localized blast radius

6. **All `bun:sqlite` calls live under
   `apps/server/src/storage/`** plus a handful of repository
   files that import `Database` from `bun:sqlite`. The
   durable-bus adapter (`packages/bus/src/adapters/durable-sqlite.ts`)
   is the other concentration. Both are small enough that a
   swap is "rewrite these files" rather than "audit the entire
   codebase".
7. **Hand-rolled migration runner.**
   `apps/server/src/storage/migrations.ts` reads
   `migrations/<NNNN>_<name>.sql` and tracks applied ids in
   `schema_migrations`. A dialect translator runs the same
   files against Postgres; no ORM-generated schema to reverse.

### Test surface

8. **Per-test fresh DB.** Every storage test gets
   `openDatabase(mkdtempSync(...))` in under a millisecond. A
   Postgres compatibility test would run the same schema +
   contract tests against a real Postgres instance — cheap to
   wire when needed.

## Mitigation gaps

1. **No lint that rejects SQLite-only SQL.** A reviewer reading
   a migration is the only check today. ADR 0002 §"Follow-ups"
   left this to the phase-4-or-later "do we add a schema
   linter / ORM?" question.
2. **No CI Postgres compatibility job.** Explicitly deferred by
   ADR 0002 §"Follow-ups" until at least phase 4 (entity CRUD).
   The deferral still stands; revisit at phase XX (postgres
   option) when the migration is actually on the table.
3. **`docs/dev/plans/phase-XX-postgres-option.md` does not yet
   exist** as a real plan, only as a tasklist row pointing to
   that path. The plan should be authored when (a) one of the
   "interesting" triggers above hits, or (b) `docs:check`
   starts to fail on the missing path.

## What would invalidate the mitigation

- A migration that uses `json_extract(...)` in a WHERE clause or
  in a CREATE INDEX expression.
- A migration with `WITHOUT ROWID` or `STRICT` tables.
- Code that depends on `bun:sqlite`'s synchronous query API
  shape outside `apps/server/src/storage/`.
- An ORM ship (drizzle, kysely) that hides the dialect from
  the migration files — ADR 0002 explicitly left this open for
  phase 4 but the trade-off changes once an ORM owns the
  generated SQL.
