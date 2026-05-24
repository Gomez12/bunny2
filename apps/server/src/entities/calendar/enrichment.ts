import type {
  CalendarAttendee,
  CalendarEventPayload,
  ContactPayload,
  EntitySummary,
} from '@bunny2/shared';
import type { Entity } from '@bunny2/shared';
import type { ChatMessage } from '../../llm';
import { createEntityStore } from '../store';
import { getEntityModule } from '../registry';
import type { EntityModule } from '../module';
import type { EnrichmentJob, EnrichmentJobContext, EnrichmentResult } from '../module';

/**
 * Phase 4c.3 — calendar AI enrichment.
 *
 * Two jobs ship in 4c.3:
 *
 *  - `calendar.attendeeContacts` (runs on created / updated /
 *    sync.succeeded) walks each attendee with `contactEntityId == null`
 *    and tries to resolve it against the contacts in the same layer.
 *    Strategy mirrors `contacts.suggestCompany` from 4b.3:
 *      1. Exact email match (when the attendee's `value` is email-shaped).
 *      2. Display-name fuzzy match (Levenshtein ≤ 2 on whitespace-
 *         normalised strings) against the contact's display / given /
 *         family / title.
 *      3. LLM fallback ONLY when 1 and 2 produced a weak candidate set
 *         AND the attendee `value` is email-shaped. Free-text attendees
 *         (rooms, generic invites) never reach the LLM.
 *    The job returns the FULL `attendees` array as the patch so the
 *    runner can apply it via the `enrichmentOverwriteFields = ['attendees']`
 *    affordance. Per-attendee merging happens INSIDE the job: attendees
 *    whose `contactEntityId` is already set are NEVER touched.
 *
 *  - `calendar.summary` (runs on created / updated / sync.succeeded)
 *    generates a ≤500-char paragraph stored in
 *    `payload.meetingSummaryNote`. Skips when nothing is summarisable
 *    (no description, no extra attendees, no location, no conferenceUrl)
 *    and skips on idempotence (`meetingSummaryNote` already populated
 *    for the current entity version).
 *
 * Secrets discipline: the prompt strips connector configs and external
 * link payloads. The runner's enrichment.* event payloads carry only
 * tokens / cost / boolean `hasPatch` — never prompt or response.
 */

const SUMMARY_MAX_LEN = 500;
const FUZZY_DISTANCE = 2;
const CONFIDENCE_THRESHOLD = 0.8;
// Very loose email shape check — production validation lives in the
// contact / connector layers. The job only needs to know whether the
// LLM step is safe (free text never reaches the LLM).
const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUMMARY_JOB_ID = 'calendar.summary';

// ---------------------------------------------------------------------------
// Job A — attendee → contact resolution
// ---------------------------------------------------------------------------

