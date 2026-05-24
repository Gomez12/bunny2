import type { TodoPayload } from '@bunny2/shared';
import type { Entity } from '@bunny2/shared';
import type { ChatMessage } from '../../llm';
import type { EnrichmentJob, EnrichmentJobContext, EnrichmentResult } from '../module';

/**
 * Phase 4d.3 — todos AI enrichment.
 *
 * Two jobs ship in 4d.3 — both gated by deterministic-first rules.
 * The fourth application of the §10c "deterministic-first /
 * LLM-fallback" pattern after companies / contacts / calendar.
 *
 *  - `todos.autoPriority` (runs on `created` / `updated`; NOT on
 *    `sync.succeeded` — there is no real todos connector in v1)
 *    proposes a `payload.priority` value when the user accepted the
 *    schema default (3). Strategy:
 *      1. **Keyword scan** on title + description (case-insensitive
 *         whole-word match, mixed en/nl).
 *      2. **Tag scan** on `payload.tags`.
 *      3. **Due-date proximity** using `payload.dueAt` against the
 *         runner's clock.
 *      4. **LLM fallback** — minimal sanitised prompt (title,
 *         description excerpt, tags). Applied only at high confidence.
 *    The job is **skipped** when `priority !== 3 || priority ===
 *    undefined` is FALSE — i.e. the user already moved the slider away
 *    from the default. It is also **skipped** when `status` is `'done'`
 *    or `'cancelled'` (no point auto-prioritising completed work).
 *
 *  - `todos.autoDue` (runs on `created` / `updated`; NOT on
 *    `sync.succeeded`) proposes a `payload.dueAt` value when the user
 *    has not set one. Strategy: deterministic natural-language date
 *    phrases in the title (mixed en/nl). **No LLM fallback** — date
 *    hallucination has user-visible side effects (a wrong date is
 *    worse than no date), so when the deterministic scan misses, the
 *    job returns `{}`. The job is skipped when `dueAt` is set OR
 *    `status` is `'done'` / `'cancelled'`.
 *
 * Secrets discipline: both prompts (only the priority job has one)
 * project the bare minimum surface — title, description excerpt, tags.
 * Connector attachments live on `layer_attachments.config` and never
 * reach the todo payload by construction; the secret-strip canary
 * test (mirroring 4a.3 / 4b.3 / 4c.3) asserts the invariant.
 *
 * `enrichmentOverwriteFields` policy: the module declares
 * `['priority']` because the zod schema defaults `priority` to `3`,
 * so without the slot the runner would treat every payload's `3` as
 * a set value and drop the autoPriority patch. The job's own gate
 * (`priority !== undefined && priority !== 3 → skip`) is the actual
 * user-intent protection — STRICTER than the runner's "non-empty"
 * check. `dueAt` has no schema default and is genuinely `undefined`
 * when unset, so the runner's "fill the blank" default covers
 * autoDue without the slot. See
 * `docs/dev/decisions/0013-entity-enrichment.md` Update (4d.3) for
 * the rationale.
 */

const PRIORITY_JOB_ID = 'todos.autoPriority';
const DUE_JOB_ID = 'todos.autoDue';

const DEFAULT_PRIORITY = 3;
const LLM_CONFIDENCE_THRESHOLD = 0.8;
const DESCRIPTION_EXCERPT_MAX = 400;

const MS_IN_HOUR = 60 * 60 * 1000;
const MS_IN_DAY = 24 * MS_IN_HOUR;

// Keyword maps for the deterministic priority scan. Matches are
// whole-word (lookbehind/lookahead boundaries that include accented
// letters in nl). Sorted by priority bucket: 1 = urgent, 2 =
// important, 5 = whenever. Bucket 4 only emerges from the tag scan;
// bucket 3 is the default and never explicitly proposed (the runner
// would refuse the no-op anyway).
const PRIORITY_1_WORDS = [
  'urgent',
  'asap',
  'kritisch',
  'dringend',
  'nu',
  'meteen',
  'vandaag',
  'today',
];
const PRIORITY_2_WORDS = [
  'important',
  'belangrijk',
  'priority',
  'prioriteit',
  'morgen',
  'tomorrow',
];
const PRIORITY_5_WORDS = ['whenever', 'someday', 'geen haast', 'nice to have'];

