/**
 * Phase 6.2 — LanceDB **write** surface for entity embeddings.
 *
 * Per ADR 0021 (proposed in 6.0), four per-kind tables hold one row
 * per indexed entity:
 *
 *   { id: string, layer_id: string, kind: string, slug: string,
 *     text: string, vector: Float32Array }
 *
 * `layer_id` is the auth_tag. The phase-7 read path will filter
 * `layer_id IN (?)` BEFORE the vector query so the corpus stays
 * authorization-aware (per `overall.md` §5 invariant 8). Phase 6
 * NEVER reads; this file is write-only.
 *
 * The four tables map to the four phase-4 entity kinds:
 *   - `entity_company`
 *   - `entity_contact`
 *   - `entity_calendar_event`
 *   - `entity_todo`
 *
 * The `LanceWriter` interface is the seam for tests. Production
 * wires it to a real `@lancedb/lancedb` connection; unit tests use
 * the in-memory `createInMemoryLanceWriter()` so they don't have
 * to spin up a real LanceDB on every run (the Lance native binary
 * is slow on macOS sandboxes and adds I/O flakiness to fast unit
 * tests).
 */

import type { LanceConnection } from '../../storage/lancedb';

/** Maps every phase-4 entity kind to its LanceDB table name. */
export const ENTITY_KIND_TO_LANCE_TABLE: Readonly<Record<string, string>> = Object.freeze({
  company: 'entity_company',
  contact: 'entity_contact',
  calendar_event: 'entity_calendar_event',
  todo: 'entity_todo',
});

export function getLanceTableForKind(kind: string): string | null {
  const table = ENTITY_KIND_TO_LANCE_TABLE[kind];
  return table ?? null;
}

export interface EmbeddingRow {
  readonly id: string;
  readonly layer_id: string;
  readonly kind: string;
  readonly slug: string;
  readonly text: string;
  readonly vector: Float32Array;
}

/**
 * Write-side seam. Implementations MUST be idempotent on `upsert` —
 * writing the same `id` twice yields exactly one logical row. The
 * subscriber depends on this so a replayed bus event does not
 * duplicate vectors.
 */
export interface LanceWriter {
  upsert(table: string, row: EmbeddingRow): Promise<void>;
  /** Removes the row with the given `id`. No-op when the row is absent. */
  removeById(table: string, id: string): Promise<void>;
  /** Test / ops helper — returns the current row for `id`, or `null`. */
  getById(table: string, id: string): Promise<EmbeddingRow | null>;
  /** Test / ops helper — count of rows in a table. Used by backfill progress. */
  countRows(table: string): Promise<number>;
}

/**
 * In-memory fixture for unit tests. Keeps rows in a nested Map so the
 * subscriber + backfill tests can assert on writes without booting
 * the Lance native binary. Production callers MUST NOT use this —
 * it is exported from `chat/embeddings/index.ts` only via a
 * `test-utils`-style path so the `index.ts` boot path stays on the
 * LanceDB-backed writer.
 */
export function createInMemoryLanceWriter(): LanceWriter {
  const tables = new Map<string, Map<string, EmbeddingRow>>();
  function bucket(table: string): Map<string, EmbeddingRow> {
    const existing = tables.get(table);
    if (existing !== undefined) return existing;
    const next = new Map<string, EmbeddingRow>();
    tables.set(table, next);
    return next;
  }
  return {
    async upsert(table, row) {
      bucket(table).set(row.id, row);
    },
    async removeById(table, id) {
      bucket(table).delete(id);
    },
    async getById(table, id) {
      return bucket(table).get(id) ?? null;
    },
    async countRows(table) {
      return bucket(table).size;
    },
  };
}

/**
 * Production LanceDB-backed writer.
 *
 * Table creation is lazy: the first `upsert` to a table creates it
 * with the row's schema. The plan does not require us to pre-create
 * tables (phase 6 is write-only; phase 7 will pre-create on a
 * `migrate` script if it ever needs cold-start indices). Until then,
 * lazy creation keeps cold-start zero-cost: a fresh deployment with
 * no entities has zero LanceDB files until the first entity is
 * embedded.
 *
 * Idempotency: `mergeInsert(['id']).whenMatchedUpdateAll()
 * .whenNotMatchedInsertAll().execute([row])`. A second call with the
 * same id and the same fields is a no-op transactionally.
 */
