/**
 * Phase 4c.5 — pure helpers for the calendar pages.
 *
 * Same rationale as `companies-page-state.ts` / `contacts-page-state.ts`:
 * the web repo has no DOM runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so per-page logic is
 * factored into pure functions exercised by `bun test`.
 *
 *  - `calendarPageView` / `calendarEventDetailView` — load-state reducers.
 *  - `mapEventsToCalendarItems` — backend `EntitySummary[]` (or full
 *    `CalendarEvent[]`) → the `{id,title,start,end,allDay,resource}`
 *    shape `react-big-calendar` consumes.
 *  - `validateCalendarEventForm` — inline form validation mirroring
 *    `CalendarEventPayloadSchema`.
 *  - `buildCreateCalendarEventRequest` / `buildUpdateCalendarEventRequest`
 *    — produce the JSON bodies the server expects. Critically, the update
 *    builder preserves `meetingSummaryNote` from the loaded event
 *    because the field is owned by the 4c.3 enrichment runner and the
 *    UI never edits it — see the per-test assertion in
 *    `calendar-event-detail-page.test.ts`.
 *  - `addAttendee` / `removeAttendee` / `updateAttendee` — attendee
 *    array editor reducers, mirroring the email/phone editors on
 *    contacts.
 *
 * Timezone v1 stance: drafts hold the user's local-time string (the
 * `<input type="datetime-local">` shape `YYYY-MM-DDTHH:mm`) and we
 * serialise to UTC ISO (`Z` suffix) via `new Date(...).toISOString()`
 * at submit time. All-day events carry a `YYYY-MM-DD` string verbatim.
 * A per-layer / per-user timezone preference is a 4c.6+ follow-up
 * (see the close-out and `docs/dev/follow-ups/calendar-timezone-v1.md`).
 */
import type {
  CalendarAttendee,
  CalendarAttendeeStatus,
  CalendarEvent,
  CalendarEventPayload,
  CreateCalendarEventPayload,
  EntitySummary,
  UpdateCalendarEventPayload,
} from '../lib/api-types';

// ---------- list page ------------------------------------------------------

export type CalendarPageInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly events: readonly EntitySummary[] };

export type CalendarPageView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly events: readonly EntitySummary[] };

export function calendarPageView(input: CalendarPageInput): CalendarPageView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.events.length === 0) return { kind: 'empty' };
  return { kind: 'ready', events: input.events };
}

// ---------- detail page ----------------------------------------------------

export type CalendarEventDetailInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly event: CalendarEvent };

export type CalendarEventDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly event: CalendarEvent };

export function calendarEventDetailView(input: CalendarEventDetailInput): CalendarEventDetailView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  return { kind: 'ready', event: input.event };
}

// ---------- mapper: backend → react-big-calendar ---------------------------

/**
 * Backend payload shape (a summary plus the kind-specific payload) →
 * the `{id, title, start, end, allDay, resource}` shape the grid
 * consumes. `start` / `end` are real `Date` instances per the library
 * contract.
 *
 * Behaviour:
 *  - `allDay` events: `start = new Date('YYYY-MM-DD')` resolves to
 *    UTC-midnight which `react-big-calendar` displays in the all-day
 *    band. `end` defaults to `start` when missing.
 *  - Timed events: `start = new Date(isoString)` — the library renders
 *    using `localizer`'s timezone (the user's browser zone for v1).
 *    `end` defaults to `start + 1h` when the payload omits it.
 *  - Soft-deleted events are filtered out (the list endpoint already
 *    excludes them, but we defend on the client too).
 *
 * Returns a fresh array; safe to call inside `useMemo`. The mapper does
 * not allocate `Date` objects for soft-deleted rows.
 */
export interface CalendarGridItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  /** Original entity reference (id + slug) so click handlers can navigate. */
  readonly resource: { readonly id: string; readonly slug: string };
}

