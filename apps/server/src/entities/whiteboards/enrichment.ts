import type { Database } from 'bun:sqlite';
import type { Entity, EntityRef, WhiteboardPayload } from '@bunny2/shared';
import type { ChatMessage } from '../../llm';
import { listEntityModules } from '../registry';
import { insertExternalLink } from '../connectors/base';
import type { EnrichmentJob, EnrichmentJobContext, EnrichmentResult } from '../module';

/**
 * Phase 11.3 — whiteboards AI enrichment.
 *
 * Two jobs ship in 11.3, both deterministic-first per the §10c
 * pattern established by companies / contacts / calendar / todos:
 *
 *  - `whiteboard.sceneSummary` (runs on `created` / `updated`)
 *    extracts text-element content from the scene and asks the LLM
 *    for a 1–2 sentence summary that grounds chat retrieval. The
 *    summary is written to `entity_souls.memory_json[summary]`
 *    (phase-7 memory slice) — the same row the enrichment runner
 *    already uses for `lastEnrichedAtVersionByJob`. NO payload patch
 *    — the scene is the source of truth; the summary is derived
 *    memory. Skipped on idempotence (same source version) and when
 *    the scene has no text elements to summarise.
 *
 *  - `whiteboard.mentionResolver` (runs on `created` / `updated`)
 *    scans the scene's text-element contents for `@<name>` and
 *    `[[<name>]]` patterns and resolves matches against every
 *    registered entity kind, scoped to the whiteboard's OWN layer
 *    (the runner does not expose the author's `effectiveLayers`;
 *    plan §7 Security says "never cross-layer", and a whiteboard
 *    lives in exactly one layer). Deterministic case-insensitive
 *    title / slug compare; no LLM. Resolved references are written
 *    to `entity_external_links` with `connector =
 *    'whiteboard.mention'` (idempotent — duplicate inserts are
 *    skipped by the runtime `(connector, external_id)` check below
 *    because `external_id` encodes `{targetKind}:{targetId}` deterministically).
 *
 * Secrets discipline: both jobs project the bare-minimum surface.
 * The summary prompt contains ONLY whitespace-collapsed text-element
 * content — no connector configs, no scene `appState`, no `files`,
 * no element ids, no element metadata. The mention resolver does
 * not call the LLM at all. The canary test asserts the invariant.
 *
 * The runner picks both jobs up from `module.enrichmentJobs`. A
 * separate scheduled-task handler (`entity.whiteboards.enrich`,
 * registered in `./scheduled.ts`) runs the same two job functions
 * as a daily sweep to catch whiteboards the event-based runner
 * missed (server restart between save and runner tick). Mirrors the
 * `chat.summarize-conversation` precedent — per-event subscriber +
 * scheduled sweep with the same per-row work function.
 *
 * `enrichmentOverwriteFields` is NOT declared because neither job
 * patches the payload — both jobs produce side effects on
 * `entity_souls` / `entity_external_links` and return `{}` to the
 * runner. The runner's "never overwrite non-empty fields" rule is
 * therefore moot.
 */

export const WHITEBOARD_SCENE_SUMMARY_JOB_ID = 'whiteboard.sceneSummary';
export const WHITEBOARD_MENTION_RESOLVER_JOB_ID = 'whiteboard.mentionResolver';
export const WHITEBOARD_MENTION_CONNECTOR_ID = 'whiteboard.mention';

const SUMMARY_MAX_LEN = 240;
const SUMMARY_PROMPT_TEXT_MAX = 4000;
const MENTION_PROMPT_MAX_CANDIDATES = 20;

