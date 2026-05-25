import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type {
  Entity,
  EntityExternalLink,
  EntityMeta,
  EntityRef,
  EntitySummary,
} from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { EntityIndexedColumn, EntityModule, EntitySummaryColumnRow } from './module';
import {
  ENTITY_EVENT_TYPES,
  entityEventType,
  type EntityCreatedPayload,
  type EntityDeletedPayload,
  type EntityRestoredPayload,
  type EntityTranslationCompletedPayload,
  type EntityUpdatedPayload,
} from './events';
import {
  insertExternalLink as repoInsertExternalLink,
  listExternalLinks as repoListExternalLinks,
  removeExternalLink as repoRemoveExternalLink,
} from './connectors/base';

/**
 * Phase 4.0 — generic store the per-kind HTTP router and per-kind tests
 * sit on top of. One factory per kind: it captures the `EntityModule`
 * and the `tableName` and exposes CRUD + summary listing + summary
 * search + soft-delete + restore.
 *
 * The store writes to BOTH the per-kind table (`tableName` from the
 * module — payload, denormalized title, indexable columns) AND the
 * shared cross-cutting tables (`entity_versions`, `entity_translations`,
 * `entity_external_links`). Per-kind code never touches the shared
 * tables directly.
 *
 * Every mutation:
 *  - is wrapped in a single SQLite transaction;
 *  - bumps the per-row `version` and writes a snapshot row to
 *    `entity_versions`;
 *  - publishes one `entity.<kind>.<action>` event AFTER the tx commits
 *    (same lock-discipline as the layers route — see
 *    `apps/server/src/http/routes/layers.ts` §POST /layers comment);
 *  - invokes the matching `EntityModule` lifecycle hook (if any) AFTER
 *    publish.
 */
export interface EntityStore<Payload> {
  create(input: EntityCreateInput<Payload>): Promise<Entity<Payload>>;
  update(input: EntityUpdateInput<Payload>): Promise<Entity<Payload>>;
  softDelete(input: EntityMutationInput): Promise<Entity<Payload>>;
  restore(input: EntityMutationInput): Promise<Entity<Payload>>;
  getById(id: string): Entity<Payload> | null;
  getBySlug(layerId: string, slug: string): Entity<Payload> | null;
  listSummaries(layerIds: readonly string[], opts?: ListSummariesOptions): readonly EntitySummary[];
  searchSummaries(
    layerIds: readonly string[],
    query: string,
    opts?: SearchSummariesOptions,
  ): readonly EntitySummary[];
  addExternalLink(input: AddExternalLinkInput): EntityExternalLink;
  removeExternalLink(linkId: string): void;
  recordTranslation(input: RecordTranslationInput<Payload>): Promise<void>;
}

export interface EntityCreateInput<Payload> {
  readonly id?: string;
  readonly layerId: string;
  readonly slug?: string;
  readonly title: string;
  readonly originalLocale: string;
  readonly payload: Payload;
  readonly actorId: string;
  readonly now?: Date;
  readonly correlationId?: string;
}

export interface EntityUpdateInput<Payload> {
  readonly id: string;
  readonly title?: string;
  readonly payload: Payload;
  readonly actorId: string;
  readonly now?: Date;
  readonly correlationId?: string;
}

export interface EntityMutationInput {
  readonly id: string;
  readonly actorId: string;
  readonly now?: Date;
  readonly correlationId?: string;
}

export interface ListSummariesOptions {
  readonly includeDeleted?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  /**
   * Inclusive lower bound on the module's declared `timeColumn`.
   * Ignored when the module does not declare a `timeColumn`. ISO-8601
   * string compare (lexicographic, sound for the ISO shape the
   * column stores). Caller validates the format — the store assumes
   * the value is already an ISO-8601 string.
   */
  readonly from?: string;
  /** Inclusive upper bound on the module's declared `timeColumn`. */
  readonly to?: string;
}

export interface SearchSummariesOptions extends ListSummariesOptions {
  /** Maximum substrings to match per row. Limits regex blow-up. */
  readonly limit?: number;
}

export interface AddExternalLinkInput {
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly now?: Date;
}

export interface RecordTranslationInput<Payload> {
  readonly ref: EntityRef;
  readonly locale: string;
  readonly sourceVersion: number;
  readonly payload: Payload;
  readonly latencyMs: number;
  readonly now?: Date;
  readonly correlationId?: string;
}

