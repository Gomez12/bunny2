/**
 * Phase 4c.5 — pure-logic tests for the Calendar list page.
 *
 * Mirrors `companies-list-page.test.ts` / `contacts-list-page.test.ts`:
 * the web repo has no DOM runtime so the reducer, the URL helpers, the
 * slug rule, and the backend → `react-big-calendar` mapper are exercised
 * directly. The DOM-driven render coverage stays parked behind
 * `docs/dev/follow-ups/web-component-tests.md`.
 */
import { describe, expect, it } from 'bun:test';
import type { CalendarEvent, EntitySummary } from '../src/lib/api-types';
import {
  CALENDAR_SERVER_KIND,
  CALENDAR_WEB_SEGMENT,
  RESERVED_CALENDAR_SLUGS,
  calendarServerBase,
  calendarServerDetail,
  calendarServerExternalLinks,
  calendarServerGoogleIngest,
  slugifyCalendarEventTitle,
  webCalendarEventPath,
  webCalendarNewPath,
  webCalendarPath,
} from '../src/lib/calendar-routes';
import {
  calendarPageView,
  mapEventsToCalendarItems,
  type CalendarPageInput,
} from '../src/pages/calendar-page-state';

function summary(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'calendar_event',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'kickoff',
    title: 'Kickoff',
    subtitle: '2026-06-01T09:00:00Z · HQ',
    searchableText: 'kickoff',
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
    ...overrides,
  };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
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
      version: 1,
      originalLocale: 'en',
    },
    payload: {
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-01T10:00:00.000Z',
      allDay: false,
    },
    externalLinks: [],
    ...overrides,
  };
  return base;
}

describe('calendarPageView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(calendarPageView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const input: CalendarPageInput = { status: 'error', errorKey: 'errors.network' };
    expect(calendarPageView(input)).toEqual({ kind: 'error', errorKey: 'errors.network' });
  });

  it('returns the empty branch when the events list is empty', () => {
    expect(calendarPageView({ status: 'ready', events: [] })).toEqual({ kind: 'empty' });
  });

  it('returns the ready branch with the array when the list is non-empty', () => {
    const view = calendarPageView({ status: 'ready', events: [summary()] });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.events).toHaveLength(1);
    }
  });
});

describe('calendar route helpers', () => {
  it('uses the singular kind for the server URL and the plural segment for web', () => {
    expect(CALENDAR_SERVER_KIND).toBe('calendar_event');
    expect(CALENDAR_WEB_SEGMENT).toBe('calendar');
  });

  it('assembles the web URLs the App router mounts', () => {
    expect(webCalendarPath('p-admin')).toBe('/l/p-admin/calendar');
    expect(webCalendarNewPath('p-admin')).toBe('/l/p-admin/calendar/new');
    expect(webCalendarEventPath('p-admin', 'kickoff')).toBe('/l/p-admin/calendar/kickoff');
  });

  it('assembles the singular server URLs the api helpers hit', () => {
    expect(calendarServerBase('p-admin')).toBe('/l/p-admin/calendar_event');
    expect(calendarServerDetail('p-admin', 'kickoff')).toBe('/l/p-admin/calendar_event/kickoff');
    expect(calendarServerExternalLinks('p-admin', 'kickoff')).toBe(
      '/l/p-admin/calendar_event/kickoff/external-links',
    );
    expect(calendarServerGoogleIngest('p-admin')).toBe(
      '/l/p-admin/calendar_event/_ingest/google.calendar',
    );
  });

  it('encodes layer / event slug components defensively', () => {
    expect(calendarServerDetail('a layer', 'a event')).toBe(
      '/l/a%20layer/calendar_event/a%20event',
    );
  });

  it('reserves the "new" slug so it does not collide with /calendar/new', () => {
    expect(RESERVED_CALENDAR_SLUGS.has('new')).toBe(true);
    expect(slugifyCalendarEventTitle('New')).toBe('new-event');
    expect(slugifyCalendarEventTitle('NEW')).toBe('new-event');
  });

  it('normalises titles to the lowercase-dash slug rule', () => {
    expect(slugifyCalendarEventTitle('Quarterly Review!')).toBe('quarterly-review');
    expect(slugifyCalendarEventTitle('   ')).toBe('');
    expect(slugifyCalendarEventTitle('ÆÆÆ')).toBe('');
  });
});

describe('mapEventsToCalendarItems', () => {
  it('maps timed events to the react-big-calendar shape', () => {
    const items = mapEventsToCalendarItems([event()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '00000000-0000-0000-0000-000000000010',
      slug: 'kickoff',
      title: 'Kickoff',
      allDay: false,
    });
    expect(items[0]?.start).toBeInstanceOf(Date);
    expect(items[0]?.end).toBeInstanceOf(Date);
    expect(items[0]?.start.getUTCHours()).toBe(9);
    expect(items[0]?.end.getUTCHours()).toBe(10);
    expect(items[0]?.resource).toEqual({ id: items[0]!.id, slug: 'kickoff' });
  });

  it('defaults end to start + 1 hour when payload.endsAt is missing', () => {
    const items = mapEventsToCalendarItems([
      event({ payload: { startsAt: '2026-06-01T09:00:00.000Z', allDay: false } }),
    ]);
    expect(items[0]?.end.getTime() - items[0]!.start.getTime()).toBe(60 * 60 * 1000);
  });

  it('treats allDay events as local-midnight on the YYYY-MM-DD date', () => {
    const items = mapEventsToCalendarItems([
      event({
        payload: { startsAt: '2026-06-01', endsAt: '2026-06-02', allDay: true },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.allDay).toBe(true);
    // Local-midnight: hours/min/sec are zero in the user's zone.
    expect(items[0]?.start.getHours()).toBe(0);
    expect(items[0]?.start.getMinutes()).toBe(0);
  });

  it('filters out soft-deleted events', () => {
    const items = mapEventsToCalendarItems([
      event({
        meta: {
          createdAt: '2026-05-23T00:00:00.000Z',
          createdBy: 'u',
          updatedAt: '2026-05-24T10:00:00.000Z',
          updatedBy: 'u',
          deletedAt: '2026-05-25T00:00:00.000Z',
          deletedBy: 'u',
          version: 2,
          originalLocale: 'en',
        },
      }),
    ]);
    expect(items).toHaveLength(0);
  });

  it('skips entries with an unparseable startsAt', () => {
    const items = mapEventsToCalendarItems([
      event({ payload: { startsAt: 'not-a-date', allDay: false } }),
    ]);
    expect(items).toHaveLength(0);
  });

  it('rejects allDay timestamps that are not YYYY-MM-DD', () => {
    const items = mapEventsToCalendarItems([
      event({ payload: { startsAt: '2026-06-01T09:00:00Z', allDay: true } }),
    ]);
    expect(items).toHaveLength(0);
  });
});