// Tag map. Lowercase only — the schema already constrains tag entries
// to short strings; the job lowercases each tag before comparing.
const PRIORITY_1_TAGS = new Set(['urgent', 'p1', 'critical']);
const PRIORITY_2_TAGS = new Set(['p2', 'important']);
const PRIORITY_4_TAGS = new Set(['low', 'p4']);
const PRIORITY_5_TAGS = new Set(['p5']);

// Phrases for the deterministic dueAt scan. Order matters within
// each list — longer phrases must come first so `next monday` wins
// over `monday`. The `weekday` lookup uses ISO numbering (Mon=1 …
// Sun=7) so it matches `Date.getDay()` after a +6 % 7 + 1 shift.
const WEEKDAY_EN: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};
const WEEKDAY_NL: Record<string, number> = {
  maandag: 1,
  dinsdag: 2,
  woensdag: 3,
  donderdag: 4,
  vrijdag: 5,
  zaterdag: 6,
  zondag: 7,
};

// ---------------------------------------------------------------------------
// Job A — todos.autoPriority
// ---------------------------------------------------------------------------

export const todoAutoPriorityJob: EnrichmentJob<TodoPayload> = {
  id: PRIORITY_JOB_ID,
  runOn: ['created', 'updated'],
  async run(
    todo: Entity<TodoPayload>,
    ctx: EnrichmentJobContext<TodoPayload>,
  ): Promise<EnrichmentResult<TodoPayload>> {
    const status = todo.payload.status ?? 'open';
    if (status === 'done' || status === 'cancelled') {
      return {};
    }
    // Skip when the user has moved priority off the default. Treat
    // `undefined` (no priority key in the payload) the same as the
    // default 3 — both signal "no user intent", so we can refine.
    const current = todo.payload.priority;
    if (current !== undefined && current !== DEFAULT_PRIORITY) {
      return {};
    }

    // ---- Step 1: keyword scan -----------------------------------------
    const haystack = `${todo.title} ${todo.payload.description ?? ''}`.toLowerCase();
    const fromWords = scanPriorityWords(haystack);
    if (fromWords !== null && fromWords !== DEFAULT_PRIORITY) {
      return { patch: { priority: fromWords } as Partial<TodoPayload> };
    }

    // ---- Step 2: tag scan ---------------------------------------------
    const fromTags = scanPriorityTags(todo.payload.tags);
    if (fromTags !== null && fromTags !== DEFAULT_PRIORITY) {
      return { patch: { priority: fromTags } as Partial<TodoPayload> };
    }

    // ---- Step 3: due-date proximity -----------------------------------
    // The runner does NOT expose its clock to jobs by contract
    // (`EnrichmentJobContext` has no `clock` field — see `module.ts`),
    // so we read `Date.now()` here. The tests inject a fake clock at
    // the runner level for the schedule window and seed `dueAt` with
    // an absolute ISO string near `now`, so this branch stays
    // deterministic against test wall-clock by construction.
    const fromDue = scanDueProximity(todo.payload.dueAt, new Date());
    if (fromDue !== null && fromDue !== DEFAULT_PRIORITY) {
      return { patch: { priority: fromDue } as Partial<TodoPayload> };
    }

    // ---- Step 4: LLM fallback -----------------------------------------
    // Only when the deterministic strategies yielded nothing. Minimal
    // prompt — title + description excerpt + tags. The connector
    // attachment row's `apiKey` lives in `layer_attachments.config`
    // and never reaches this surface by construction.
    const messages = buildPriorityMessages(todo);
    const response = await ctx.llm.chat({
      messages,
      metadata: {
        layerId: ctx.layerId,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
        flowId: `enrichment:${PRIORITY_JOB_ID}`,
      },
    });
    const parsed = safeParseJson(response.content);
    const result: EnrichmentResult<TodoPayload> = {
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    };
    if (parsed === null || typeof parsed !== 'object') return result;
    const obj = parsed as Record<string, unknown>;
    const rawPriority = obj.priority;
    const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
    // "keep" or "none" → no patch.
    if (typeof rawPriority === 'string') {
      // The model is allowed to answer the literal string "keep" to
      // signal "no change". Treat anything non-numeric as "keep".
      return result;
    }
    if (typeof rawPriority !== 'number' || !Number.isFinite(rawPriority)) return result;
    if (!Number.isFinite(confidence) || confidence < LLM_CONFIDENCE_THRESHOLD) return result;
    const proposed = Math.round(rawPriority);
    if (proposed < 1 || proposed > 5) return result;
    if (proposed === DEFAULT_PRIORITY) return result;
    if (current !== undefined && proposed === current) return result;
    return {
      ...result,
      patch: { priority: proposed } as Partial<TodoPayload>,
    };
  },
};

