/**
 * Phase 4c.5 — pure-logic tests for the Calendar event detail page.
 *
 * Mirrors `contacts-detail-page.test.ts`: covers the reducer, the
 * draft↔payload bridge, the validator (including endsBeforeStarts,
 * allDayFormat, attendeeDuplicate), the attendee array editor, the
 * allDay flip behaviour, the meetingSummaryNote preservation
 * invariant (the field is owned by the 4c.3 enrichment runner and the
 * UI must NEVER drop it on save), and the contacts id → slug map
 * helper used by the attendee chip.
 */
import { describe, expect, it } from 'bun:test';
import type { CalendarEvent, EntitySummary } from '../src/lib/api-types';
import {
  addAttendee,
  buildCreateCalendarEventRequest,
  buildUpdateCalendarEventRequest,
  calendarEventDetailView,
  contactIdToSlugMap,
  draftFromCalendarEvent,
  emptyCalendarEventFormDraft,
  removeAttendee,
  setAllDay,
  updateAttendee,
  validateCalendarEventForm,
} from '../src/pages/calendar-page-state';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const base: CalendarEvent = {
    id: '00000000-0000-0000-0000-000000000010',
    kind: 'calendar_event',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'kickoff',
    title: 'Kickoff',
    subtitle: null,
    searchableText: 'kickoff',
    meta: {
      createdAt: '2026-05-23T00:00:00.000Z',
      createdBy: '00000000-0000-0000-0000-0000000000bb',
      updatedAt: '2026-05-24T10:00:00.000Z',
      updatedBy: '00000000-0000-0000-0000-0000000000bb',
      deletedAt: null,
      deletedBy: null,
      version: 2,
      originalLocale: 'en',
    },
    payload: {
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-01T10:00:00.000Z',
      allDay: false,
      location: 'HQ',
      description: 'sync',
      meetingSummaryNote: 'AI: Quarterly kickoff with leadership.',
      attendees: [
        { value: 'alice@example.com', status: 'accepted', displayName: 'Alice' },
        {
          value: 'bob@example.com',
          status: 'needs_action',
          contactEntityId: '00000000-0000-0000-0000-0000000000c1',
        },
      ],
    },
    externalLinks: [],
    ...overrides,
  };
  return base;
}

describe('calendarEventDetailView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(calendarEventDetailView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(calendarEventDetailView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the ready branch with the event envelope', () => {
    const event = makeEvent();
    const view = calendarEventDetailView({ status: 'ready', event });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.event.slug).toBe('kickoff');
    }
  });
});

describe('draftFromCalendarEvent', () => {
  it('populates the form draft from a loaded event payload', () => {
    const d = draftFromCalendarEvent(makeEvent());
    expect(d.title).toBe('Kickoff');
    expect(d.allDay).toBe(false);
    expect(d.location).toBe('HQ');
    expect(d.description).toBe('sync');
    expect(d.meetingSummaryNote).toBe('AI: Quarterly kickoff with leadership.');
    expect(d.attendees).toHaveLength(2);
    expect(d.attendees[0]).toEqual({
      value: 'alice@example.com',
      displayName: 'Alice',
      status: 'accepted',
      contactEntityId: null,
    });
    expect(d.attendees[1]?.contactEntityId).toBe('00000000-0000-0000-0000-0000000000c1');
  });

  it('passes allDay YYYY-MM-DD through verbatim', () => {
    const e = makeEvent({
      payload: { startsAt: '2026-06-01', endsAt: '2026-06-02', allDay: true },
    });
    const d = draftFromCalendarEvent(e);
    expect(d.allDay).toBe(true);
    expect(d.startsAt).toBe('2026-06-01');
    expect(d.endsAt).toBe('2026-06-02');
  });
});