export function createLanceDbWriter(lance: LanceConnection): LanceWriter {
  const tableCache = new Map<string, Awaited<ReturnType<typeof lance.openTable>>>();

  async function getTable(name: string, sample: EmbeddingRow) {
    const cached = tableCache.get(name);
    if (cached !== undefined) return cached;
    const existing = await lance.tableNames();
    let table;
    if (existing.includes(name)) {
      table = await lance.openTable(name);
    } else {
      // First write to this kind. Create with a single-row schema so
      // the column types lock in correctly (LanceDB infers from the
      // sample). Subsequent writes through `mergeInsert` will update
      // this row.
      table = await lance.createTable(name, [embeddingRowToRecord(sample)]);
      tableCache.set(name, table);
      return table;
    }
    tableCache.set(name, table);
    return table;
  }

  return {
    async upsert(name, row) {
      const table = await getTable(name, row);
      await table
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute([embeddingRowToRecord(row)]);
    },
    async removeById(name, id) {
      // Cold path: if the table doesn't exist yet there is nothing
      // to delete. Touching `lance.tableNames()` keeps the writer
      // resilient to a row-removal arriving before any row was ever
      // written (a hot test fixture; not impossible in prod either).
      const existing = await lance.tableNames();
      if (!existing.includes(name)) return;
      const table = tableCache.get(name) ?? (await lance.openTable(name));
      tableCache.set(name, table);
      await table.delete(`id = '${sqlEscape(id)}'`);
    },
    async getById(name, id) {
      const existing = await lance.tableNames();
      if (!existing.includes(name)) return null;
      const table = tableCache.get(name) ?? (await lance.openTable(name));
      tableCache.set(name, table);
      const iter = table.query().where(`id = '${sqlEscape(id)}'`).limit(1);
      const rows: Array<Record<string, unknown>> = await iter.toArray();
      const first = rows[0];
      if (first === undefined) return null;
      return recordToEmbeddingRow(first);
    },
    async countRows(name) {
      const existing = await lance.tableNames();
      if (!existing.includes(name)) return 0;
      const table = tableCache.get(name) ?? (await lance.openTable(name));
      tableCache.set(name, table);
      return await table.countRows();
    },
  };
}

function embeddingRowToRecord(row: EmbeddingRow): Record<string, unknown> {
  return {
    id: row.id,
    layer_id: row.layer_id,
    kind: row.kind,
    slug: row.slug,
    text: row.text,
    // LanceDB's Arrow bridge accepts `Float32Array` or plain
    // `number[]` for fixed-size lists. Convert to a plain array so
    // schema inference picks `Float32` reliably across @lancedb
    // versions.
    vector: Array.from(row.vector),
  };
}

function recordToEmbeddingRow(rec: Record<string, unknown>): EmbeddingRow {
  const vectorRaw = rec['vector'];
  let vector: Float32Array;
  if (vectorRaw instanceof Float32Array) {
    vector = vectorRaw;
  } else if (Array.isArray(vectorRaw)) {
    vector = Float32Array.from(vectorRaw as readonly number[]);
  } else {
    vector = new Float32Array(0);
  }
  return {
    id: String(rec['id'] ?? ''),
    layer_id: String(rec['layer_id'] ?? ''),
    kind: String(rec['kind'] ?? ''),
    slug: String(rec['slug'] ?? ''),
    text: String(rec['text'] ?? ''),
    vector,
  };
}

/**
 * Escapes a single quote in an SQL string literal. The LanceDB
 * `where` clause accepts a SQL-like filter — `delete("id = 'x''y'")`.
 * Entity IDs are UUIDs in production so this is paranoia, but the
 * test fixture can use freeform ids.
 */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}
