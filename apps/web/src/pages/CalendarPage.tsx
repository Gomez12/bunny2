import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar';
import { format, getDay, parse, startOfWeek } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { nl } from 'date-fns/locale/nl';
import { useNavigate } from 'react-router-dom';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  createCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
  syncGoogleCalendar,
} from '../lib/api';
import type { CalendarEvent as CalendarEventEntity, EntitySummary } from '../lib/api-types';
import {
  slugifyCalendarEventTitle,
  webCalendarEventPath,
  webCalendarNewPath,
} from '../lib/calendar-routes';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  buildCreateCalendarEventRequest,
  calendarPageView,
  emptyCalendarEventFormDraft,
  mapEventsToCalendarItems,
  setAllDay as setAllDayOnDraft,
  validateCalendarEventForm,
  type CalendarEventFormDraft,
  type CalendarPageInput,
  type MappableEventLike,
} from './calendar-page-state';

/**
 * `/l/:layerSlug/calendar` — calendar grid page (phase 4c.5).
 *
 * Fetches the list of events for the layer via `GET
 * /l/:layerSlug/calendar_event`, hydrates the full payload for each
 * (the summary endpoint does not project startsAt / endsAt — the 4a.5
 * "summaryColumns" follow-up tracks the gap), and renders
 * `react-big-calendar` in month / week / day mode. A server-side
 * `?from=&to=` range filter is a tracked follow-up at
 * `docs/dev/follow-ups/calendar-list-range-filter.md`.
 *
 * Buttons:
 *  - "Sync Google now" — POSTs the synthetic
 *    `application/x-google-calendar-list-request` payload to the existing
 *    4b.2 multipart-ingest endpoint at
 *    `/l/:slug/calendar_event/_ingest/google.calendar`. Pushes a toast
 *    with the `{ created, updated }` result on success, or the
 *    connector's localized error key on failure. The button is shown
 *    unconditionally — when no Google attachment is configured the
 *    server returns `errors.connectors.notConfigured` which the toast
 *    surfaces directly. Simpler than peeking at the attachments list.
 *  - "New event" — opens an inline dialog (same pattern as the
 *    Companies / Contacts list pages). The `/calendar/new` deep link
 *    auto-opens the dialog when the route matches.
 *
 * Accessibility:
 *  - The toolbar buttons are real `<button>`s with translated labels.
 *  - `react-big-calendar`'s built-in keyboard navigation is used as-is;
 *    the 4c.5 close-out documents the audit findings.
 *  - Loading: `role="status" aria-live="polite"`; error: `role="alert"`.
 */