export interface MappableEventLike {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly payload: CalendarEventPayload;
  readonly meta?: { readonly deletedAt: string | null };
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export function mapEventsToCalendarItems(
  events: readonly MappableEventLike[],
): readonly CalendarGridItem[] {
  const out: CalendarGridItem[] = [];
  for (const e of events) {
    if (e.meta !== undefined && e.meta.deletedAt !== null) continue;
    const p = e.payload;
    const allDay = p.allDay === true;
    const startMs = parseTimestampToMs(p.startsAt, allDay);
    if (startMs === null) continue;
    let endMs: number;
    if (p.endsAt !== undefined && p.endsAt.length > 0) {
      const parsed = parseTimestampToMs(p.endsAt, allDay);
      endMs = parsed ?? startMs + ONE_HOUR_MS;
    } else {
      endMs = allDay ? startMs : startMs + ONE_HOUR_MS;
    }
    out.push({
      id: e.id,
      slug: e.slug,
      title: e.title,
      start: new Date(startMs),
      end: new Date(endMs),
      allDay,
      resource: { id: e.id, slug: e.slug },
    });
  }
  return out;
}

function parseTimestampToMs(value: string, allDay: boolean): number | null {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    // Treat all-day dates as the user's local midnight so the grid
    // renders them on the intended day across timezones. ISO parsing
    // (`new Date('YYYY-MM-DD')`) anchors to UTC midnight which can
    // shift one day in negative-offset zones.
    const [y, m, d] = value.split('-').map((s) => Number.parseInt(s, 10));
    if (
      !Number.isFinite(y) ||
      !Number.isFinite(m) ||
      !Number.isFinite(d) ||
      y === undefined ||
      m === undefined ||
      d === undefined
    )
      return null;
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ---------- form draft -----------------------------------------------------

export interface AttendeeDraft {
  readonly value: string;
  readonly displayName: string;
  readonly status: CalendarAttendeeStatus;
  readonly contactEntityId: string | null;
}

export interface CalendarEventFormDraft {
  readonly title: string;
  readonly slug?: string;
  readonly summary: string;
  readonly description: string;
  readonly location: string;
  readonly allDay: boolean;
  /**
   * `<input type="datetime-local">` shape (`YYYY-MM-DDTHH:mm`) when
   * `allDay` is false. `YYYY-MM-DD` when `allDay` is true. Trimmed at
   * submit.
   */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly conferenceUrl: string;
  readonly attendees: readonly AttendeeDraft[];
  /** Read-only display fields preserved through the draft round-trip. */
  readonly rruleString: string;
  readonly externalCalendarId: string;
  readonly meetingSummaryNote: string;
}

export function emptyCalendarEventFormDraft(): CalendarEventFormDraft {
  return {
    title: '',
    slug: '',
    summary: '',
    description: '',
    location: '',
    allDay: false,
    startsAt: '',
    endsAt: '',
    conferenceUrl: '',
    attendees: [],
    rruleString: '',
    externalCalendarId: '',
    meetingSummaryNote: '',
  };
}

export function emptyAttendeeDraft(): AttendeeDraft {
  return { value: '', displayName: '', status: 'needs_action', contactEntityId: null };
}

function attendeeDraftFromPayload(a: CalendarAttendee): AttendeeDraft {
  return {
    value: a.value,
    displayName: a.displayName ?? '',
    status: a.status ?? 'needs_action',
    contactEntityId: a.contactEntityId ?? null,
  };
}

export function draftFromCalendarEvent(event: CalendarEvent): CalendarEventFormDraft {
  const p = event.payload;
  const allDay = p.allDay === true;
  return {
    title: event.title,
    slug: event.slug,
    summary: p.summary ?? '',
    description: p.description ?? '',
    location: p.location ?? '',
    allDay,
    startsAt: toInputFormat(p.startsAt, allDay),
    endsAt: p.endsAt !== undefined ? toInputFormat(p.endsAt, allDay) : '',
    conferenceUrl: p.conferenceUrl ?? '',
    attendees: (p.attendees ?? []).map(attendeeDraftFromPayload),
    rruleString: p.rruleString ?? '',
    externalCalendarId: p.externalCalendarId ?? '',
    meetingSummaryNote: p.meetingSummaryNote ?? '',
  };
}

/**
 * Convert a server-stored timestamp to the value an `<input type="..."`
 * expects:
 *  - All-day → `YYYY-MM-DD` (unchanged).
 *  - Timed → `YYYY-MM-DDTHH:mm` in the user's local timezone. The
 *    server stores ISO UTC; we render local time so the user sees the
 *    wall-clock value they entered.
 */
function toInputFormat(iso: string, allDay: boolean): string {
  if (allDay) return iso;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${day}T${hh}:${mm}`;
}

// ---------- attendee array editor ------------------------------------------

export function addAttendee(draft: CalendarEventFormDraft): CalendarEventFormDraft {
  return { ...draft, attendees: [...draft.attendees, emptyAttendeeDraft()] };
}

export function removeAttendee(
  draft: CalendarEventFormDraft,
  index: number,
): CalendarEventFormDraft {
  if (index < 0 || index >= draft.attendees.length) return draft;
  return { ...draft, attendees: draft.attendees.filter((_, i) => i !== index) };
}

export function updateAttendee(
  draft: CalendarEventFormDraft,
  index: number,
  patch: Partial<AttendeeDraft>,
): CalendarEventFormDraft {
  if (index < 0 || index >= draft.attendees.length) return draft;
  const next = draft.attendees.map((a, i) => (i === index ? { ...a, ...patch } : a));
  return { ...draft, attendees: next };
}

/**
 * Flip the all-day toggle on the draft, normalising start / end:
 *  - allDay → all-day: trim time component (`...T10:00` → `...`).
 *  - allDay → timed:   append `T09:00` so the input control has a
 *    valid value the user can tweak.
 */
export function setAllDay(draft: CalendarEventFormDraft, allDay: boolean): CalendarEventFormDraft {
  if (draft.allDay === allDay) return draft;
  function flip(value: string): string {
    if (value.length === 0) return value;
    if (allDay) {
      // YYYY-MM-DDTHH:mm → YYYY-MM-DD
      const tIdx = value.indexOf('T');
      return tIdx > 0 ? value.slice(0, tIdx) : value;
    }
    // YYYY-MM-DD → YYYY-MM-DDT09:00 (default)
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T09:00` : value;
  }
  return { ...draft, allDay, startsAt: flip(draft.startsAt), endsAt: flip(draft.endsAt) };
}

// ---------- validation -----------------------------------------------------

/**
 * Inline form validation mirroring `CalendarEventPayloadSchema`. Returns
 * the i18n key of the first failure, or `null` when the draft is
 * shippable. The server re-validates every payload; this helper just
 * trims the round-trip for the obvious cases.
 */
export function validateCalendarEventForm(draft: CalendarEventFormDraft): string | null {
  if (draft.title.trim().length === 0) {
    return 'errors.entity.calendar.validation';
  }
  if (draft.startsAt.trim().length === 0) {
    return 'errors.entity.calendar.validation';
  }
  if (draft.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startsAt.trim())) {
      return 'errors.entity.calendar.allDayFormat';
    }
    if (draft.endsAt.trim().length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(draft.endsAt.trim())) {
      return 'errors.entity.calendar.allDayFormat';
    }
  }
  // endsAt >= startsAt lexicographically (input shapes are ISO-sortable
  // both for `YYYY-MM-DD` and `YYYY-MM-DDTHH:mm`).
  if (draft.endsAt.trim().length > 0 && draft.endsAt.trim() < draft.startsAt.trim()) {
    return 'errors.entity.calendar.endsBeforeStarts';
  }
  // Attendee dedup by lower-cased value (the server schema enforces the
  // same rule); empty attendee rows are tolerated.
  const seen = new Set<string>();
  for (const a of draft.attendees) {
    const v = a.value.trim();
    if (v.length === 0) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) return 'errors.entity.calendar.attendeeDuplicate';
    seen.add(key);
  }
  if (draft.description.length > 8000) {
    return 'errors.entity.calendar.validation';
  }
  if (draft.conferenceUrl.trim().length > 0 && !isProbablyUrl(draft.conferenceUrl.trim())) {
    return 'errors.entity.calendar.validation';
  }
  return null;
}

function isProbablyUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ---------- payload builders -----------------------------------------------

/**
 * Convert a local-time `<input type="datetime-local">` value
 * (`YYYY-MM-DDTHH:mm`) to a UTC ISO string with `Z` suffix. For all-day
 * events the date is passed through verbatim.
 */
function serializeTimestamp(value: string, allDay: boolean): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  if (allDay) return trimmed; // `YYYY-MM-DD` per the schema's allDay branch.
  // `new Date('YYYY-MM-DDTHH:mm')` interprets the value in the user's
  // local timezone — which is what we want for v1. `toISOString` then
  // serialises to UTC (`Z`).
  const d = new Date(trimmed);
  if (!Number.isFinite(d.getTime())) return trimmed; // let the server reject it
  return d.toISOString();
}

function buildAttendees(drafts: readonly AttendeeDraft[]): readonly CalendarAttendee[] | undefined {
  const out: CalendarAttendee[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const value = d.value.trim();
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: {
      value: string;
      displayName?: string;
      contactEntityId?: string;
      status: CalendarAttendeeStatus;
    } = { value, status: d.status };
    const displayName = d.displayName.trim();
    if (displayName.length > 0) entry.displayName = displayName;
    if (d.contactEntityId !== null && d.contactEntityId.length > 0) {
      entry.contactEntityId = d.contactEntityId;
    }
    out.push(entry as CalendarAttendee);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build the payload portion of a create/update request. The optional
 * `preserve` argument carries forward read-only fields the runner owns
 * (currently `meetingSummaryNote`) so a save does not wipe AI output.
 */
function buildPayload(
  draft: CalendarEventFormDraft,
  preserve?: { meetingSummaryNote?: string },
): CalendarEventPayload {
  const payload: Record<string, unknown> = {
    startsAt: serializeTimestamp(draft.startsAt, draft.allDay),
    allDay: draft.allDay,
  };
  function pick(key: keyof CalendarEventPayload, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length > 0) payload[key] = trimmed;
  }
  pick('summary', draft.summary);
  pick('description', draft.description);
  pick('location', draft.location);
  pick('conferenceUrl', draft.conferenceUrl);
  pick('rruleString', draft.rruleString);
  pick('externalCalendarId', draft.externalCalendarId);
  const endsAtSerialized = serializeTimestamp(draft.endsAt, draft.allDay);
  if (endsAtSerialized.length > 0) payload.endsAt = endsAtSerialized;
  const attendees = buildAttendees(draft.attendees);
  if (attendees !== undefined) payload.attendees = attendees;
  // Preserve runner-owned fields when the draft was loaded from a real
  // event — see file-level doc. The draft also stores the value on
  // `meetingSummaryNote` for re-display; we prefer the explicit
  // `preserve` argument so the create path (no preserve) does not
  // accidentally forward a stale value.
  const note = preserve?.meetingSummaryNote ?? draft.meetingSummaryNote;
  if (note.trim().length > 0) payload.meetingSummaryNote = note;
  return payload as unknown as CalendarEventPayload;
}

export function buildCreateCalendarEventRequest(
  draft: CalendarEventFormDraft,
  originalLocale: string,
): CreateCalendarEventPayload {
  const out: {
    title: string;
    slug?: string;
    originalLocale: string;
    payload: CalendarEventPayload;
  } = {
    title: draft.title.trim(),
    originalLocale,
    payload: buildPayload(draft),
  };
  if (draft.slug !== undefined && draft.slug.trim().length > 0) {
    out.slug = draft.slug.trim();
  }
  return out;
}

export function buildUpdateCalendarEventRequest(
  draft: CalendarEventFormDraft,
  loadedEvent?: CalendarEvent,
): UpdateCalendarEventPayload {
  const preserve =
    loadedEvent !== undefined
      ? {
          meetingSummaryNote: loadedEvent.payload.meetingSummaryNote ?? '',
        }
      : undefined;
  return {
    title: draft.title.trim(),
    payload: buildPayload(draft, preserve),
  };
}

// ---------- contact-lookup helpers ----------------------------------------

/**
 * Build a quick id → slug map from a list of contact summaries so the
 * attendee chip can deep-link to the contact detail page without
 * fetching each contact individually.
 */
export function contactIdToSlugMap(
  contacts: readonly EntitySummary[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const c of contacts) {
    map.set(c.id, c.slug);
  }
  return map;
}
