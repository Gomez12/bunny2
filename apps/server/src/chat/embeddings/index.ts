/**
 * Phase 6.2 — chat-embeddings module barrel.
 *
 * Re-exports the public surface of the embedding scaffold:
 *  - `Embedder` interface + `MockEmbedder` / `OpenAiEmbedder`.
 *  - `LanceWriter` interface + LanceDB-backed + in-memory factories.
 *  - The bus subscriber that wires `entity.<kind>.*` → LanceDB.
 *  - The `chat.embeddings.backfill` scheduled-task handler.
 *
 * The actual side-effecting registration (subscribers, scheduled
 * handler) is wired in `apps/server/src/index.ts` and
 * `apps/server/src/chat/index.ts`.
 */

export {
  createMockEmbedder,
  createOpenAiEmbedder,
  MOCK_EMBEDDER_DIMENSIONS,
  type Embedder,
  type OpenAiEmbedderOpts,
} from './embedder';

export {
  ENTITY_KIND_TO_LANCE_TABLE,
  getLanceTableForKind,
  createInMemoryLanceWriter,
  createLanceDbWriter,
  type LanceWriter,
  type EmbeddingRow,
} from './lance-tables';

export {
  createEmbeddingSubscriber,
  type EmbeddingSubscriber,
  type EmbeddingSubscriberDeps,
  type FetchedEntity,
  type SubscriberLogger,
  type SubscriberCounters,
} from './subscriber';

export {
  createChatEmbeddingsBackfillHandler,
  CHAT_EMBEDDINGS_BACKFILL_KIND,
  type CreateBackfillHandlerDeps,
  type ListSummariesFn,
  type BackfillSummary,
} from './backfill-handler';
