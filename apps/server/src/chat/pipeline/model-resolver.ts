/**
 * Per-layer chat model resolver.
 *
 * The chat pipeline (intent / entities / answer steps) consults this
 * resolver instead of relying on the LLM client's default. When a
 * layer has a row in `layer_chat_settings` with a non-NULL `model`,
 * that wins; otherwise the system default flows through. The result
 * carries a `source` discriminator so telemetry can record where the
 * decision came from (`llm_calls.model_source`).
 */

import type { LayerChatSettingsRepo } from '../repos/layer-chat-settings-repo';

export type ModelSource = 'system' | 'layer';

export interface ResolvedChatModel {
  readonly model: string;
  readonly source: ModelSource;
}

export interface ChatModelResolverDeps {
  readonly settingsRepo: LayerChatSettingsRepo;
  readonly systemDefault: string;
}

export interface ChatModelResolver {
  resolve(layerId: string): ResolvedChatModel;
}

export function createChatModelResolver(deps: ChatModelResolverDeps): ChatModelResolver {
  return {
    resolve(layerId) {
      const row = deps.settingsRepo.find(layerId);
      if (row !== null && row.model !== null && row.model.length > 0) {
        return { model: row.model, source: 'layer' };
      }
      return { model: deps.systemDefault, source: 'system' };
    },
  };
}
