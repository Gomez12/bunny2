import type { CompanyPayload } from '@bunny2/shared';
import type { Entity } from '@bunny2/shared';
import type { ChatMessage } from '../../llm';
import type { EnrichmentJob, EnrichmentJobContext, EnrichmentResult } from '../module';
import { KVK_CONNECTOR_ID } from './kvk-connector';

/**
 * Phase 4a.3 — companies-specific enrichment jobs.
 *
 * Two jobs ship in 4a.3:
 *
 *  - `companies.summary` (runs on created / updated / sync.succeeded)
 *    asks the LLM for a ≤300-char summary used as the row's
 *    `description` (the "subtitle" surface in the future UI). Only
 *    refreshes when the description is empty.
 *
 *  - `companies.fillFields` (runs on sync.succeeded only) inspects the
 *    KvK ground-truth patch persisted to
 *    `entity_external_links.payload_json.lastPatch` and asks the LLM to
 *    fill missing structured fields (legalName, tradeName, industry).
 *    The runner refuses to overwrite a user-set field by contract; the
 *    job itself returns null for fields it is uncertain about.
 *
 * All LLM calls go through the system-default telemetry-wrapped client
 * passed in `ctx.llm`. The runner threads `tokensIn` / `tokensOut` /
 * `model` from the result into `entity.enrichment.succeeded`; cost is
 * computed from the pricing map injected at runner construction.
 */

const SUMMARY_MAX_LEN = 300;

/**
 * `companies.summary` — generate or refresh a short description.
 *
 * Skips when:
 *  - `payload.description` is already populated AND the trigger is
 *    `created` (no need to rewrite a freshly-authored description on
 *    the same tick). A non-empty description IS regenerated on
 *    `updated` / `sync.succeeded` because the user (or KvK) just
 *    changed something that may invalidate the prior summary.
 */
export const companiesSummaryJob: EnrichmentJob<CompanyPayload> = {
  id: 'companies.summary',
  runOn: ['created', 'updated', 'sync.succeeded'],
  async run(
    entity: Entity<CompanyPayload>,
    ctx: EnrichmentJobContext<CompanyPayload>,
  ): Promise<EnrichmentResult<CompanyPayload>> {
    const existing = entity.payload.description?.trim() ?? '';
    if (existing.length > 0 && ctx.trigger === 'created') {
      return {};
    }
    const messages = buildSummaryMessages(entity);
    const response = await ctx.llm.chat({
      messages,
      // Tag the call with layerId so the LLM telemetry row joins
      // back to the originating layer for cost dashboards.
      metadata: {
        layerId: ctx.layerId,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
        flowId: `enrichment:companies.summary`,
      },
    });
    const summary = clampSummary(response.content.trim());
    if (summary.length === 0) return {};
    const patch: Partial<CompanyPayload> = { description: summary };
    return {
      patch,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    };
  },
};

/**
 * `companies.fillFields` — fill missing structured fields from
 * external ground-truth + the LLM's best guess.
 *
 * Inputs:
 *  - The current `CompanyPayload`.
 *  - The latest KvK patch persisted by the dispatcher in
 *    `entity_external_links.payload_json.lastPatch` (or empty if no KvK
 *    link exists for this entity).
 *
 * The LLM is instructed to return `null` for any field it cannot
 * confidently infer. The runner then merges only non-null fields, AND
 * the runner itself refuses to overwrite non-empty existing fields
 * (defense in depth — see `applyPatch` in `enrichment-runner.ts`).
 */
