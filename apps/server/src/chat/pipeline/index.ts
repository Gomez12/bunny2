/**
 * Phase 6.3 — chat pipeline barrel.
 *
 * Re-exports the orchestrator entry point + the step factories +
 * the public types. The HTTP route (phase 6.4) imports `runPipeline`
 * and the bus topic constants; tests import the step factories and
 * the type definitions.
 */

export { runPipeline } from './orchestrator';
export type { RunPipelineInput, RunPipelineDeps, RunPipelineResult } from './orchestrator';

export { createIntentStep } from './intent-step';
export { createEntitiesStep } from './entities-step';
export { createRetrievalStep } from './retrieval-step';
export {
  createAnswerStep,
  ANSWER_TIMEOUT_MS,
  COMMAND_NOT_SUPPORTED_MESSAGE,
  SMALLTALK_FALLBACK_MESSAGE,
  AnswerTimeoutError,
} from './answer-step';

export { InvalidStepOutputError, extractJsonObject } from './step-utils';

export {
  PIPELINE_ENTITY_KINDS,
  EntityKindSchema,
  IntentEnum,
  IntentOutputSchema,
  EntitiesOutputSchema,
  RetrievalOutputSchema,
  AnswerOutputSchema,
  ERROR_CODES,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStep,
  type PipelineStepResult,
  type PipelineStepKind,
  type PipelineStepStatus,
  type EntityKind,
  type EntityStoreForRetrieval,
  type Intent,
  type IntentOutput,
  type EntitiesOutput,
  type QueryHint,
  type RetrievalHit,
  type RetrievalOutput,
  type AnswerOutput,
  type HistoryTurn,
  type PipelineLogger,
  type PipelineCounters,
  type PipelineLlm,
} from './types';

export {
  CHAT_EVENT_TYPES,
  type ChatEventType,
  type ChatMessageReceivedPayload,
  type ChatMessageAnsweredPayload,
  type ChatMessageFailedPayload,
  type ChatStepStartedPayload,
  type ChatStepSucceededPayload,
  type ChatStepFailedPayload,
} from '../events';