export const calendarAttendeeContactsJob: EnrichmentJob<CalendarEventPayload> = {
  id: 'calendar.attendeeContacts',
  runOn: ['created', 'updated', 'sync.succeeded'],
  async run(
    event: Entity<CalendarEventPayload>,
    ctx: EnrichmentJobContext<CalendarEventPayload>,
  ): Promise<EnrichmentResult<CalendarEventPayload>> {
    const attendees = event.payload.attendees;
    if (attendees === undefined || attendees.length === 0) return {};

    // Short-circuit: every attendee already has a contactEntityId.
    const needsWork = attendees.some(
      (a) =>
        a.contactEntityId === undefined || a.contactEntityId === null || a.contactEntityId === '',
    );
    if (!needsWork) return {};

    const contacts = listContactsInLayer(ctx);
    if (contacts.length === 0) {
      // Cross-layer isolation: no candidates in this layer → no link, no LLM.
      return {};
    }

    let llmTokensIn = 0;
    let llmTokensOut = 0;
    let llmModel: string | undefined;
    let llmConsumed = false;
    let mutated = false;

    const next: CalendarAttendee[] = [];
    for (const attendee of attendees) {
      // NEVER touch an attendee whose contactEntityId is already set.
      if (
        attendee.contactEntityId !== undefined &&
        attendee.contactEntityId !== null &&
        attendee.contactEntityId !== ''
      ) {
        next.push(attendee);
        continue;
      }

      const isEmail = EMAIL_LIKE_RE.test(attendee.value);

      // Step 1: exact email match.
      if (isEmail) {
        const lc = attendee.value.toLowerCase();
        const exact = contacts.find((c) => contactEmailMatches(c, lc));
        if (exact !== undefined) {
          next.push({ ...attendee, contactEntityId: exact.id });
          mutated = true;
          continue;
        }
      }

      // Step 2: display-name fuzzy match.
      const needle = nameNeedleFor(attendee);
      const fuzzyMatches =
        needle === null ? [] : contacts.filter((c) => contactNameMatches(c, needle));
      if (fuzzyMatches.length === 1) {
        const sole = fuzzyMatches[0];
        if (sole !== undefined) {
          next.push({ ...attendee, contactEntityId: sole.id });
          mutated = true;
          continue;
        }
      }

      // Step 3: LLM fallback — email-shaped only. Free-text attendees
      // (room names, generic invites) are never sent to the LLM. Skip
      // when no candidates exist either.
      if (!isEmail || llmConsumed) {
        next.push(attendee);
        continue;
      }
      const candidates = fuzzyMatches.length > 0 ? fuzzyMatches : contacts.slice(0, 20);
      if (candidates.length === 0) {
        next.push(attendee);
        continue;
      }
      const llmPick = await askAttendeeLlm(event, attendee, candidates, ctx);
      llmConsumed = true;
      if (llmPick.tokensIn !== undefined) llmTokensIn += llmPick.tokensIn;
      if (llmPick.tokensOut !== undefined) llmTokensOut += llmPick.tokensOut;
      if (llmModel === undefined && llmPick.model !== undefined) llmModel = llmPick.model;
      if (llmPick.contactId !== null) {
        next.push({ ...attendee, contactEntityId: llmPick.contactId });
        mutated = true;
      } else {
        next.push(attendee);
      }
    }

    if (!mutated) {
      const result: EnrichmentResult<CalendarEventPayload> = {};
      if (llmTokensIn > 0) (result as { tokensIn?: number }).tokensIn = llmTokensIn;
      if (llmTokensOut > 0) (result as { tokensOut?: number }).tokensOut = llmTokensOut;
      if (llmModel !== undefined) (result as { model?: string }).model = llmModel;
      return result;
    }
    const result: EnrichmentResult<CalendarEventPayload> = {
      patch: { attendees: next } as Partial<CalendarEventPayload>,
    };
    if (llmTokensIn > 0) (result as { tokensIn?: number }).tokensIn = llmTokensIn;
    if (llmTokensOut > 0) (result as { tokensOut?: number }).tokensOut = llmTokensOut;
    if (llmModel !== undefined) (result as { model?: string }).model = llmModel;
    return result;
  },
};

// ---------------------------------------------------------------------------
// Job B — meeting summary
// ---------------------------------------------------------------------------

export const calendarSummaryJob: EnrichmentJob<CalendarEventPayload> = {
  id: SUMMARY_JOB_ID,
  runOn: ['created', 'updated', 'sync.succeeded'],
  async run(
    event: Entity<CalendarEventPayload>,
    ctx: EnrichmentJobContext<CalendarEventPayload>,
  ): Promise<EnrichmentResult<CalendarEventPayload>> {
    // Idempotence: skip when meetingSummaryNote is already set AND the
    // soul stamp for this job is at or past the current version.
    const existing = event.payload.meetingSummaryNote?.trim() ?? '';
    if (existing.length > 0 && lastSummaryVersion(ctx, event.id) >= event.meta.version) {
      return {};
    }

    if (!hasSummarisableContent(event.payload)) {
      return {};
    }

    const messages = buildSummaryMessages(event);
    const response = await ctx.llm.chat({
      messages,
      metadata: {
        layerId: ctx.layerId,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
        flowId: `enrichment:${SUMMARY_JOB_ID}`,
      },
    });
    const summary = clampSummary(response.content.trim());
    if (summary.length === 0) {
      return {
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        model: response.model,
      };
    }
    return {
      patch: { meetingSummaryNote: summary } as Partial<CalendarEventPayload>,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      model: response.model,
    };
  },
};

