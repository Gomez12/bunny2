/**
 * Phase 4d.2 — unit tests for the `createTodoModule` factory and the
 * empty `connectors?` slot.
 *
 * The §4.0 contract suite (`todos-contract.test.ts`) drives the real
 * `todoModule` against the real `todos` table; it does not touch the
 * connector registration path. This file covers the smaller surface
 * 4d.2 introduced:
 *
 *  1. `createTodoModule()` (no args) returns a module whose
 *     `connectors` field is `undefined` — matching how the registry's
 *     `rebuildConnectorIndex` treats "no bucket".
 *  2. `createTodoModule({ connectors: [stub] })` threads the array
 *     through verbatim. Same array reference is fine — the factory
 *     does not clone.
 *  3. With a connector-less module registered, `listConnectorsForKind('todo')`
 *     returns `[]`. This is the runtime invariant the connector
 *     runner / dispatcher relies on: a kind without connectors must
 *     iterate to nothing, not throw.
 *
 * No DB, no HTTP, no bus. The registry is process-local so we reset
 * it in `afterEach` to keep the tests isolated from
 * `todos-contract.test.ts` (which registers its own per-fixture
 * variant).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { TodoPayload } from '@bunny2/shared';
import {
  __resetEntityRegistryForTests,
  listConnectorsForKind,
  registerEntityModule,
} from '../../src/entities';
import type { EntityConnector } from '../../src/entities/connectors/base';
import { createTodoModule, TODO_KIND } from '../../src/entities/todos';

afterEach(() => {
  __resetEntityRegistryForTests();
});

/**
 * Minimal connector stub. Identity-stable so the threading assertion
 * can compare by reference. No `pull` / `push` / `ingest` is needed —
 * 4d.2 only exercises the SHAPE of the slot, not connector behaviour.
 */
function stubConnector(): EntityConnector<TodoPayload> {
  return {
    id: 'stub-todo-connector',
    kind: TODO_KIND,
    async verify() {
      return null;
    },
  };
}

describe('createTodoModule (phase 4d.2 connector placeholder)', () => {
  it('leaves `module.connectors` undefined when the option is omitted', () => {
    const module = createTodoModule();
    expect(module.connectors).toBeUndefined();
  });

  it('threads `opts.connectors` through to `module.connectors` verbatim', () => {
    const connector = stubConnector();
    const module = createTodoModule({ connectors: [connector] });
    expect(module.connectors).toBeDefined();
    expect(module.connectors).toHaveLength(1);
    // Same array entry reference — the factory does not clone.
    expect(module.connectors?.[0]).toBe(connector);
  });

  it("registry's listConnectorsForKind('todo') returns [] when no connectors are configured", () => {
    const module = createTodoModule();
    registerEntityModule(module);
    expect(listConnectorsForKind(TODO_KIND)).toEqual([]);
  });

  it("registry's listConnectorsForKind('todo') reflects the configured connector when present", () => {
    const connector = stubConnector();
    const module = createTodoModule({ connectors: [connector] });
    registerEntityModule(module);
    const registered = listConnectorsForKind(TODO_KIND);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe(connector);
  });
});