// ---------------------------------------------------------------------------
// Job B — todos.autoDue
// ---------------------------------------------------------------------------

export const todoAutoDueJob: EnrichmentJob<TodoPayload> = {
  id: DUE_JOB_ID,
  runOn: ['created', 'updated'],
  async run(todo: Entity<TodoPayload>): Promise<EnrichmentResult<TodoPayload>> {
    const status = todo.payload.status ?? 'open';
    if (status === 'done' || status === 'cancelled') {
      return {};
    }
    if (todo.payload.dueAt !== undefined && todo.payload.dueAt.length > 0) {
      return {};
    }
    const title = todo.title.toLowerCase();
    const now = new Date();
    const proposed = parseDueAtFromTitle(title, now);
    if (proposed === null) return {};
    return { patch: { dueAt: proposed } as Partial<TodoPayload> };
  },
};

export const todoEnrichmentJobs: readonly EnrichmentJob<TodoPayload>[] = [
  todoAutoPriorityJob,
  todoAutoDueJob,
];

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

function scanPriorityWords(haystack: string): number | null {
  if (containsAny(haystack, PRIORITY_1_WORDS)) return 1;
  if (containsAny(haystack, PRIORITY_2_WORDS)) return 2;
  if (containsAny(haystack, PRIORITY_5_WORDS)) return 5;
  return null;
}

function containsAny(haystack: string, words: readonly string[]): boolean {
  for (const word of words) {
    if (matchesPhrase(haystack, word)) return true;
  }
  return false;
}

/**
 * Whole-phrase boundary match. We avoid `\b` because the JS `\b`
 * implementation treats characters like `é` as non-word boundaries
 * — fine for English but wrong for Dutch words. Instead, we check
 * that the character immediately before and after the phrase is
 * either start-of-string, end-of-string, whitespace, or a common
 * punctuation character.
 */
function matchesPhrase(haystack: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(phrase, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : haystack.charAt(idx - 1);
    const afterIdx = idx + phrase.length;
    const after = afterIdx >= haystack.length ? '' : haystack.charAt(afterIdx);
    if (isBoundaryChar(before) && isBoundaryChar(after)) return true;
    from = idx + 1;
  }
}

function isBoundaryChar(ch: string): boolean {
  if (ch === '') return true;
  // Whitespace OR a small set of punctuation. Letters / digits / `-`
  // / `_` count as "inside a word" and reject the match.
  return /[\s.,;:!?()[\]{}<>"'/\\]/.test(ch);
}

function scanPriorityTags(tags: readonly string[] | undefined): number | null {
  if (tags === undefined) return null;
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (PRIORITY_1_TAGS.has(t)) return 1;
  }
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (PRIORITY_2_TAGS.has(t)) return 2;
  }
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (PRIORITY_4_TAGS.has(t)) return 4;
  }
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (PRIORITY_5_TAGS.has(t)) return 5;
  }
  return null;
}

function scanDueProximity(dueAt: string | undefined, now: Date): number | null {
  if (dueAt === undefined || dueAt.length === 0) return null;
  const dueMs = parseIsoToMs(dueAt);
  if (dueMs === null) return null;
  const delta = dueMs - now.getTime();
  if (delta < 0) return 1; // overdue → urgent
  if (delta <= 24 * MS_IN_HOUR) return 1;
  if (delta <= 72 * MS_IN_HOUR) return 2;
  if (delta <= 7 * MS_IN_DAY) return null; // would be 3 — default, no change
  if (delta >= 30 * MS_IN_DAY) return 4;
  return null;
}

function parseIsoToMs(iso: string): number | null {
  // The schema accepts either `YYYY-MM-DD` or a full ISO-8601
  // timestamp. `Date.parse` handles both. The date-only form parses
  // as UTC midnight which is fine for proximity buckets.
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return t;
}

function buildPriorityMessages(todo: Entity<TodoPayload>): readonly ChatMessage[] {
  // Sanitise the projection: title + description excerpt + tags
  // only. No external link payloads, no notes-style fields the
  // schema does not even have, no connector configs.
  const view = {
    title: todo.title,
    description: excerpt(todo.payload.description),
    tags: todo.payload.tags ?? [],
  };
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You assign a priority to a todo. Return ONLY a JSON object with keys "priority" and "confidence". ' +
      '"priority" is an integer 1-5 (1 = urgent, 3 = normal, 5 = whenever) or the literal string "keep" when uncertain. ' +
      '"confidence" is a number between 0 and 1. Be conservative: prefer "keep" with confidence 0.0 when unsure.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: [`Todo: ${JSON.stringify(view)}`, 'Return the JSON.'].join('\n'),
  };
  return [sys, user];
}

