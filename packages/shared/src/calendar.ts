import { z } from 'zod';

/**
 * Cross-package zod schemas for the calendar-event entity (phase 4c.1).
 *
 * Third concrete kind on top of the §4.0 entity-contract foundation.
 * Mirrors `packages/shared/src/companies.ts` and
 * `packages/shared/src/contacts.ts`: zod schemas live here for the
 * HTTP boundary + the web client; server-internal repo types live in
 * the per-kind table (`0009_calendar_events.sql`) + module
 * (`apps/server/src/entities/calendar/module.ts`).
 *
 * The only field the router enforces as required on the entity row is
 * `title` (handled in `apps/server/src/entities/router.ts` per the
 * §4.0 contract). The calendar payload additionally requires
 * `startsAt` — every event must have a start time. Every other
 * payload field is optional.
 *
 * v1 stance: single-occurrence events. `rruleString` is stored
 * verbatim but NEVER expanded at runtime — the web UI renders only
 * the master occurrence. See §2 of
 * `docs/dev/plans/phase-04-first-entities.md`.
 */

// ---------- payload sub-schemas ----------------------------------------

const ALL_DAY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ATTENDEE_STATUS_VALUES = ['accepted', 'declined', 'tentative', 'needs_action'] as const;

/**
 * One attendee entry inside `payload.attendees[]`.
 *
 * `value` is the canonical key — usually an email when available,
 * else free-text (an external system might surface "Conference
 * Room A" without an address). The 4c.3 enrichment job sets
 * `contactEntityId` to the matched contact in the same layer; the
 * SQL layer stays kind-agnostic and the link is soft (validated at
 * the route-handler level in 4c.3).
 */
export const CalendarAttendeeSchema = z
  .object({
    value: z.string().min(1).max(320),
    displayName: z.string().max(320).optional(),
    contactEntityId: z.string().uuid().optional(),
    status: z.enum(ATTENDEE_STATUS_VALUES).default('needs_action'),
  })
  .strict();
export type CalendarAttendee = z.infer<typeof CalendarAttendeeSchema>;

// ---------- payload schema ---------------------------------------------

/**
 * Calendar-event payload. `startsAt` is REQUIRED; every other field
 * is optional — see file-level doc above.
 *
 * `startsAt` / `endsAt` are ISO-8601 UTC timestamps OR date-only
 * strings (`YYYY-MM-DD`) when `allDay` is true. The `endsAt >=
 * startsAt` check uses a lexicographic string compare — that is sound
 * for ISO-8601 strings because the format is sortable.
 *
 * `rruleString` is opaque — we DO NOT parse it in v1. A future v2
 * will expand recurrence client-side; storing the string verbatim
 * keeps the upgrade path clean.
 *
 * `attendees` is capped at 256 (large but bounded — a corporate
 * all-hands invites that many people). Deduplication is by
 * lowercased `value` so a re-sync from Google Calendar that
 * normalizes case does not create duplicates.
 *
 * `meetingSummaryNote` is reserved for the 4c.3 AI enrichment to
 * write the meeting summary into; the field is never user-set in
 * 4c.1 but is included so the schema is forward-stable.
 */
export const CalendarEventPayloadSchema = z
  .object({
    summary: z.string().max(320).optional(),
    description: z.string().max(8000).optional(),
    location: z.string().max(320).optional(),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1).optional(),
    allDay: z.boolean().default(false),
    rruleString: z.string().max(512).optional(),
    attendees: z.array(CalendarAttendeeSchema).max(256).optional(),
    conferenceUrl: z.string().url().max(1024).optional(),
    externalCalendarId: z.string().max(256).optional(),
    meetingSummaryNote: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    // `endsAt >= startsAt` lexicographically — sound for ISO-8601.
    if (payload.endsAt !== undefined && payload.endsAt < payload.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'endsAt must be greater than or equal to startsAt',
      });
    }
    // All-day events use `YYYY-MM-DD` for startsAt and endsAt (when
    // present). The web UI in 4c.5 relies on the format invariant to
    // skip a Date constructor on every render.
    if (payload.allDay === true) {
      if (!ALL_DAY_DATE_PATTERN.test(payload.startsAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['startsAt'],
          message: 'allDay events require startsAt as YYYY-MM-DD',
        });
      }
      if (payload.endsAt !== undefined && !ALL_DAY_DATE_PATTERN.test(payload.endsAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endsAt'],
          message: 'allDay events require endsAt as YYYY-MM-DD',
        });
      }
    }
    // Dedupe attendees by lowercased `value`. Two entries with the
    // same address but different `displayName`s collapse — the
    // canonical email is the identity, the display name is metadata.
    if (payload.attendees !== undefined) {
      const seen = new Set<string>();
      for (let i = 0; i < payload.attendees.length; i += 1) {
        const v = payload.attendees[i]?.value;
        if (v === undefined) continue;
        const key = v.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['attendees', i, 'value'],
            message: 'duplicate attendee value',
          });
        }
        seen.add(key);
      }
    }
  });
export type CalendarEventPayload = z.infer<typeof CalendarEventPayloadSchema>;

// ---------- HTTP request shapes ----------------------------------------

/**
 * `POST /l/:slug/calendar_event`. Mirrors the §4.0 generic-router
 * body shape (and the 4a.1 companies / 4b.1 contacts create
 * requests): `title` + `originalLocale` are top-level (the router
 * writes them onto the row), `payload` carries the kind-specific
 * data including the required `startsAt`. The slug constraint
 * matches the existing entity slug rule (URL-safe, lowercase, no
 * inadvertent collision with reserved URL paths).
 */
export const CreateCalendarEventRequestSchema = z.object({
  title: z.string().min(1).max(320),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and dashes')
    .optional(),
  originalLocale: z.string().min(1).max(16),
  payload: CalendarEventPayloadSchema,
});
export type CreateCalendarEventRequest = z.infer<typeof CreateCalendarEventRequestSchema>;

/**
 * `PATCH /l/:slug/calendar_event/:eventSlug`. Title is optional (the
 * router preserves the existing title when omitted); `payload` is
 * required because the §4.0 router validates the full payload shape
 * on every PATCH.
 */
export const UpdateCalendarEventRequestSchema = z.object({
  title: z.string().min(1).max(320).optional(),
  payload: CalendarEventPayloadSchema,
});
export type UpdateCalendarEventRequest = z.infer<typeof UpdateCalendarEventRequestSchema>;