export interface CreateEntityStoreDeps<Payload> {
  readonly module: EntityModule<Payload>;
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Row shape every per-kind table follows (mirrors §5 in the phase-4 plan).
// ---------------------------------------------------------------------------

interface KindRow {
  id: string;
  layer_id: string;
  slug: string;
  title: string;
  searchable_text: string;
  original_locale: string;
  payload_json: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
  version: number;
}

/**
 * Type of a single indexed-column value handed to `bun:sqlite`. SQLite
 * stores strings, numbers, and `null` natively; the per-kind module's
 * `extract` callback projects payload data into this space.
 */
type IndexedValue = string | number | null;

/**
 * Tuple shape for the prepared insert statement: 11 fixed columns + N
 * dynamic indexed columns. `bun:sqlite`'s typed `query<R, P>` binds the
 * parameter shape; using the generic array form keeps the type stable
 * regardless of how many indexed columns a module declares.
 */
type IndexedSqlArgs = IndexedValue[];

/**
 * Helper for `exactOptionalPropertyTypes`: only includes `correlationId`
 * when it is defined. Spreading `undefined` would be a type error and
 * also a runtime no-op, so this is purely shape-driven.
 */
function withCorrelation(correlationId: string | undefined): { readonly correlationId?: string } {
  return correlationId === undefined ? {} : { correlationId };
}

// ---------------------------------------------------------------------------

export function createEntityStore<Payload>(
  deps: CreateEntityStoreDeps<Payload>,
): EntityStore<Payload> {
  const { module, db, bus, llm } = deps;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.idFactory ?? (() => crypto.randomUUID());
  const t = module.tableName;
  const identRe = /^[a-z_][a-z0-9_]*$/;

  // The SQL strings are interpolated ONCE per factory call. `tableName`
  // comes from the module (registered in code, not from user input) so
  // there is no injection surface — but we still validate the shape to
  // catch typos at boot, not at first request.
  if (!identRe.test(t)) {
    throw new Error(`entity-store: invalid tableName '${t}' for kind '${module.kind}'`);
  }

  // Per-kind indexed columns. The store writes the value returned by
  // `extract(payload)` into the named column on every insert/update,
  // alongside the JSON payload. `name` is interpolated into SQL, so we
  // validate the shape at boot — same treatment as `tableName`.
  const indexed: readonly EntityIndexedColumn<Payload>[] = module.indexedColumns ?? [];
  const indexedNames = indexed.map((c) => c.name);
  for (const name of indexedNames) {
    if (!identRe.test(name)) {
      throw new Error(`entity-store: invalid indexed column '${name}' for kind '${module.kind}'`);
    }
  }
  const reservedColumns = new Set([
    'id',
    'layer_id',
    'slug',
    'title',
    'searchable_text',
    'original_locale',
    'payload_json',
    'created_at',
    'created_by',
    'updated_at',
    'updated_by',
    'deleted_at',
    'deleted_by',
    'version',
  ]);
  for (const name of indexedNames) {
    if (reservedColumns.has(name)) {
      throw new Error(
        `entity-store: indexed column '${name}' for kind '${module.kind}' collides with a reserved column`,
      );
    }
  }
  // Detect duplicates inside `indexedColumns` itself — easier to spot
  // here than from a confusing SQLite "duplicate column" error later.
  if (new Set(indexedNames).size !== indexedNames.length) {
    throw new Error(`entity-store: duplicate indexed column names for kind '${module.kind}'`);
  }

  // Optional `timeColumn` for the §4.0 `?from=&to=` list range filter
  // (added in the calendar-list-range-filter follow-up). Must name one
  // of the indexed columns — a range filter on an unindexed column
  // would be a foot-gun once a table grows. Validated at boot so a
  // typo fails the process, not the first request.
  const timeColumn = module.timeColumn;
  if (timeColumn !== undefined) {
    if (!identRe.test(timeColumn)) {
      throw new Error(`entity-store: invalid timeColumn '${timeColumn}' for kind '${module.kind}'`);
    }
    if (!indexedNames.includes(timeColumn)) {
      throw new Error(
        `entity-store: timeColumn '${timeColumn}' for kind '${module.kind}' is not in indexedColumns`,
      );
    }
  }

  const selectCols =
    'id, layer_id, slug, title, searchable_text, original_locale, payload_json, ' +
    'created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, version';

  const insertExtraCols = indexedNames.map((n) => `, ${n}`).join('');
  const insertExtraPlaceholders = indexedNames.map(() => ', ?').join('');
  const insertRow = db.query<unknown, IndexedSqlArgs>(
    `INSERT INTO ${t}
       (id, layer_id, slug, title, searchable_text, original_locale,
        payload_json, created_at, created_by, updated_at, updated_by${insertExtraCols})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${insertExtraPlaceholders})`,
  );

  function extractIndexedValues(payload: Payload): IndexedValue[] {
    return indexed.map((col) => col.extract(payload));
  }

  const selectById = db.query<KindRow, [string]>(`SELECT ${selectCols} FROM ${t} WHERE id = ?`);
  const selectBySlug = db.query<KindRow, [string, string]>(
    `SELECT ${selectCols} FROM ${t} WHERE layer_id = ? AND slug = ?`,
  );

  const insertVersion = db.query<
    unknown,
    [string, string, string, number, string, string, string, string]
  >(
    `INSERT INTO entity_versions
       (id, entity_id, entity_kind, version, payload_json, meta_json,
        created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function rowToEntity(row: KindRow): Entity<Payload> {
    const ref: EntityRef = {
      id: row.id,
      kind: module.kind,
      layerId: row.layer_id,
      slug: row.slug,
    };
    const meta: EntityMeta = {
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      version: row.version,
      originalLocale: row.original_locale,
    };
    let payload: Payload;
    try {
      payload = JSON.parse(row.payload_json) as Payload;
    } catch {
      throw new Error(
        `entity-store: corrupt payload_json on ${module.kind} id=${row.id} — manual repair needed`,
      );
    }
    const summary = module.toSummary({ ref, meta, payload, title: row.title });
    // Only fetch the soul row when the module declares summary
    // columns — avoids a needless lookup on every detail/edit fetch
    // for kinds that don't project enrichment-recency.
    const soulUpdatedAt =
      module.summaryColumns !== undefined && module.summaryColumns.length > 0
        ? (fetchSoulUpdatedAt([row.id]).get(row.id) ?? null)
        : null;
    const summaryWithExtras = applyExtras(summary, payload, row, soulUpdatedAt);
    const externalLinks = repoListExternalLinks(db, { entityId: row.id, kind: module.kind });
    return {
      ...summaryWithExtras,
      payload,
      externalLinks,
    };
  }

  function rowToSummary(row: KindRow, soulUpdatedAt: string | null = null): EntitySummary {
    const ref: EntityRef = {
      id: row.id,
      kind: module.kind,
      layerId: row.layer_id,
      slug: row.slug,
    };
    const meta: EntityMeta = {
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      version: row.version,
      originalLocale: row.original_locale,
    };
    let payload: Payload;
    try {
      payload = JSON.parse(row.payload_json) as Payload;
    } catch {
      throw new Error(
        `entity-store: corrupt payload_json on ${module.kind} id=${row.id} — manual repair needed`,
      );
    }
    const base = module.toSummary({ ref, meta, payload, title: row.title });
    return applyExtras(base, payload, row, soulUpdatedAt);
  }

  /**
   * Batch-aware variant of `rowToSummary` for list / search paths.
   * One soul-lookup query for the whole listing when the module
   * declares `summaryColumns`; otherwise no extra IO.
   */
  function rowsToSummaries(rows: readonly KindRow[]): EntitySummary[] {
    if (rows.length === 0) return [];
    const hasSummaryColumns =
      module.summaryColumns !== undefined && module.summaryColumns.length > 0;
    if (!hasSummaryColumns) return rows.map((r) => rowToSummary(r));
    const souls = fetchSoulUpdatedAt(rows.map((r) => r.id));
    return rows.map((r) => rowToSummary(r, souls.get(r.id) ?? null));
  }

  /**
   * Evaluate the module's `summaryColumns` (if any) against the row's
   * payload + audit metadata and merge the result into the summary's
   * `extras` field. Modules without `summaryColumns` get the bare
   * summary; the field stays absent on the wire — the web client
   * treats absence as an empty object.
   *
   * Added in the companies-list-columns follow-up.
   */
  function applyExtras(
    summary: EntitySummary,
    payload: Payload,
    row: KindRow,
    soulUpdatedAt: string | null,
  ): EntitySummary {
    const summaryColumns = module.summaryColumns;
    if (summaryColumns === undefined || summaryColumns.length === 0) return summary;
    const projectionRow: EntitySummaryColumnRow = {
      id: row.id,
      layerId: row.layer_id,
      slug: row.slug,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      version: row.version,
      soulUpdatedAt,
    };
    const extras: Record<string, unknown> = {};
    for (const col of summaryColumns) {
      extras[col.id] = col.project(payload, projectionRow);
    }
    return { ...summary, extras };
  }

  /**
   * Batch-fetch `entity_souls.updated_at` for a set of entity ids in
   * one query. Returns a Map keyed by entity id — missing entries
   * mean "no soul row yet" (no enrichment has written for that
   * entity). Used by `applyExtras` so per-row projections can decide
   * "was this row recently enriched?" without an N+1 lookup.
   */
  function fetchSoulUpdatedAt(entityIds: readonly string[]): Map<string, string> {
    if (entityIds.length === 0) return new Map();
    const placeholders = entityIds.map(() => '?').join(', ');
    const rows = db
      .query<{ entity_id: string; updated_at: string }, string[]>(
        `SELECT entity_id, updated_at FROM entity_souls
          WHERE entity_kind = ? AND entity_id IN (${placeholders})`,
      )
      .all(module.kind, ...entityIds);
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.entity_id, r.updated_at);
    return out;
  }

  function metaForVersionLog(row: KindRow): string {
    return JSON.stringify({
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      deletedBy: row.deleted_by,
      originalLocale: row.original_locale,
      title: row.title,
      searchableText: row.searchable_text,
      slug: row.slug,
      layerId: row.layer_id,
    });
  }

  async function publishLifecycle(
    action: 'created' | 'updated' | 'deleted' | 'restored',
    row: KindRow,
    extras: {
      readonly previousVersion?: number;
      readonly deletedBy?: string;
      readonly correlationId?: string;
    } = {},
  ): Promise<void> {
    const ref: EntityRef = {
      id: row.id,
      kind: module.kind,
      layerId: row.layer_id,
      slug: row.slug,
    };
    const type = entityEventType(module.kind, action);
    const corr = withCorrelation(extras.correlationId);
    if (action === 'created') {
      const payload: EntityCreatedPayload = {
        ref,
        version: row.version,
        originalLocale: row.original_locale,
        searchableText: row.searchable_text,
      };
      await bus.publish({ type, payload, ...corr });
    } else if (action === 'updated') {
      const payload: EntityUpdatedPayload = {
        ref,
        version: row.version,
        previousVersion: extras.previousVersion ?? row.version - 1,
        searchableText: row.searchable_text,
      };
      await bus.publish({ type, payload, ...corr });
    } else if (action === 'deleted') {
      const payload: EntityDeletedPayload = {
        ref,
        version: row.version,
        deletedBy: extras.deletedBy ?? row.deleted_by ?? row.updated_by,
      };
      await bus.publish({ type, payload, ...corr });
    } else {
      const payload: EntityRestoredPayload = { ref, version: row.version };
      await bus.publish({ type, payload, ...corr });
    }
  }

  async function runLifecycleHook(
    hook: EntityModule<Payload>['onCreate'],
    row: KindRow,
  ): Promise<void> {
    if (hook === undefined) return;
    const entity = rowToEntity(row);
    await hook({
      ref: entity,
      meta: entity.meta,
      payload: entity.payload,
      db,
      bus,
      llm,
    });
  }

  return {
    async create(input) {
      const id = input.id ?? newId();
      const slug = input.slug ?? id;
      const nowIso = (input.now ?? clock()).toISOString();
      const payloadJson = JSON.stringify(input.payload);
      const searchableText = module.searchableText(input.payload);

      const extraValues = extractIndexedValues(input.payload);
      const tx = db.transaction(() => {
        insertRow.run(
          id,
          input.layerId,
          slug,
          input.title,
          searchableText,
          input.originalLocale,
          payloadJson,
          nowIso,
          input.actorId,
          nowIso,
          input.actorId,
          ...extraValues,
        );
        const row = selectById.get(id);
        if (row === null) {
          throw new Error(`entity-store: failed to read back ${module.kind} ${id} after insert`);
        }
        insertVersion.run(
          newId(),
          row.id,
          module.kind,
          row.version,
          payloadJson,
          metaForVersionLog(row),
          nowIso,
          input.actorId,
        );
        return row;
      });
      const row = tx();

      await publishLifecycle('created', row, withCorrelation(input.correlationId));
      await runLifecycleHook(module.onCreate, row);

      return rowToEntity(row);
    },

    async update(input) {
      const nowIso = (input.now ?? clock()).toISOString();
      const payloadJson = JSON.stringify(input.payload);
      const searchableText = module.searchableText(input.payload);

      const before = selectById.get(input.id);
      if (before === null) {
        throw new Error(`entity-store: ${module.kind} ${input.id} not found`);
      }
      const previousVersion = before.version;
      const title = input.title ?? before.title;

      const updateExtraSet = indexedNames.map((n) => `, ${n} = ?`).join('');
      const updateStmt = db.query<unknown, IndexedSqlArgs>(
        `UPDATE ${t}
            SET title = ?, searchable_text = ?, payload_json = ?,
                updated_at = ?, updated_by = ?, version = version + 1${updateExtraSet}
          WHERE id = ?`,
      );
      const extraValues = extractIndexedValues(input.payload);
      const writeAndLog = db.transaction(() => {
        updateStmt.run(
          title,
          searchableText,
          payloadJson,
          nowIso,
          input.actorId,
          ...extraValues,
          input.id,
        );
        const row = selectById.get(input.id);
        if (row === null) {
          throw new Error(`entity-store: ${module.kind} ${input.id} missing after update`);
        }
        insertVersion.run(
          newId(),
          row.id,
          module.kind,
          row.version,
          payloadJson,
          metaForVersionLog(row),
          nowIso,
          input.actorId,
        );
        return row;
      });
      const row = writeAndLog();

      await publishLifecycle('updated', row, {
        previousVersion,
        ...withCorrelation(input.correlationId),
      });
      await runLifecycleHook(module.onUpdate, row);

      return rowToEntity(row);
    },

    async softDelete(input) {
      const nowIso = (input.now ?? clock()).toISOString();
      const before = selectById.get(input.id);
      if (before === null) {
        throw new Error(`entity-store: ${module.kind} ${input.id} not found`);
      }
      if (before.deleted_at !== null) {
        return rowToEntity(before);
      }
      const tx = db.transaction(() => {
        db.query<unknown, [string, string, string, string, string]>(
          `UPDATE ${t}
              SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ?,
                  version = version + 1
            WHERE id = ? AND deleted_at IS NULL`,
        ).run(nowIso, input.actorId, nowIso, input.actorId, input.id);
        const row = selectById.get(input.id);
        if (row === null) {
          throw new Error(`entity-store: ${module.kind} ${input.id} missing after soft-delete`);
        }
        insertVersion.run(
          newId(),
          row.id,
          module.kind,
          row.version,
          row.payload_json,
          metaForVersionLog(row),
          nowIso,
          input.actorId,
        );
        return row;
      });
      const row = tx();

      await publishLifecycle('deleted', row, {
        deletedBy: input.actorId,
        ...withCorrelation(input.correlationId),
      });
      await runLifecycleHook(module.onSoftDelete, row);

      return rowToEntity(row);
    },

    async restore(input) {
      const nowIso = (input.now ?? clock()).toISOString();
      const before = selectById.get(input.id);
      if (before === null) {
        throw new Error(`entity-store: ${module.kind} ${input.id} not found`);
      }
      if (before.deleted_at === null) {
        return rowToEntity(before);
      }
      const tx = db.transaction(() => {
        db.query<unknown, [string, string, string]>(
          `UPDATE ${t}
              SET deleted_at = NULL, deleted_by = NULL, updated_at = ?, updated_by = ?,
                  version = version + 1
            WHERE id = ?`,
        ).run(nowIso, input.actorId, input.id);
        const row = selectById.get(input.id);
        if (row === null) {
          throw new Error(`entity-store: ${module.kind} ${input.id} missing after restore`);
        }
        insertVersion.run(
          newId(),
          row.id,
          module.kind,
          row.version,
          row.payload_json,
          metaForVersionLog(row),
          nowIso,
          input.actorId,
        );
        return row;
      });
      const row = tx();

      await publishLifecycle('restored', row, withCorrelation(input.correlationId));
      await runLifecycleHook(module.onRestore, row);

      return rowToEntity(row);
    },

    getById(id) {
      const row = selectById.get(id);
      return row === null ? null : rowToEntity(row);
    },

    getBySlug(layerId, slug) {
      const row = selectBySlug.get(layerId, slug);
      return row === null ? null : rowToEntity(row);
    },

    listSummaries(layerIds, opts = {}) {
      if (layerIds.length === 0) return [];
      const placeholders = layerIds.map(() => '?').join(', ');
      const conditions = [`layer_id IN (${placeholders})`];
      if (opts.includeDeleted !== true) {
        conditions.push('deleted_at IS NULL');
      }
      // `?from=&to=` range filter. Honored ONLY when the module
      // declares a `timeColumn`; modules without it ignore the
      // bounds entirely so the contract stays opt-in (the kind has
      // no time axis to filter on). Bounds are inclusive on both
      // sides — same closed-interval shape `react-big-calendar`'s
      // visible range produces.
      const timeArgs: string[] = [];
      if (timeColumn !== undefined) {
        if (opts.from !== undefined) {
          conditions.push(`${timeColumn} >= ?`);
          timeArgs.push(opts.from);
        }
        if (opts.to !== undefined) {
          conditions.push(`${timeColumn} <= ?`);
          timeArgs.push(opts.to);
        }
      }
      const limit = opts.limit ?? 200;
      const offset = opts.offset ?? 0;
      const sql =
        `SELECT ${selectCols} FROM ${t} WHERE ${conditions.join(' AND ')} ` +
        `ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      const stmt = db.query<KindRow, (string | number)[]>(sql);
      const rows = stmt.all(...layerIds, ...timeArgs, limit, offset);
      return rowsToSummaries(rows);
    },

    searchSummaries(layerIds, query, opts = {}) {
      if (layerIds.length === 0 || query === '') return [];
      const placeholders = layerIds.map(() => '?').join(', ');
      const conditions = [`layer_id IN (${placeholders})`];
      if (opts.includeDeleted !== true) {
        conditions.push('deleted_at IS NULL');
      }
      conditions.push('(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)');
      const limit = opts.limit ?? 50;
      const needle = `%${query.toLowerCase()}%`;
      const sql =
        `SELECT ${selectCols} FROM ${t} WHERE ${conditions.join(' AND ')} ` +
        `ORDER BY updated_at DESC LIMIT ?`;
      const stmt = db.query<KindRow, (string | number)[]>(sql);
      const rows = stmt.all(...layerIds, needle, needle, limit);
      return rowsToSummaries(rows);
    },

    addExternalLink(input) {
      const nowIso = (input.now ?? clock()).toISOString();
      return repoInsertExternalLink(db, {
        id: newId(),
        ref: input.ref,
        connector: input.connector,
        externalId: input.externalId,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        now: nowIso,
      });
    },

    removeExternalLink(linkId) {
      repoRemoveExternalLink(db, linkId);
    },

    async recordTranslation(input) {
      const nowIso = (input.now ?? clock()).toISOString();
      const payloadJson = JSON.stringify(input.payload);
      db.query<unknown, [string, string, string, string, number, string, string]>(
        `INSERT INTO entity_translations
           (entity_id, entity_kind, locale, payload_json, source_version,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id, locale) DO UPDATE SET
           payload_json = excluded.payload_json,
           source_version = excluded.source_version,
           updated_at = excluded.updated_at`,
      ).run(
        input.ref.id,
        module.kind,
        input.locale,
        payloadJson,
        input.sourceVersion,
        nowIso,
        nowIso,
      );
      const completed: EntityTranslationCompletedPayload = {
        ref: input.ref,
        locale: input.locale,
        sourceVersion: input.sourceVersion,
        latencyMs: input.latencyMs,
      };
      await bus.publish({
        type: ENTITY_EVENT_TYPES.TranslationCompleted,
        payload: completed,
        ...withCorrelation(input.correlationId),
      });
    },
  };
}