export const calendarEventEnrichmentJobs: readonly EnrichmentJob<CalendarEventPayload>[] = [
  calendarAttendeeContactsJob,
  calendarSummaryJob,
];

// ---------------------------------------------------------------------------
// LLM fallback for attendees
// ---------------------------------------------------------------------------

interface AttendeeLlmPick {
  readonly contactId: string | null;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly model?: string;
}

async function askAttendeeLlm(
  event: Entity<CalendarEventPayload>,
  attendee: CalendarAttendee,
  candidates: readonly Entity<ContactPayload>[],
  ctx: EnrichmentJobContext<CalendarEventPayload>,
): Promise<AttendeeLlmPick> {
  // Sanitise: contact slug + title + primary email only. No notes,
  // no addresses, no company link payloads.
  const candidateView = candidates.map((c) => ({
    id: c.id,
    title: c.title,
    primaryEmail: primaryEmailOf(c.payload),
  }));
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You match a meeting attendee to one contact from a candidate list. ' +
      'Return ONLY a JSON object with keys "id" and "confidence". ' +
      '"id" is one of the candidate ids or the literal string "none". ' +
      '"confidence" is a number between 0 and 1. ' +
      'Be conservative: prefer "none" with confidence 0.0 when uncertain.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      `Attendee: ${JSON.stringify({ value: attendee.value, displayName: attendee.displayName ?? null })}`,
      `Event title: ${event.title}`,
      `Candidates: ${JSON.stringify(candidateView)}`,
      'Return the JSON.',
    ].join('\n'),
  };
  const response = await ctx.llm.chat({
    messages: [sys, user],
    metadata: {
      layerId: ctx.layerId,
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      flowId: 'enrichment:calendar.attendeeContacts',
    },
  });
  const parsed = safeParseJson(response.content);
  const base: AttendeeLlmPick = {
    contactId: null,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    model: response.model,
  };
  if (parsed === null || typeof parsed !== 'object') return base;
  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  if (id === '' || id.toLowerCase() === 'none') return base;
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_THRESHOLD) return base;
  const pick = candidates.find((c) => c.id === id);
  if (pick === undefined) return base;
  return { ...base, contactId: pick.id };
}

// ---------------------------------------------------------------------------
// Summary prompt
// ---------------------------------------------------------------------------

function hasSummarisableContent(payload: CalendarEventPayload): boolean {
  if (payload.description !== undefined && payload.description.trim().length > 0) return true;
  if (payload.location !== undefined && payload.location.trim().length > 0) return true;
  if (payload.conferenceUrl !== undefined && payload.conferenceUrl.length > 0) return true;
  if (payload.attendees !== undefined && payload.attendees.length > 1) return true;
  return false;
}

function buildSummaryMessages(event: Entity<CalendarEventPayload>): readonly ChatMessage[] {
  // Strip everything that could carry a secret — connector configs live
  // on the bus and on `entity_external_links.payload_json`, NOT on the
  // entity payload. We still drop any field the prompt does not need.
  const view = {
    title: event.title,
    startsAt: event.payload.startsAt,
    endsAt: event.payload.endsAt ?? null,
    allDay: event.payload.allDay,
    location: event.payload.location ?? null,
    description: event.payload.description ?? null,
    conferenceUrl: event.payload.conferenceUrl ?? null,
    attendees:
      event.payload.attendees?.map((a) => ({
        value: a.value,
        displayName: a.displayName ?? null,
        status: a.status,
      })) ?? [],
  };
  const sys: ChatMessage = {
    role: 'system',
    content:
      'You write very short meeting summaries (≤500 characters). ' +
      'Return ONLY the summary text, no quotes, no markdown.',
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      `Meeting view: ${JSON.stringify(view)}`,
      'Write a concise meeting note. ≤500 characters. English unless the existing data is clearly in another language.',
    ].join('\n'),
  };
  return [sys, user];
}

function clampSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_LEN) return text;
  return `${text.slice(0, SUMMARY_MAX_LEN - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

function listContactsInLayer(
  ctx: EnrichmentJobContext<CalendarEventPayload>,
): readonly Entity<ContactPayload>[] {
  const contactModule = getEntityModule('contact') as EntityModule<ContactPayload> | null;
  if (contactModule === null) return [];
  const store = createEntityStore<ContactPayload>({
    module: contactModule,
    db: ctx.db,
    bus: ctx.bus,
    llm: ctx.llm,
  });
  const summaries: readonly EntitySummary[] = store.listSummaries([ctx.layerId], { limit: 500 });
  const out: Entity<ContactPayload>[] = [];
  for (const s of summaries) {
    const entity = store.getById(s.id);
    if (entity === null) continue;
    if (entity.meta.deletedAt !== null) continue;
    out.push(entity);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Idempotence (reads the soul stamp the runner writes via recordLastEnriched)
// ---------------------------------------------------------------------------

function lastSummaryVersion(
  ctx: EnrichmentJobContext<CalendarEventPayload>,
  entityId: string,
): number {
  const row = ctx.db
    .query<
      { memory_json: string },
      [string]
    >(`SELECT memory_json FROM entity_souls WHERE entity_id = ?`)
    .get(entityId);
  if (row === null) return 0;
  try {
    const parsed = JSON.parse(row.memory_json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const byJob = (parsed as Record<string, unknown>)['lastEnrichedAtVersionByJob'];
    if (byJob === null || typeof byJob !== 'object' || Array.isArray(byJob)) return 0;
    const v = (byJob as Record<string, unknown>)[SUMMARY_JOB_ID];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function contactEmailMatches(contact: Entity<ContactPayload>, lowercaseEmail: string): boolean {
  const emails = contact.payload.emails;
  if (emails === undefined) return false;
  for (const e of emails) {
    if (e.value.toLowerCase() === lowercaseEmail) return true;
  }
  return false;
}

function primaryEmailOf(payload: ContactPayload): string | null {
  const emails = payload.emails;
  if (emails === undefined || emails.length === 0) return null;
  const primary = emails.find((e) => e.isPrimary === true);
  return primary?.value ?? emails[0]?.value ?? null;
}

function nameNeedleFor(attendee: CalendarAttendee): string | null {
  const candidate =
    attendee.displayName !== undefined && attendee.displayName.length > 0
      ? attendee.displayName
      : EMAIL_LIKE_RE.test(attendee.value)
        ? null
        : attendee.value;
  if (candidate === null) return null;
  const norm = normaliseName(candidate);
  return norm.length === 0 ? null : norm;
}

function contactNameMatches(contact: Entity<ContactPayload>, needle: string): boolean {
  for (const n of contactNameCandidates(contact)) {
    if (n === needle) return true;
    if (levenshtein(n, needle) <= FUZZY_DISTANCE) return true;
  }
  return false;
}

function contactNameCandidates(contact: Entity<ContactPayload>): readonly string[] {
  const out: string[] = [];
  const push = (v: string | undefined | null): void => {
    if (v === undefined || v === null) return;
    const n = normaliseName(v);
    if (n.length > 0) out.push(n);
  };
  push(contact.payload.displayName);
  push(contact.payload.givenName);
  push(contact.payload.familyName);
  if (contact.payload.givenName !== undefined && contact.payload.familyName !== undefined) {
    push(`${contact.payload.givenName} ${contact.payload.familyName}`);
  }
  push(contact.title);
  return out;
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n] ?? 0;
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
