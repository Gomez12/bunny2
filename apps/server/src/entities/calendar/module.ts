import type { ZodType } from 'zod';
import { CalendarEventPayloadSchema, type CalendarEventPayload } from '@bunny2/shared';
import type { EntityModule } from '../module';
import type { EntityConnector } from '../connectors/base';

/**
 * Phase 4c.1 — third concrete `EntityModule`.
 *
 * Wires:
 *  - `kind = 'calendar_event'` — the bus event prefix
 *    (`entity.calendar_event.*`) and the URL segment
 *    (`/l/:slug/calendar_event/...`, singular per the §4.0 router
 *    naming; the 4c.5 web UI surfaces a friendlier
 *    `/l/:slug/calendar` page that calls this URL underneath).
 *  - `tableName = 'calendar_events'` — the per-kind table created in
 *    `0009_calendar_events.sql`.
 *  - `payloadSchema` — the cross-package zod schema from
 *    `packages/shared/src/calendar.ts`.
 *  - `indexedColumns` — five denormalized columns the generic store
 *    writes on every insert/update: `starts_at`, `ends_at`,
 *    `all_day`, `rrule_string`, `external_calendar_id`. Note that
 *    `all_day` is the FIRST non-TEXT indexed column the §4.0
 *    foundation accepts — the `IndexedValue = string | number | null`
 *    type space already covers integer projections, so 4c.1 needs
 *    ZERO foundation tweaks. See
 *    `docs/dev/architecture/entities.md` §10g.
 *  - `toSummary` — picks a sensible subtitle (start time + optional
 *    location) so the listing page is useful without opening detail
 *    view. The web UI in 4c.5 formats the timestamp with the user's
 *    locale; the server keeps the raw ISO-8601 string.
 *  - `searchableText` — lowercase, space-joined digest of the fields
 *    a user is most likely to search for (summary, description,
 *    location, attendees' values + displayNames, conferenceUrl).
 *
 * No connectors / enrichment jobs / stats provider in 4c.1 — the
 * Google Calendar connector lands in 4c.2, the meeting-summary +
 * attendee-link enrichment in 4c.3, the dashboard widget in 4c.4.
 * The `createCalendarEventModule(opts)` factory shape mirrors the
 * 4a.1 / 4b.1 precedents so those sub-phases stay additive.
 */
export const CALENDAR_EVENT_KIND = 'calendar_event';
export const CALENDAR_EVENT_TABLE = 'calendar_events';

const SUBTITLE_MAX_LENGTH = 120;

/**
 * Phase 4c.2 — extended for the Google Calendar connector. The factory
 * accepts an optional connector list (default: no connectors, because
 * the Google connector requires a `SecretsService` dep that production
 * wiring constructs from `config.secrets.encryptionKey`; tests inject
 * their own list with a stubbed-fetch + stubbed-secrets connector).
 * 4c.3 (meeting-summary + attendee-link enrichment) will extend this
 * shape additively with `enrichmentJobs`.
 */
export interface CreateCalendarEventModuleOptions {
  readonly connectors?: readonly EntityConnector<CalendarEventPayload>[];
}

/**
 * Build a fresh `calendarEventModule`. Production wiring calls this
 * once at boot (via `registerCalendarEventModule`); tests call it
 * per-fixture so they can later inject stubs without colliding on
 * registry state. The default export `calendarEventModule` uses the
 * no-deps factory call.
 */
export function createCalendarEventModule(
  opts: CreateCalendarEventModuleOptions = {},
): EntityModule<CalendarEventPayload> {
  return {
    kind: CALENDAR_EVENT_KIND,
    tableName: CALENDAR_EVENT_TABLE,
    ...(opts.connectors === undefined ? {} : { connectors: opts.connectors }),
    // The shared schema has `allDay: z.boolean().default(false)` so
    // its input type is `boolean | undefined` while the parsed type
    // is `boolean`. The `EntityModule<Payload>` slot wants
    // `ZodType<Payload>` — the output side. Cast through the parsed
    // type so the input/output asymmetry stays inside the schema and
    // out of the module surface. (Companies and contacts have no
    // defaults so they don't hit this — first time a calendar-style
    // default lands.)
    payloadSchema: CalendarEventPayloadSchema as unknown as ZodType<CalendarEventPayload>,
    indexedColumns: [
      {
        name: 'starts_at',
        // `startsAt` is required at the zod layer, so this never
        // returns null in practice — the column is `NOT NULL` in
        // the migration. The fallback exists only to satisfy the
        // `string | number | null` slot type.
        extract: (payload) => payload.startsAt,
      },
      {
        name: 'ends_at',
        extract: (payload) => payload.endsAt ?? null,
      },
      {
        name: 'all_day',
        // The headline 4c.1 finding: the foundation's
        // `IndexedValue = string | number | null` type space accepts
        // an integer projection without modification. Booleans get
        // projected to 0 / 1 here; SQLite stores the result in an
        // `INTEGER` column natively.
        extract: (payload) => (payload.allDay === true ? 1 : 0),
      },
      {
        name: 'rrule_string',
        extract: (payload) => payload.rruleString ?? null,
      },
      {
        name: 'external_calendar_id',
        extract: (payload) => payload.externalCalendarId ?? null,
      },
    ],
    toSummary({ ref, meta, payload, title }) {
      const start = payload.startsAt;
      const locationPart =
        payload.location !== undefined && payload.location.length > 0
          ? ` · ${payload.location}`
          : '';
      const subtitleRaw = `${start}${locationPart}`;
      const subtitle =
        subtitleRaw.length > SUBTITLE_MAX_LENGTH
          ? `${subtitleRaw.slice(0, SUBTITLE_MAX_LENGTH - 1)}…`
          : subtitleRaw;
      return {
        ...ref,
        meta,
        title,
        subtitle,
        searchableText: searchableTextFor(payload),
      };
    },
    searchableText(payload) {
      return searchableTextFor(payload);
    },
  };
}

export const calendarEventModule: EntityModule<CalendarEventPayload> = createCalendarEventModule();

function searchableTextFor(payload: CalendarEventPayload): string {
  const parts: string[] = [];
  if (payload.summary !== undefined) parts.push(payload.summary);
  if (payload.description !== undefined) parts.push(payload.description);
  if (payload.location !== undefined) parts.push(payload.location);
  if (payload.attendees !== undefined) {
    for (const a of payload.attendees) {
      parts.push(a.value);
      if (a.displayName !== undefined) parts.push(a.displayName);
    }
  }
  if (payload.conferenceUrl !== undefined) parts.push(payload.conferenceUrl);
  // Lowercase the digest because the §4.0 store's `searchSummaries`
  // lowercases the query before substring-matching. Keeping both
  // sides lowercase is what makes "rotterdam" find an event with
  // `location: 'Rotterdam'`.
  return parts.join(' ').toLowerCase();
}