function excerpt(s: string | undefined): string | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t.length === 0) return null;
  if (t.length <= DESCRIPTION_EXCERPT_MAX) return t;
  return `${t.slice(0, DESCRIPTION_EXCERPT_MAX - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Due-date helpers
// ---------------------------------------------------------------------------

function parseDueAtFromTitle(lowercaseTitle: string, now: Date): string | null {
  // Order matters: longer / more specific phrases first.
  if (matchesPhrase(lowercaseTitle, 'next monday')) return weekdayAfter(now, 1, true);
  if (matchesPhrase(lowercaseTitle, 'next tuesday')) return weekdayAfter(now, 2, true);
  if (matchesPhrase(lowercaseTitle, 'next wednesday')) return weekdayAfter(now, 3, true);
  if (matchesPhrase(lowercaseTitle, 'next thursday')) return weekdayAfter(now, 4, true);
  if (matchesPhrase(lowercaseTitle, 'next friday')) return weekdayAfter(now, 5, true);
  if (matchesPhrase(lowercaseTitle, 'next saturday')) return weekdayAfter(now, 6, true);
  if (matchesPhrase(lowercaseTitle, 'next sunday')) return weekdayAfter(now, 7, true);
  if (matchesPhrase(lowercaseTitle, 'volgende maandag')) return weekdayAfter(now, 1, true);
  if (matchesPhrase(lowercaseTitle, 'volgende dinsdag')) return weekdayAfter(now, 2, true);
  if (matchesPhrase(lowercaseTitle, 'volgende woensdag')) return weekdayAfter(now, 3, true);
  if (matchesPhrase(lowercaseTitle, 'volgende donderdag')) return weekdayAfter(now, 4, true);
  if (matchesPhrase(lowercaseTitle, 'volgende vrijdag')) return weekdayAfter(now, 5, true);
  if (matchesPhrase(lowercaseTitle, 'volgende zaterdag')) return weekdayAfter(now, 6, true);
  if (matchesPhrase(lowercaseTitle, 'volgende zondag')) return weekdayAfter(now, 7, true);

  // `by <weekday>` / `voor <weekday>` — next occurrence including today.
  for (const [name, n] of Object.entries(WEEKDAY_EN)) {
    if (matchesPhrase(lowercaseTitle, `by ${name}`)) return weekdayAfter(now, n, false);
  }
  for (const [name, n] of Object.entries(WEEKDAY_NL)) {
    if (matchesPhrase(lowercaseTitle, `voor ${name}`)) return weekdayAfter(now, n, false);
  }

  if (matchesPhrase(lowercaseTitle, 'this week')) return fridayOfWeek(now);
  if (matchesPhrase(lowercaseTitle, 'deze week')) return fridayOfWeek(now);

  if (matchesPhrase(lowercaseTitle, 'tomorrow')) return formatDateOnly(addDays(now, 1));
  if (matchesPhrase(lowercaseTitle, 'morgen')) return formatDateOnly(addDays(now, 1));
  if (matchesPhrase(lowercaseTitle, 'today')) return formatDateOnly(now);
  if (matchesPhrase(lowercaseTitle, 'vandaag')) return formatDateOnly(now);

  return null;
}

function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

function isoWeekdayOf(d: Date): number {
  // `Date.getDay()` returns 0=Sun … 6=Sat. ISO numbering is
  // 1=Mon … 7=Sun.
  const day = d.getDay();
  return day === 0 ? 7 : day;
}

/**
 * Next date matching the given ISO weekday (1=Mon … 7=Sun).
 * When `strictlyAfter` is true, the same weekday as `from` returns
 * the date a full week later. When false, the same weekday returns
 * today.
 */
function weekdayAfter(from: Date, targetIsoWeekday: number, strictlyAfter: boolean): string {
  const todayIso = isoWeekdayOf(from);
  let delta = targetIsoWeekday - todayIso;
  if (delta < 0) delta += 7;
  if (delta === 0 && strictlyAfter) delta = 7;
  return formatDateOnly(addDays(from, delta));
}

function fridayOfWeek(from: Date): string {
  return weekdayAfter(from, 5, false);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
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