export const companiesFillFieldsJob: EnrichmentJob<CompanyPayload> = {
  id: 'companies.fillFields',
  runOn: ['sync.succeeded'],
  async run(
    entity: Entity<CompanyPayload>,
    ctx: EnrichmentJobContext<CompanyPayload>,
  ): Promise<EnrichmentResult<CompanyPayload>> {
    const kvkPatch = readLastPatch(entity);
    // Nothing to consider — return an empty patch. The runner emits a
    // success event with `hasPatch: false`, no version bump.
    if (kvkPatch === null && hasNoFillableGaps(entity.payload)) {
      return {};
    }
    const messages = buildFillFieldsMessages(entity, kvkPatch);
    const response = await ctx.llm.chat({
      messages,
      metadata: {
        layerId: ctx.layerId,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
        flowId: `enrichment:companies.fillFields`,
      },
    });
    const parsed = safeParseJson(response.content);
    if (parsed === null || typeof parsed !== 'object') {
      return {
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        model: response.model,
      };
    }
    const candidate = parsed as Record<string, unknown>;
    const patch: Partial<CompanyPayload> = {};
    if (typeof candidate.legalName === 'string' && candidate.legalName.length > 0) {
      patch.legalName = candidate.legalName.slice(0, 200);
    }
    if (typeof candidate.tradeName === 'string' && candidate.tradeName.length > 0) {
      patch.tradeName = candidate.tradeName.slice(0, 200);
    }
    if (typeof candidate.industry === 'string' && candidate.industry.length > 0) {
      patch.industry = candidate.industry.slice(0, 120);
    }
    if (typeof candidate.description === 'string' && candidate.description.length > 0) {
      patch.description = clampSummary(candidate.description);
    }
    return {
      patch,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    };
  },
};

export const companyEnrichmentJobs: readonly EnrichmentJob<CompanyPayload>[] = [
  companiesSummaryJob,
  companiesFillFieldsJob,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_LEN) return text;
  return `${text.slice(0, SUMMARY_MAX_LEN - 1).trimEnd()}…`;
}

function buildSummaryMessages(entity: Entity<CompanyPayload>): readonly ChatMessage[] {
  const sanitizedPayload = JSON.stringify(entity.payload);
  const link = entity.externalLinks.find((l) => l.connector === KVK_CONNECTOR_ID) ?? null;
  // `link.payload` is the scrubbed object the dispatcher persisted —
  // `apiKey` and friends never reach this point by construction. The
  // secret-strip test in `companies-kvk-connector.test.ts` asserts the
  // invariant.
  const linkPayload = link === null ? null : JSON.stringify(link.payload);
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You write very short company descriptions (≤300 characters). ' +
      'Return ONLY the description text, no quotes, no markdown.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      `Company title: ${entity.title}`,
      `Structured payload: ${sanitizedPayload}`,
      `External link snapshot (may be empty): ${linkPayload ?? '(none)'}`,
      'Write a concise description for this company. ≤300 characters. English unless the existing data is clearly in another language.',
    ].join('\n'),
  };
  return [sys, user];
}

function buildFillFieldsMessages(
  entity: Entity<CompanyPayload>,
  kvkPatch: Record<string, unknown> | null,
): readonly ChatMessage[] {
  const sanitizedPayload = JSON.stringify(entity.payload);
  const groundTruth = kvkPatch === null ? '(none)' : JSON.stringify(kvkPatch);
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You complete missing company fields from external ground-truth and existing data. ' +
      'Return ONLY a JSON object with the keys legalName, tradeName, industry, description. ' +
      'Use null for any value you cannot confidently infer. Do not invent values.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      `Title: ${entity.title}`,
      `Current payload: ${sanitizedPayload}`,
      `KvK ground-truth patch: ${groundTruth}`,
      'Return the JSON.',
    ].join('\n'),
  };
  return [sys, user];
}

function readLastPatch(entity: Entity<CompanyPayload>): Record<string, unknown> | null {
  const link = entity.externalLinks.find((l) => l.connector === KVK_CONNECTOR_ID);
  if (link === undefined) return null;
  const raw = (link.payload as Record<string, unknown>)['lastPatch'];
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function hasNoFillableGaps(payload: CompanyPayload): boolean {
  const fields: (keyof CompanyPayload)[] = ['legalName', 'tradeName', 'industry', 'description'];
  for (const f of fields) {
    const v = payload[f];
    if (v === undefined || v === null) return false;
    if (typeof v === 'string' && v.trim().length === 0) return false;
  }
  return true;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The LLM occasionally wraps the JSON in a fence. Be forgiving.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced !== null && fenced[1] !== undefined) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