export function CalendarPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const [input, setInput] = useState<CalendarPageInput>({ status: 'loading' });
  const [hydrated, setHydrated] = useState<readonly MappableEventLike[]>([]);
  const [view, setView] = useState<View>('week');
  const [date, setDate] = useState<Date>(() => new Date());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [syncPending, setSyncPending] = useState(false);

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const summaries = await listCalendarEvents(layerSlug);
      setInput({ status: 'ready', events: summaries });
      // The list endpoint surfaces title + subtitle but not the typed
      // payload the grid needs (startsAt/endsAt/allDay). Hydrate each
      // event in parallel. For the first iteration we accept the N+1;
      // the follow-up at `docs/dev/follow-ups/calendar-list-range-filter.md`
      // tracks introducing `?from=&to=` so the list endpoint can do the
      // filtering server-side.
      const full = await Promise.all(
        summaries.map(async (s) => {
          try {
            return await getCalendarEvent(layerSlug, s.slug);
          } catch {
            return null;
          }
        }),
      );
      const items: MappableEventLike[] = [];
      for (const e of full) {
        if (e !== null) items.push(e);
      }
      setHydrated(items);
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the create dialog when the route is `/calendar/new`.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname.endsWith('/calendar/new') && !dialogOpen) {
      setDialogOpen(true);
    }
    // Intentional single-mount effect — opening on subsequent renders
    // would loop. The repo has no `react-hooks/exhaustive-deps` rule.
  }, []);

  const localizer = useMemo(() => {
    const locales = { en: enUS, 'en-US': enUS, nl };
    return dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });
  }, []);

  const calendarMessages = useMemo(() => buildCalendarMessages(t), [t]);

  const items = useMemo(() => mapEventsToCalendarItems(hydrated), [hydrated]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const pageView = calendarPageView(input);
  const originalLocale = i18n.resolvedLanguage ?? 'en';
  const layer = current.layer;

  async function handleSyncGoogle(): Promise<void> {
    if (layerSlug === null || syncPending) return;
    setSyncPending(true);
    try {
      const result = await syncGoogleCalendar(layerSlug);
      pushToast({
        kind: 'success',
        message: t('entity.calendar.syncSuccess', {
          created: result.created,
          updated: result.updated,
        }),
      });
      await refresh();
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      pushToast({
        kind: 'error',
        message: t(key, { defaultValue: t('entity.calendar.syncFailed') }),
      });
    } finally {
      setSyncPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('entity.calendar.listTitle', { name: layer.name })}</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleSyncGoogle()}
              disabled={syncPending}
            >
              {syncPending ? t('entity.calendar.syncPending') : t('entity.calendar.syncGoogleCta')}
            </Button>
            <Button type="button" onClick={() => setDialogOpen(true)}>
              {t('entity.calendar.createCta')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {pageView.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.calendar.listLoading')}
            </p>
          ) : null}
          {pageView.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(pageView.errorKey, { defaultValue: t('entity.calendar.listError') })}
            </p>
          ) : null}
          {pageView.kind === 'empty' ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">{t('entity.calendar.listEmpty')}</p>
              <div className="flex gap-2">
                <Button type="button" onClick={() => setDialogOpen(true)}>
                  {t('entity.calendar.createCta')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleSyncGoogle()}
                  disabled={syncPending}
                >
                  {t('entity.calendar.syncGoogleCta')}
                </Button>
              </div>
            </div>
          ) : null}
          {pageView.kind === 'ready' ? (
            <div className="rbc-bunny2-wrapper" style={{ height: 600 }}>
              <Calendar
                localizer={localizer}
                events={items as unknown as object[]}
                startAccessor={(e) => (e as { start: Date }).start}
                endAccessor={(e) => (e as { end: Date }).end}
                allDayAccessor={(e) => (e as { allDay: boolean }).allDay}
                titleAccessor={(e) => (e as { title: string }).title}
                view={view}
                onView={(v) => setView(v)}
                date={date}
                onNavigate={(d) => setDate(d)}
                views={['month', 'week', 'day']}
                messages={calendarMessages}
                culture={originalLocale.startsWith('nl') ? 'nl' : 'en'}
                onSelectEvent={(e) => {
                  const slug = (e as { resource?: { slug?: string } }).resource?.slug;
                  if (slug !== undefined) {
                    navigate(webCalendarEventPath(layer.slug, slug));
                  }
                }}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {dialogOpen ? (
        <CreateCalendarEventDialog
          layerSlug={layer.slug}
          originalLocale={originalLocale}
          onClose={() => setDialogOpen(false)}
          onCreated={async (slug) => {
            setDialogOpen(false);
            pushToast({ kind: 'success', message: t('entity.calendar.created') });
            await refresh();
            navigate(webCalendarEventPath(layer.slug, slug));
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CreateCalendarEventDialogProps {
  readonly layerSlug: string;
  readonly originalLocale: string;
  readonly onClose: () => void;
  readonly onCreated: (eventSlug: string) => Promise<void>;
}

function CreateCalendarEventDialog(props: CreateCalendarEventDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CalendarEventFormDraft>(() => emptyCalendarEventFormDraft());
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function setField<K extends keyof CalendarEventFormDraft>(
    key: K,
    value: CalendarEventFormDraft[K],
  ): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleTitleChange(value: string): void {
    setDraft((prev) => ({
      ...prev,
      title: value,
      slug: slugTouched ? (prev.slug ?? '') : slugifyCalendarEventTitle(value),
    }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    const validation = validateCalendarEventForm(draft);
    if (validation !== null) {
      setErrorKey(validation);
      return;
    }
    setPending(true);
    try {
      const body = buildCreateCalendarEventRequest(draft, props.originalLocale);
      const created = await createCalendarEvent(props.layerSlug, body);
      await props.onCreated(created.slug);
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('entity.calendar.createDialogTitle')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="newce-title">{t('entity.calendar.fieldSummary')}</Label>
          <Input
            id="newce-title"
            value={draft.title}
            onChange={(e) => handleTitleChange(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newce-slug">{t('entity.calendar.slug')}</Label>
          <Input
            id="newce-slug"
            value={draft.slug ?? ''}
            onChange={(e) => {
              setField('slug', e.target.value);
              setSlugTouched(true);
            }}
            disabled={pending}
            autoComplete="off"
            aria-describedby="newce-slug-hint"
          />
          <p id="newce-slug-hint" className="text-xs text-muted-foreground">
            {t('entity.calendar.slugHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="newce-allday" className="flex items-center gap-2">
            <input
              id="newce-allday"
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) => setDraft((d) => setAllDayOnDraft(d, e.target.checked))}
              disabled={pending}
            />
            <span>{t('entity.calendar.fieldAllDay')}</span>
          </Label>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="newce-startsAt">{t('entity.calendar.fieldStartsAt')}</Label>
            <Input
              id="newce-startsAt"
              type={draft.allDay ? 'date' : 'datetime-local'}
              value={draft.startsAt}
              onChange={(e) => setField('startsAt', e.target.value)}
              disabled={pending}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newce-endsAt">{t('entity.calendar.fieldEndsAt')}</Label>
            <Input
              id="newce-endsAt"
              type={draft.allDay ? 'date' : 'datetime-local'}
              value={draft.endsAt}
              onChange={(e) => setField('endsAt', e.target.value)}
              disabled={pending}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="newce-location">{t('entity.calendar.fieldLocation')}</Label>
          <Input
            id="newce-location"
            value={draft.location}
            onChange={(e) => setField('location', e.target.value)}
            disabled={pending}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newce-description">{t('entity.calendar.fieldDescription')}</Label>
          <Textarea
            id="newce-description"
            value={draft.description}
            onChange={(e) => setField('description', e.target.value)}
            disabled={pending}
            rows={3}
          />
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.entity.calendar.saveFailed') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('entity.calendar.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('entity.calendar.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

/**
 * Build the `messages` prop for `react-big-calendar` from i18n keys.
 * Every visible string the library renders is sourced from `t(...)`;
 * the library's English defaults would otherwise leak into the Dutch
 * locale.
 */
function buildCalendarMessages(t: (k: string) => string): Record<string, string> {
  return {
    allDay: t('entity.calendar.viewAllDay'),
    previous: t('entity.calendar.viewPrevious'),
    next: t('entity.calendar.viewNext'),
    today: t('entity.calendar.today'),
    month: t('entity.calendar.viewMonth'),
    week: t('entity.calendar.viewWeek'),
    day: t('entity.calendar.viewDay'),
    agenda: t('entity.calendar.viewAgenda'),
    date: t('entity.calendar.colDate'),
    time: t('entity.calendar.colTime'),
    event: t('entity.calendar.colEvent'),
    noEventsInRange: t('entity.calendar.viewNoEventsInRange'),
    showMore: t('entity.calendar.viewShowMore'),
  };
}

// Re-export the page as the `/calendar/new` route landing point — same
// component; the dialog opens automatically when the path matches.
export { CalendarPage as CalendarNewPage };
export { webCalendarNewPath };
// Re-export the CalendarEvent type symbol so the import name does not
// shadow react-big-calendar's `Calendar` default import.
export type { CalendarEventEntity };
export type { EntitySummary };
