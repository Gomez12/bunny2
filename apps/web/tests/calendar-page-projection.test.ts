/**
 * Phase 4d.6 — pure-logic tests for the todo → calendar projection
 * client side of the bridge.
 *
 * Covers:
 *   - `mapTodoProjectionsToCalendarItems` — maps the server projection
 *     shape to the `react-big-calendar` event shape with
 *     `allDay: true` and a `todo_projection` resource discriminator.
 *   - `mergeCalendarFeed` — concat + stable-sort by `start ASC, id ASC`.
 *
 * Mirrors `apps/web/tests/calendar-page.test.ts` shape — pure
 * functions only; the DOM-driven render coverage stays parked behind
 * `docs/dev/follow-ups/web-component-tests.md`.
 */
import { describe, expect, it } from 'bun:test';
import {
  mapEventsToCalendarItems,
  mapTodoProjectionsToCalendarItems,
  mergeCalendarFeed,
  type CalendarGridItem,
  type MappableEventLike,
  type TodoProjectionLike,
} from '../src/pages/calendar-page-state';

function eventLike(overrides: Partial<MappableEventLike> = {}): MappableEventLike {
  const base: MappableEventLike = {
    id: '00000000-0000-0000-0000-000000000010',
    slug: 'meeting',
    title: 'Meeting',
    payload: {
      startsAt: '2026-06-05T09:00:00.000Z',
      endsAt: '2026-06-05T10:00:00.000Z',
      allDay: false,
    },
    ...overrides,
  };
  return base;
}

function projectionLike(overrides: Partial<TodoProjectionLike> = {}): TodoProjectionLike {
  return {
    todoId: '11111111-1111-1111-1111-111111111111',
    todoSlug: 'call-ami-bv',
    title: 'Call AMI BV',
    dueAt: '2026-06-10',
    priority: 2,
    status: 'open',
    ...overrides,
  };
}

describe('mapTodoProjectionsToCalendarItems', () => {
  it('maps a date-only dueAt to an all-day event anchored at local midnight', () => {
    const items = mapTodoProjectionsToCalendarItems([projectionLike()]);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.allDay).toBe(true);
    expect(item.title).toBe('Call AMI BV');
    expect(item.id).toBe('todo-projection:11111111-1111-1111-1111-111111111111');
    expect(item.slug).toBe('call-ami-bv');
    expect(item.start.getFullYear()).toBe(2026);
    expect(item.start.getMonth()).toBe(5); // June (0-indexed)
    expect(item.start.getDate()).toBe(10);
    expect(item.start.getHours()).toBe(0);
    expect(item.start.getMinutes()).toBe(0);
  });

  it('uses todo_projection as the resource kind discriminator', () => {
    const items = mapTodoProjectionsToCalendarItems([projectionLike()]);
    expect(items[0]?.resource).toEqual({
      kind: 'todo_projection',
      todoId: '11111111-1111-1111-1111-111111111111',
      todoSlug: 'call-ami-bv',
      status: 'open',
      priority: 2,
    });
  });

  it('falls back to date-only when dueAt is an ISO timestamp', () => {
    const items = mapTodoProjectionsToCalendarItems([
      projectionLike({ dueAt: '2026-06-10T14:30:00.000Z' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.allDay).toBe(true);
    expect(items[0]?.start.getDate()).toBe(10);
  });

  it('skips projections with unparseable dueAt strings', () => {
    const items = mapTodoProjectionsToCalendarItems([projectionLike({ dueAt: 'not-a-date' })]);
    expect(items).toHaveLength(0);
  });

  it('returns the same array length as the input (no filter on status)', () => {
    // Bridge already filters by `due_at != null`; the mapper does not
    // filter again on status. A "done" todo with a dueAt still
    // projects — the calendar UI is read-only and the user can see
    // the historic completion date if they choose to.
    const items = mapTodoProjectionsToCalendarItems([
      projectionLike({ status: 'done' }),
      projectionLike({ todoId: 'b', todoSlug: 'b', status: 'cancelled', dueAt: '2026-06-11' }),
      projectionLike({ todoId: 'c', todoSlug: 'c', status: 'open', dueAt: '2026-06-12' }),
    ]);
    expect(items).toHaveLength(3);
  });
});

describe('mergeCalendarFeed', () => {
  function gridEvent(overrides: Partial<CalendarGridItem> = {}): CalendarGridItem {
    return {
      id: 'evt-1',
      slug: 's',
      title: 'E',
      start: new Date(Date.UTC(2026, 5, 5, 9, 0, 0)),
      end: new Date(Date.UTC(2026, 5, 5, 10, 0, 0)),
      allDay: false,
      resource: { kind: 'calendar_event', id: 'evt-1', slug: 's' },
      ...overrides,
    };
  }
  function gridProjection(overrides: Partial<CalendarGridItem> = {}): CalendarGridItem {
    return {
      id: 'todo-projection:t1',
      slug: 't-1',
      title: 'T',
      start: new Date(2026, 5, 10, 0, 0, 0),
      end: new Date(2026, 5, 10, 0, 0, 0),
      allDay: true,
      resource: {
        kind: 'todo_projection',
        todoId: 't1',
        todoSlug: 't-1',
        status: 'open',
        priority: 3,
      },
      ...overrides,
    };
  }

  it('concatenates events and projections', () => {
    const merged = mergeCalendarFeed([gridEvent()], [gridProjection()]);
    expect(merged).toHaveLength(2);
  });

  it('sorts by start ascending', () => {
    const merged = mergeCalendarFeed(
      [gridEvent({ id: 'evt-late', start: new Date(2026, 5, 20, 9, 0, 0) })],
      [gridProjection({ id: 'todo-projection:early', start: new Date(2026, 5, 5, 0, 0, 0) })],
    );
    expect(merged.map((m) => m.id)).toEqual(['todo-projection:early', 'evt-late']);
  });

  it('breaks ties by id ascending so the order is deterministic', () => {
    const sameStart = new Date(2026, 5, 10, 9, 0, 0);
    const merged = mergeCalendarFeed(
      [gridEvent({ id: 'b', start: sameStart })],
      [gridProjection({ id: 'a', start: sameStart })],
    );
    expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('returns an empty feed when both inputs are empty', () => {
    expect(mergeCalendarFeed([], [])).toEqual([]);
  });

  it('preserves the discriminator on each item so the click handler can branch', () => {
    const merged = mergeCalendarFeed([gridEvent()], [gridProjection()]);
    const kinds = merged.map((m) => m.resource.kind).sort();
    expect(kinds).toEqual(['calendar_event', 'todo_projection']);
  });
});

describe('mapEventsToCalendarItems — discriminator update', () => {
  // The 4d.6 change also adds `kind: 'calendar_event'` to the resource
  // shape returned by the existing mapper. Mirror the assertion here
  // so the discriminator stays in sync with the projection mapper.
  it('uses calendar_event as the resource kind discriminator', () => {
    const items = mapEventsToCalendarItems([eventLike()]);
    expect(items[0]?.resource.kind).toBe('calendar_event');
  });
});
