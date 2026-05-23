import type { EntityModule } from './module';
import type { EntityConnector } from './connectors/base';

/**
 * Phase 4.0 — process-local registry of `EntityModule`s.
 *
 * Per-kind code (4a..4d) calls `registerEntityModule(module)` at boot.
 * The HTTP router factory reads the registry to mount per-kind routes;
 * the translator job iterates it to enqueue per-locale work; the phase-6
 * chat agent will look up modules by kind via `getEntityModule`.
 *
 * The registry is intentionally simple and process-local: no DB
 * persistence, no cross-process coordination. Bunny2 is single-writer
 * (ADR 0002 §single-process), so the in-memory map is authoritative.
 *
 * Tests reset the registry via `__resetEntityRegistryForTests()` — the
 * underscored name makes it clear that production code MUST NOT call it.
 */

const modulesByKind = new Map<string, EntityModule<unknown>>();

/**
 * Secondary index for `(kind, connectorId)` → `EntityConnector`. The
 * generic per-module connectors[] list is the authoritative source — we
 * just project it into a Map for O(1) router / runner / dispatcher
 * lookups. Rebuilt on every `registerEntityModule`.
 */
const connectorsByKind = new Map<string, Map<string, EntityConnector<unknown>>>();

function rebuildConnectorIndex(module: EntityModule<unknown>): void {
  if (module.connectors === undefined || module.connectors.length === 0) {
    connectorsByKind.delete(module.kind);
    return;
  }
  const seen = new Map<string, EntityConnector<unknown>>();
  for (const c of module.connectors) {
    const existing = seen.get(c.id);
    if (existing !== undefined && existing !== c) {
      throw new Error(`entity-registry: duplicate connector id '${c.id}' on kind '${module.kind}'`);
    }
    seen.set(c.id, c as EntityConnector<unknown>);
  }
  connectorsByKind.set(module.kind, seen);
}

/**
 * Registers a module. Throws if the kind is already registered — kinds
 * are global and must not collide. Use `__resetEntityRegistryForTests`
 * between test runs that build independent fixtures.
 */
export function registerEntityModule<Payload>(module: EntityModule<Payload>): void {
  const existing = modulesByKind.get(module.kind);
  if (existing !== undefined) {
    throw new Error(
      `entity-registry: kind '${module.kind}' is already registered. ` +
        `Pick a unique kind or reset the registry in tests.`,
    );
  }
  modulesByKind.set(module.kind, module as EntityModule<unknown>);
  rebuildConnectorIndex(module as EntityModule<unknown>);
}

/**
 * Looks up a module by kind. Returns `null` when no module is
 * registered. Callers that require a module (the HTTP router factory,
 * the chat agent) should throw on `null` — a missing module is a
 * programming error.
 */
export function getEntityModule(kind: string): EntityModule<unknown> | null {
  return modulesByKind.get(kind) ?? null;
}

/** Enumerates every registered kind. Order is registration order. */
export function listEntityKinds(): readonly string[] {
  return Array.from(modulesByKind.keys());
}

/** Enumerates every registered module. Order is registration order. */
export function listEntityModules(): readonly EntityModule<unknown>[] {
  return Array.from(modulesByKind.values());
}

/**
 * Looks up a single connector by `(kind, connectorId)`. Returns `null`
 * when either the kind is unknown or the kind has no connector with
 * that id. The HTTP router uses this to validate a `body.connector`
 * field against the registered set; the dispatcher / runner use it to
 * resolve the connector for an outstanding external link.
 */
export function getConnector(kind: string, connectorId: string): EntityConnector<unknown> | null {
  const bucket = connectorsByKind.get(kind);
  if (bucket === undefined) return null;
  return bucket.get(connectorId) ?? null;
}

/**
 * Enumerates every connector registered for `kind`. Order matches the
 * order in `EntityModule.connectors[]` (insertion order on the
 * registration call). The poll runner iterates this set per tick.
 */
export function listConnectorsForKind(kind: string): readonly EntityConnector<unknown>[] {
  const bucket = connectorsByKind.get(kind);
  if (bucket === undefined) return [];
  return Array.from(bucket.values());
}

/**
 * Test-only escape hatch. Production code MUST NOT call this — the
 * registry is process-local state that survives the lifetime of the
 * server. Tests that register fixture modules call this in their
 * teardown to keep registrations isolated.
 */
export function __resetEntityRegistryForTests(): void {
  modulesByKind.clear();
  connectorsByKind.clear();
}