describe('setAllDay', () => {
  it('trims the time component when flipping to allDay', () => {
    const base = draftFromCalendarEvent(makeEvent());
    const flipped = setAllDay(base, true);
    expect(flipped.allDay).toBe(true);
    expect(flipped.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(flipped.endsAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('appends a default time when flipping back to timed', () => {
    const e = makeEvent({
      payload: { startsAt: '2026-06-01', endsAt: '2026-06-01', allDay: true },
    });
    const base = draftFromCalendarEvent(e);
    const flipped = setAllDay(base, false);
    expect(flipped.allDay).toBe(false);
    expect(flipped.startsAt).toBe('2026-06-01T09:00');
    expect(flipped.endsAt).toBe('2026-06-01T09:00');
  });

  it('is a no-op when the flag does not change', () => {
    const d = draftFromCalendarEvent(makeEvent());
    expect(setAllDay(d, false)).toBe(d);
  });
});

describe('attendee array editor', () => {
  it('appends an empty attendee row', () => {
    const d = emptyCalendarEventFormDraft();
    const next = addAttendee(d);
    expect(next.attendees).toHaveLength(1);
    expect(next.attendees[0]).toEqual({
      value: '',
      displayName: '',
      status: 'needs_action',
      contactEntityId: null,
    });
  });

  it('removes the row at index', () => {
    const d = draftFromCalendarEvent(makeEvent());
    expect(d.attendees).toHaveLength(2);
    const after = removeAttendee(d, 0);
    expect(after.attendees).toHaveLength(1);
    expect(after.attendees[0]?.value).toBe('bob@example.com');
  });

  it('is a no-op on out-of-range remove', () => {
    const d = draftFromCalendarEvent(makeEvent());
    expect(removeAttendee(d, 99)).toBe(d);
    expect(removeAttendee(d, -1)).toBe(d);
  });

  it('applies a partial patch to the row at index', () => {
    const d = draftFromCalendarEvent(makeEvent());
    const after = updateAttendee(d, 1, { status: 'declined', displayName: 'Bob' });
    expect(after.attendees[1]?.status).toBe('declined');
    expect(after.attendees[1]?.displayName).toBe('Bob');
    expect(after.attendees[1]?.value).toBe('bob@example.com');
  });
});

describe('validateCalendarEventForm', () => {
  it('returns null for the loaded draft', () => {
    const d = draftFromCalendarEvent(makeEvent());
    expect(validateCalendarEventForm(d)).toBeNull();
  });

  it('rejects an empty title', () => {
    const d = { ...draftFromCalendarEvent(makeEvent()), title: '   ' };
    expect(validateCalendarEventForm(d)).toBe('errors.entity.calendar.validation');
  });

  it('rejects an empty startsAt', () => {
    const d = { ...draftFromCalendarEvent(makeEvent()), startsAt: '' };
    expect(validateCalendarEventForm(d)).toBe('errors.entity.calendar.validation');
  });

  it('rejects allDay startsAt that is not YYYY-MM-DD', () => {
    const d = {
      ...draftFromCalendarEvent(makeEvent()),
      allDay: true,
      startsAt: '2026-06-01T09:00',
      endsAt: '',
    };
    expect(validateCalendarEventForm(d)).toBe('errors.entity.calendar.allDayFormat');
  });

  it('rejects endsAt < startsAt', () => {
    const d = {
      ...draftFromCalendarEvent(makeEvent()),
      startsAt: '2026-06-01T10:00',
      endsAt: '2026-06-01T09:00',
    };
    expect(validateCalendarEventForm(d)).toBe('errors.entity.calendar.endsBeforeStarts');
  });

  it('rejects duplicate attendees by lower-cased value', () => {
    const d = {
      ...draftFromCalendarEvent(makeEvent()),
      attendees: [
        {
          value: 'alice@example.com',
          displayName: '',
          status: 'accepted' as const,
          contactEntityId: null,
        },
        {
          value: 'ALICE@example.com',
          displayName: '',
          status: 'declined' as const,
          contactEntityId: null,
        },
      ],
    };
    expect(validateCalendarEventForm(d)).toBe('errors.entity.calendar.attendeeDuplicate');
  });

  it('rejects a malformed conferenceUrl', () => {
    const d = {
      ...draftFromCalendarEvent(makeEvent()),
      conferenceUrl: 'not a url',
    };
    expect(validateCalendarEventForm(d)).toBe('errors.entity.calendar.validation');
  });

  it('tolerates blank attendee rows', () => {
    const d = {
      ...draftFromCalendarEvent(makeEvent()),
      attendees: [
        { value: '', displayName: '', status: 'needs_action' as const, contactEntityId: null },
      ],
    };
    expect(validateCalendarEventForm(d)).toBeNull();
  });
});

describe('buildCreateCalendarEventRequest', () => {
  it('serialises a timed event to UTC ISO', () => {
    const d = {
      ...emptyCalendarEventFormDraft(),
      title: 'Stand-up',
      slug: 'stand-up',
      // Local-time input. The serializer goes through `new Date(...)` which
      // honours the host TZ; we assert the structure rather than the exact
      // UTC value to keep the test machine-portable.
      startsAt: '2026-06-01T09:00',
      endsAt: '2026-06-01T10:00',
      allDay: false,
    };
    const body = buildCreateCalendarEventRequest(d, 'en');
    expect(body.title).toBe('Stand-up');
    expect(body.slug).toBe('stand-up');
    expect(body.originalLocale).toBe('en');
    expect(body.payload.allDay).toBe(false);
    expect(body.payload.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.payload.endsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('passes allDay dates through verbatim', () => {
    const d = {
      ...emptyCalendarEventFormDraft(),
      title: 'Holiday',
      startsAt: '2026-06-05',
      endsAt: '2026-06-06',
      allDay: true,
    };
    const body = buildCreateCalendarEventRequest(d, 'en');
    expect(body.payload.startsAt).toBe('2026-06-05');
    expect(body.payload.endsAt).toBe('2026-06-06');
    expect(body.payload.allDay).toBe(true);
  });

  it('omits empty slug from the request body', () => {
    const d = {
      ...emptyCalendarEventFormDraft(),
      title: 'A',
      startsAt: '2026-06-05',
      allDay: true,
    };
    const body = buildCreateCalendarEventRequest(d, 'en');
    expect(body.slug).toBeUndefined();
  });

  it('strips empty optional fields', () => {
    const d = {
      ...emptyCalendarEventFormDraft(),
      title: 'A',
      startsAt: '2026-06-05',
      allDay: true,
      summary: '   ',
      description: '',
      location: '',
      conferenceUrl: '',
    };
    const body = buildCreateCalendarEventRequest(d, 'en');
    expect(body.payload.summary).toBeUndefined();
    expect(body.payload.description).toBeUndefined();
    expect(body.payload.location).toBeUndefined();
    expect(body.payload.conferenceUrl).toBeUndefined();
  });

  it('dedupes attendees by lower-cased value', () => {
    const d = {
      ...emptyCalendarEventFormDraft(),
      title: 'A',
      startsAt: '2026-06-05',
      allDay: true,
      attendees: [
        {
          value: 'alice@example.com',
          displayName: 'Alice',
          status: 'accepted' as const,
          contactEntityId: null,
        },
        {
          value: 'ALICE@example.com',
          displayName: 'Alice 2',
          status: 'accepted' as const,
          contactEntityId: null,
        },
      ],
    };
    const body = buildCreateCalendarEventRequest(d, 'en');
    expect(body.payload.attendees).toHaveLength(1);
    expect(body.payload.attendees?.[0]?.value).toBe('alice@example.com');
  });
});

describe('buildUpdateCalendarEventRequest', () => {
  it('preserves meetingSummaryNote from the loaded event even when the draft drops it', () => {
    const event = makeEvent();
    const draft = { ...draftFromCalendarEvent(event), meetingSummaryNote: '' };
    const body = buildUpdateCalendarEventRequest(draft, event);
    expect(body.payload.meetingSummaryNote).toBe(event.payload.meetingSummaryNote);
  });

  it('omits meetingSummaryNote when both the loaded event and the draft are empty', () => {
    const event = makeEvent({
      payload: { startsAt: '2026-06-01T09:00:00.000Z', allDay: false },
    });
    const draft = draftFromCalendarEvent(event);
    const body = buildUpdateCalendarEventRequest(draft, event);
    expect(body.payload.meetingSummaryNote).toBeUndefined();
  });

  it('does not include a slug on update', () => {
    const event = makeEvent();
    const draft = draftFromCalendarEvent(event);
    const body = buildUpdateCalendarEventRequest(draft, event);
    expect((body as { slug?: string }).slug).toBeUndefined();
  });
});

describe('contactIdToSlugMap', () => {
  function summary(id: string, slug: string): EntitySummary {
    return {
      id,
      kind: 'contact',
      layerId: '00000000-0000-0000-0000-0000000000aa',
      slug,
      title: slug,
      subtitle: null,
      searchableText: slug,
      meta: {
        createdAt: '2026-05-23T00:00:00.000Z',
        createdBy: '00000000-0000-0000-0000-0000000000bb',
        updatedAt: '2026-05-24T10:00:00.000Z',
        updatedBy: '00000000-0000-0000-0000-0000000000bb',
        deletedAt: null,
        deletedBy: null,
        version: 1,
        originalLocale: 'en',
      },
    };
  }
  it('builds an id → slug map from a list of contact summaries', () => {
    const m = contactIdToSlugMap([summary('id-1', 'alice'), summary('id-2', 'bob')]);
    expect(m.get('id-1')).toBe('alice');
    expect(m.get('id-2')).toBe('bob');
    expect(m.get('missing')).toBeUndefined();
  });
});