// `@name` and `[[name]]` patterns. The character class matches latin
// letters, digits, accented letters, common punctuation that appears
// in entity names (spaces, dots, hyphens, apostrophes, ampersands).
// Trailing whitespace and punctuation are trimmed by the consumer
// before the lookup so "Hi @AMI BV." resolves cleanly.
const MENTION_AT_RE = /@([\p{L}\p{N}][\p{L}\p{N} .'&-]{0,79})/gu;
const MENTION_BRACKET_RE = /\[\[([\p{L}\p{N}][\p{L}\p{N} .'&-]{0,79})\]\]/gu;

// Trailing punctuation we strip after a regex match. The pattern only
// targets the END of the captured name; embedded punctuation is part
// of the legitimate name (e.g. "AMI B.V.").
const TRAILING_TRIM_RE = /[.,;:!?()\]'"`]+$/;

// ---------------------------------------------------------------------------
// Job A — scene summary (writes to entity_souls.memory_json[summary])
// ---------------------------------------------------------------------------

export const whiteboardSceneSummaryJob: EnrichmentJob<WhiteboardPayload> = {
  id: WHITEBOARD_SCENE_SUMMARY_JOB_ID,
  runOn: ['created', 'updated'],
  async run(
    entity: Entity<WhiteboardPayload>,
    ctx: EnrichmentJobContext<WhiteboardPayload>,
  ): Promise<EnrichmentResult<WhiteboardPayload>> {
    const texts = extractSceneTexts(entity.payload);
    if (texts.length === 0) {
      // Nothing to summarise. Clear any stale summary so a whiteboard
      // that lost all its text elements does not keep a stale memory.
      clearSummary(ctx.db, entity.id);
      return {};
    }

    // Idempotence: skip when the soul already records this version.
    const lastVersion = readLastSummaryVersion(ctx.db, entity.id);
    if (lastVersion !== null && lastVersion >= entity.meta.version) {
      return {};
    }

    const joined = collapseWhitespace(texts.join(' \n')).slice(0, SUMMARY_PROMPT_TEXT_MAX);
    const messages = buildSummaryMessages(joined);
    const response = await ctx.llm.chat({
      messages,
      metadata: {
        layerId: ctx.layerId,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
        flowId: `enrichment:${WHITEBOARD_SCENE_SUMMARY_JOB_ID}`,
      },
    });

    const summary = sanitizeSummary(response.content);
    if (summary.length === 0) {
      // The model returned nothing useful — do not stamp the soul, so
      // a re-run will retry. The runner will still emit
      // `entity.enrichment.succeeded` (no patch) for this pass.
      return {
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        model: response.model,
      };
    }

    writeSummary(ctx.db, entity.id, summary, entity.meta.version, ctx);
    return {
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    };
  },
};

// ---------------------------------------------------------------------------
// Job B — mention resolver (writes to entity_external_links)
// ---------------------------------------------------------------------------

export const whiteboardMentionResolverJob: EnrichmentJob<WhiteboardPayload> = {
  id: WHITEBOARD_MENTION_RESOLVER_JOB_ID,
  runOn: ['created', 'updated'],
  async run(
    entity: Entity<WhiteboardPayload>,
    ctx: EnrichmentJobContext<WhiteboardPayload>,
  ): Promise<EnrichmentResult<WhiteboardPayload>> {
    const texts = extractSceneTexts(entity.payload);
    if (texts.length === 0) return {};

    // Each mention occurrence yields a set of candidate prefixes
    // (longest-first). We iterate per-occurrence and stop on the
    // first prefix that resolves to a real layer entity — this
    // gives "AMI BV today" the chance to bind to "AMI BV" without
    // greedily matching the full "AMI BV today" phrase.
    const mentionOccurrences = extractMentionOccurrences(texts);
    if (mentionOccurrences.length === 0) return {};

    // Build the per-layer candidate set once. Whiteboard-kind rows are
    // skipped — self-mentions are noise. Soft-deleted rows are also
    // skipped via `deleted_at IS NULL` in the per-kind query.
    const candidates = listLayerEntityNames(ctx.db, ctx.layerId, entity.kind);
    if (candidates.length === 0) return {};

    const candidateByName = buildNameIndex(candidates);

    const existingLinks = listExistingMentionLinks(ctx.db, entity.id);

    const ref: EntityRef = {
      id: entity.id,
      kind: entity.kind,
      layerId: entity.layerId,
      slug: entity.slug,
    };
    const now = new Date().toISOString();

    let linked = 0;
    for (const occurrence of mentionOccurrences) {
      // `occurrence` is the longest-first list of prefix candidates
      // for a single `@` or `[[ ]]` mention. The first match wins.
      let matchedPrefix: string | null = null;
      let match: LayerEntityName | undefined;
      for (const prefix of occurrence) {
        const found = candidateByName.get(prefix.toLowerCase());
        if (found !== undefined) {
          match = found;
          matchedPrefix = prefix;
          break;
        }
      }
      if (match === undefined || matchedPrefix === null) continue;
      const externalId = `${match.kind}:${match.id}`;
      if (existingLinks.has(externalId)) continue;
      insertExternalLink(ctx.db, {
        id: cryptoRandomUUID(),
        ref,
        connector: WHITEBOARD_MENTION_CONNECTOR_ID,
        externalId,
        payload: { targetKind: match.kind, targetId: match.id, matchedName: matchedPrefix },
        now,
      });
      existingLinks.add(externalId);
      linked += 1;
    }

    if (linked === 0) return {};
    // Mention resolution is a side-effect-only job. No payload patch.
    return {
      note: `whiteboard.mentionResolver: linked ${linked.toString()} mention(s)`,
    };
  },
};

export const whiteboardEnrichmentJobs: readonly EnrichmentJob<WhiteboardPayload>[] = [
  whiteboardSceneSummaryJob,
  whiteboardMentionResolverJob,
];

// ---------------------------------------------------------------------------
// Scene-text extraction
// ---------------------------------------------------------------------------

/**
 * Pull plain text from text-elements only. Elements are opaque
 * `unknown` per ADR 0028; this function uses defensive `typeof` checks
 * rather than narrowing against a structural type. Mirrors the
 * `searchableTextFor` helper in `module.ts` so the two surfaces stay
 * consistent.
 *
 * Non-text elements (images, lines, arrows, shapes) contribute
 * nothing — they have no human-readable content. That is also the
 * mitigation captured in ADR 0028 against the "LanceDB index
 * pollution from huge scenes" risk.
 */
export function extractSceneTexts(payload: WhiteboardPayload): readonly string[] {
  const out: string[] = [];
  for (const el of payload.scene.elements) {
    if (el === null || typeof el !== 'object') continue;
    const elObj = el as Record<string, unknown>;
    if (elObj.type !== 'text') continue;
    const text = elObj.text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

function buildSummaryMessages(sceneText: string): readonly ChatMessage[] {
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You summarise the text content of a whiteboard in one or two short ' +
      'sentences. The summary grounds a chat agent answering questions about ' +
      'the whiteboard. Respond with the summary text only — no JSON, no ' +
      'markdown, no preamble. If the text is empty or only contains noise, ' +
      'respond with the single word: none.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: `Whiteboard text content:\n${sceneText}`,
  };
  return [sys, user];
}

function sanitizeSummary(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.toLowerCase() === 'none') return '';
  // Hard cap so a chatty model cannot blow up the soul row.
  if (trimmed.length <= SUMMARY_MAX_LEN) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX_LEN - 1).trimEnd()}…`;
}

interface SoulRow {
  memory_json: string;
}

/**
 * Read-merge-write `entity_souls.memory_json[summary]`. Mirrors the
 * `recordLastEnriched` discipline in `enrichment-runner.ts`: tolerant
 * of malformed JSON, idempotent re-inserts, single small transaction.
 */
function writeSummary(
  db: Database,
  entityId: string,
  summary: string,
  sourceVersion: number,
  ctx: EnrichmentJobContext<WhiteboardPayload>,
): void {
  const nowIso = new Date().toISOString();
  const existing = db
    .query<SoulRow, [string]>('SELECT memory_json FROM entity_souls WHERE entity_id = ?')
    .get(entityId);
  const mem = parseMemoryJson(existing?.memory_json);
  mem['summary'] = summary;
  mem['summarySourceVersion'] = sourceVersion;
  mem['summaryUpdatedAt'] = nowIso;
  const memJson = JSON.stringify(mem);
  if (existing === null) {
    db.query<unknown, [string, string, string, string]>(
      'INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)',
    ).run(entityId, ctx.module.kind, memJson, nowIso);
    return;
  }
  db.query<unknown, [string, string, string]>(
    'UPDATE entity_souls SET memory_json = ?, updated_at = ? WHERE entity_id = ?',
  ).run(memJson, nowIso, entityId);
}

function clearSummary(db: Database, entityId: string): void {
  const existing = db
    .query<SoulRow, [string]>('SELECT memory_json FROM entity_souls WHERE entity_id = ?')
    .get(entityId);
  if (existing === null) return;
  const mem = parseMemoryJson(existing.memory_json);
  if (!('summary' in mem)) return;
  delete mem['summary'];
  delete mem['summarySourceVersion'];
  delete mem['summaryUpdatedAt'];
  const nowIso = new Date().toISOString();
  db.query<unknown, [string, string, string]>(
    'UPDATE entity_souls SET memory_json = ?, updated_at = ? WHERE entity_id = ?',
  ).run(JSON.stringify(mem), nowIso, entityId);
}

function readLastSummaryVersion(db: Database, entityId: string): number | null {
  const row = db
    .query<SoulRow, [string]>('SELECT memory_json FROM entity_souls WHERE entity_id = ?')
    .get(entityId);
  if (row === null) return null;
  const mem = parseMemoryJson(row.memory_json);
  const v = mem['summarySourceVersion'];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function parseMemoryJson(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

// ---------------------------------------------------------------------------
// Mention helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise mentions out of a list of text-element strings. The
 * `@<name>` form is ambiguous in free text — `@AMI BV today` could
 * mean either `AMI` or `AMI BV` or `AMI BV today`. Rather than guess
 * a single boundary, we yield EVERY prefix (1..N space-separated
 * words) of the captured run and let the resolver pick the longest
 * one that matches a real entity title in the layer.
 *
 * The `[[<name>]]` form is unambiguous — the brackets are explicit
 * boundaries, so we yield exactly the captured run.
 */
export function extractMentionTokens(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    MENTION_AT_RE.lastIndex = 0;
    MENTION_BRACKET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_AT_RE.exec(text)) !== null) {
      const captured = m[1];
      if (captured === undefined) continue;
      for (const candidate of enumeratePrefixes(captured)) {
        out.add(candidate);
        if (out.size >= MENTION_PROMPT_MAX_CANDIDATES) break;
      }
      if (out.size >= MENTION_PROMPT_MAX_CANDIDATES) break;
    }
    while ((m = MENTION_BRACKET_RE.exec(text)) !== null) {
      const captured = m[1];
      if (captured === undefined) continue;
      const cleaned = cleanMentionToken(captured);
      if (cleaned.length === 0) continue;
      out.add(cleaned);
      if (out.size >= MENTION_PROMPT_MAX_CANDIDATES) break;
    }
    if (out.size >= MENTION_PROMPT_MAX_CANDIDATES) break;
  }
  return out;
}

function cleanMentionToken(raw: string): string {
  const trimmed = raw.trim().replace(TRAILING_TRIM_RE, '').trim();
  if (trimmed.length === 0) return '';
  return trimmed;
}

/**
 * Like `extractMentionTokens`, but preserves per-occurrence
 * structure: each element of the outer array represents one `@` or
 * `[[ ]]` site, and the inner array is the longest-first list of
 * candidate prefixes for that site. The resolver picks the first
 * prefix that matches a real layer entity per site, so longer real
 * names ("AMI BV") win over shorter prefixes ("AMI") when both
 * would otherwise resolve.
 */
export function extractMentionOccurrences(
  texts: readonly string[],
): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (const text of texts) {
    MENTION_AT_RE.lastIndex = 0;
    MENTION_BRACKET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_AT_RE.exec(text)) !== null) {
      const captured = m[1];
      if (captured === undefined) continue;
      const prefixes = enumeratePrefixes(captured);
      if (prefixes.length === 0) continue;
      out.push(prefixes);
      if (out.length >= MENTION_PROMPT_MAX_CANDIDATES) break;
    }
    while ((m = MENTION_BRACKET_RE.exec(text)) !== null) {
      const captured = m[1];
      if (captured === undefined) continue;
      const cleaned = cleanMentionToken(captured);
      if (cleaned.length === 0) continue;
      // Bracket form is unambiguous — single candidate only.
      out.push([cleaned]);
      if (out.length >= MENTION_PROMPT_MAX_CANDIDATES) break;
    }
    if (out.length >= MENTION_PROMPT_MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Yield every space-separated prefix of `raw`, longest-first. After
 * stripping trailing punctuation, "AMI BV today" yields
 * ["AMI BV today", "AMI BV", "AMI"]. Single-word inputs yield one
 * candidate. Empty strings yield nothing.
 */
function enumeratePrefixes(raw: string): readonly string[] {
  const cleaned = cleanMentionToken(raw);
  if (cleaned.length === 0) return [];
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const out: string[] = [];
  for (let i = words.length; i >= 1; i -= 1) {
    const prefix = words.slice(0, i).join(' ');
    const trimmedPrefix = prefix.replace(TRAILING_TRIM_RE, '').trim();
    if (trimmedPrefix.length === 0) continue;
    out.push(trimmedPrefix);
  }
  return out;
}

interface LayerEntityName {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly slug: string;
}

/**
 * Enumerate (id, kind, title, slug) for every NON-deleted entity in
 * the layer, across every registered kind EXCEPT the author's own
 * (`excludeKind`). Self-mentions on the same whiteboard are noise.
 *
 * Each per-kind table follows the §4.0 shape (`id`, `layer_id`,
 * `slug`, `title`, `deleted_at`); a generic SELECT works against
 * every kind. Module `tableName` is interpolated raw — it is set by
 * the per-kind module at registration time and validated by the
 * `EntityStore` factory (regex match `/^[a-z_][a-z0-9_]*$/`), so it
 * is safe to splice into the SQL string here.
 */
function listLayerEntityNames(
  db: Database,
  layerId: string,
  excludeKind: string,
): readonly LayerEntityName[] {
  const out: LayerEntityName[] = [];
  for (const module of listEntityModules()) {
    if (module.kind === excludeKind) continue;
    const t = module.tableName;
    if (!isSafeIdentifier(t)) continue;
    try {
      const rows = db
        .query<
          { id: string; title: string; slug: string },
          [string]
        >(`SELECT id, title, slug FROM ${t} WHERE layer_id = ? AND deleted_at IS NULL`)
        .all(layerId);
      for (const r of rows) {
        out.push({ id: r.id, kind: module.kind, title: r.title, slug: r.slug });
      }
    } catch {
      // A kind whose per-kind table is missing (test fixture, future
      // migration mid-rollout) is a no-op here — the resolver simply
      // cannot link to that kind on this pass.
      continue;
    }
  }
  return out;
}

function isSafeIdentifier(s: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(s);
}

function buildNameIndex(rows: readonly LayerEntityName[]): Map<string, LayerEntityName> {
  const idx = new Map<string, LayerEntityName>();
  for (const row of rows) {
    const titleKey = row.title.trim().toLowerCase();
    if (titleKey.length > 0 && !idx.has(titleKey)) idx.set(titleKey, row);
    const slugKey = row.slug.toLowerCase();
    if (slugKey.length > 0 && !idx.has(slugKey)) idx.set(slugKey, row);
  }
  return idx;
}

function listExistingMentionLinks(db: Database, entityId: string): Set<string> {
  const rows = db
    .query<
      { external_id: string },
      [string, string]
    >('SELECT external_id FROM entity_external_links WHERE entity_id = ? AND connector = ?')
    .all(entityId, WHITEBOARD_MENTION_CONNECTOR_ID);
  return new Set(rows.map((r) => r.external_id));
}

function cryptoRandomUUID(): string {
  // Indirect through `crypto.randomUUID` so the function is mockable
  // from tests if a deterministic id is ever needed; for now it just
  // mirrors how `entities/store.ts` mints new ids.
  return crypto.randomUUID();
}
