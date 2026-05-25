/**
 * Phase 11.2 — unit tests for the `createWhiteboardModule` factory and
 * the empty `connectors?` slot.
 *
 * The §11.1 contract suite (`whiteboards-contract.test.ts`) drives the
 * real `whiteboardModule` against the real `whiteboards` table; it does
 * not touch the connector registration path. This file covers the
 * smaller surface 11.2 introduces:
 *
 *  1. `createWhiteboardModule()` (no args) returns a module whose
 *     `connectors` field is `undefined` — matching how the registry's
 *     `rebuildConnectorIndex` treats "no bucket".
 *  2. `createWhiteboardModule({ connectors: [placeholder] })` threads
 *     the array through verbatim (same array entry reference — the
 *     factory does not clone).
 *  3. With a connector-less module registered,
 *     `listConnectorsForKind('whiteboard')` returns `[]`. This is the
 *     runtime invariant the dispatcher / runner relies on: a kind
 *     without connectors must iterate to nothing, not throw.
 *  4. `whiteboardPlaceholderConnector.verify(...)` returns the
 *     canonical `errors.connectors.notConfigured` i18n key. Mirrors
 *     the "notConfigured" canary pattern surfaced by the dispatcher
 *     when no attachment exists for a connector.
 *
 * Mirrors `todos-module.test.ts` exactly — same registry-reset pattern,
 * same minimal stub-connector helper for the threading assertion. No
 * DB, no HTTP, no bus.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { WhiteboardPayload } from '@bunny2/shared';
import {
  __resetEntityRegistryForTests,
  listConnectorsForKind,
  registerEntityModule,
} from '../../src/entities';
import type { EntityConnector } from '../../src/entities/connectors/base';
import {
  createWhiteboardModule,
  WHITEBOARD_KIND,
  whiteboardPlaceholderConnector,
  WHITEBOARD_PLACEHOLDER_CONNECTOR_ID,
  WHITEBOARD_PLACEHOLDER_NOT_CONFIGURED_KEY,
} from '../../src/entities/whiteboards';

afterEach(() => {
  __resetEntityRegistryForTests();
});

/**
 * Minimal connector stub. Identity-stable so the threading assertion
 * can compare by reference. No `pull` / `push` / `ingest` is needed —
 * 11.2 only exercises the SHAPE of the slot, not connector behaviour.
 */
function stubConnector(): EntityConnector<WhiteboardPayload> {
  return {
    id: 'stub-whiteboard-connector',
    kind: WHITEBOARD_KIND,
    async verify() {
      return null;
    },
  };
}

describe('createWhiteboardModule (phase 11.2 connector placeholder)', () => {
  it('leaves `module.connectors` undefined when the option is omitted', () => {
    const module = createWhiteboardModule();
    expect(module.connectors).toBeUndefined();
  });

  it('threads `opts.connectors` through to `module.connectors` verbatim', () => {
    const connector = stubConnector();
    const module = createWhiteboardModule({ connectors: [connector] });
    expect(module.connectors).toBeDefined();
    expect(module.connectors).toHaveLength(1);
    // Same array entry reference — the factory does not clone.
    expect(module.connectors?.[0]).toBe(connector);
  });

  it("registry's listConnectorsForKind('whiteboard') returns [] when no connectors are configured", () => {
    const module = createWhiteboardModule();
    registerEntityModule(module);
    expect(listConnectorsForKind(WHITEBOARD_KIND)).toEqual([]);
  });

  it("registry's listConnectorsForKind('whiteboard') reflects the placeholder when injected", () => {
    const module = createWhiteboardModule({ connectors: [whiteboardPlaceholderConnector] });
    registerEntityModule(module);
    const registered = listConnectorsForKind(WHITEBOARD_KIND);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe(whiteboardPlaceholderConnector);
  });
});

describe('whiteboardPlaceholderConnector (phase 11.2)', () => {
  it('identifies itself with a stable namespaced id under the whiteboard kind', () => {
    expect(whiteboardPlaceholderConnector.id).toBe(WHITEBOARD_PLACEHOLDER_CONNECTOR_ID);
    expect(whiteboardPlaceholderConnector.id).toBe('whiteboard.placeholder');
    expect(whiteboardPlaceholderConnector.kind).toBe(WHITEBOARD_KIND);
  });

  it('refuses verify(...) with the canonical errors.connectors.notConfigured i18n key', async () => {
    const result = await whiteboardPlaceholderConnector.verify({});
    expect(result).toBe(WHITEBOARD_PLACEHOLDER_NOT_CONFIGURED_KEY);
    expect(result).toBe('errors.connectors.notConfigured');
  });

  it('refuses verify(...) regardless of the config payload contents', async () => {
    const result = await whiteboardPlaceholderConnector.verify({
      apiKey: 'pretend-this-is-set',
      endpoint: 'https://example.invalid',
    });
    expect(result).toBe(WHITEBOARD_PLACEHOLDER_NOT_CONFIGURED_KEY);
  });

  it('omits pull/push/ingest — v1 ships no upstream system for whiteboards', () => {
    expect(whiteboardPlaceholderConnector.pull).toBeUndefined();
    expect(whiteboardPlaceholderConnector.push).toBeUndefined();
    expect(whiteboardPlaceholderConnector.ingest).toBeUndefined();
  });
});
