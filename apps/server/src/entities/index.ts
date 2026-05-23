/**
 * Phase 4.0 — barrel for the universal entity contract.
 *
 * Per-kind sub-phases (4a..4d) import from this barrel:
 *
 *   import { createEntityStore, mountEntityRoutes, registerEntityModule }
 *     from '../entities';
 *
 * No code in 4.0 mounts any route or registers any module — that lands
 * with the first concrete kind in 4a.1.
 */

export { mountEntityRoutes } from './router';
export type { MountEntityRoutesDeps } from './router';

export { createEntityStore } from './store';
export type {
  EntityStore,
  EntityCreateInput,
  EntityUpdateInput,
  EntityMutationInput,
  ListSummariesOptions,
  SearchSummariesOptions,
  AddExternalLinkInput,
  RecordTranslationInput,
  CreateEntityStoreDeps,
} from './store';

export {
  registerEntityModule,
  getEntityModule,
  listEntityKinds,
  listEntityModules,
  __resetEntityRegistryForTests,
} from './registry';

export type {
  EntityModule,
  EntityIndexedColumn,
  EntityLifecycleContext,
  EntityLifecycleHook,
  EntityScheduledJob,
} from './module';

export { createEntityTranslator } from './translator';
export type { EntityTranslator, CreateEntityTranslatorDeps } from './translator';

export { ENTITY_EVENT_TYPES, entityEventType } from './events';
export type {
  EntityAction,
  EntityEventType,
  EntityCreatedPayload,
  EntityUpdatedPayload,
  EntityDeletedPayload,
  EntityRestoredPayload,
  EntityTranslationRequestedPayload,
  EntityTranslationCompletedPayload,
  EntityConnectorSyncRequestedPayload,
  EntityConnectorSyncSucceededPayload,
  EntityConnectorSyncFailedPayload,
} from './events';

export {
  insertExternalLink,
  listExternalLinks,
  removeExternalLink,
  markSyncing,
  markSucceeded,
  markFailed,
  scrubConnectorPayload,
} from './connectors/base';
export type {
  EntityConnector,
  ConnectorContext,
  ConnectorEntityInput,
  InsertExternalLinkInput,
  SyncTransitionInput,
  SyncFailureInput,
} from './connectors/base';
