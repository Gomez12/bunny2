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
  getConnector,
  listConnectorsForKind,
  listEntityKinds,
  listEntityModules,
  __resetEntityRegistryForTests,
} from './registry';

export {
  createConnectorDispatcher,
  createLayerAttachmentConfigResolver,
  type ConnectorDispatcher,
  type ConnectorDispatcherDeps,
  type ConnectorConfigResolver,
} from './connector-dispatcher';

export {
  createConnectorRunner,
  type ConnectorRunner,
  type ConnectorRunnerDeps,
  type RegisteredConnector,
} from './connector-runner';

export {
  createEnrichmentRunner,
  type EnrichmentRunner,
  type EnrichmentRunnerDeps,
  type EnrichmentRunnerConfig,
} from './enrichment-runner';

export type {
  EntityModule,
  EntityIndexedColumn,
  EntityLifecycleContext,
  EntityLifecycleHook,
  EntityScheduledJob,
  EnrichmentJob,
  EnrichmentJobContext,
  EnrichmentResult,
  EnrichmentTrigger,
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
  EntityEnrichmentStartedPayload,
  EntityEnrichmentSucceededPayload,
  EntityEnrichmentFailedPayload,
  EntityEnrichmentDeferredPayload,
} from './events';

export {
  insertExternalLink,
  listExternalLinks,
  removeExternalLink,
  markSyncing,
  setSyncingState,
  publishSyncRequested,
  markSucceeded,
  markFailed,
  scrubConnectorPayload,
  persistConnectorPayloadPatch,
} from './connectors/base';
export type {
  EntityConnector,
  ConnectorContext,
  ConnectorEntityInput,
  ConnectorPullInput,
  ConnectorPayloadPatch,
  InsertExternalLinkInput,
  SyncTransitionInput,
  SyncFailureInput,
} from './connectors/base';
