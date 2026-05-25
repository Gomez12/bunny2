import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { RestoreBanner } from '../components/ui/restore-banner';
import { Textarea } from '../components/ui/textarea';
import {
  getCalendarEvent,
  listContacts,
  restoreEntity,
  softDeleteCalendarEvent,
  updateCalendarEvent,
} from '../lib/api';
import { trackEvent } from '../lib/analytics';
import type { CalendarAttendeeStatus, EntitySummary } from '../lib/api-types';
import { webCalendarPath } from '../lib/calendar-routes';
import { contactDetailWebRoute } from '../lib/contacts-routes';
import { i18nKeysForKind, isSoftDeleted, restoreTelemetryName } from '../lib/entity-restore';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  addAttendee,
  buildUpdateCalendarEventRequest,
  calendarEventDetailView,
  contactIdToSlugMap,
  draftFromCalendarEvent,
  emptyCalendarEventFormDraft,
  removeAttendee,
  setAllDay,
  updateAttendee,
  validateCalendarEventForm,
  type AttendeeDraft,
  type CalendarEventDetailInput,
  type CalendarEventFormDraft,
} from './calendar-page-state';

/**
 * `/l/:layerSlug/calendar/:eventSlug` — calendar event detail + edit page.
 *
 * Fetches the full event envelope and the contacts list (for the
 * attendee chip → contact deep-link). External-links are surfaced
 * read-only.
 *
 * The `meetingSummaryNote` field — owned by the 4c.3 enrichment
 * runner — is rendered read-only with an "AI-generated" label and
 * preserved on every save by `buildUpdateCalendarEventRequest`.
 *
 * Accessibility:
 *  - Single `<h1>` via the card title.
 *  - Every input has a `<label htmlFor>`.
 *  - Attendee array editor: tab order + focus-after-add/remove follows
 *    the ContactDetailPage pattern.
 *  - The destructive delete control opens `ConfirmDialog` (focus-trap).
 *  - Errors render with `role="alert" aria-live="polite"`.
 */
export function CalendarEventDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const params = useParams<{ layerSlug: string; eventSlug: string }>();
  const eventSlug = params.eventSlug ?? '';

  const [input, setInput] = useState<CalendarEventDetailInput>({ status: 'loading' });
  const [draft, setDraft] = useState<CalendarEventFormDraft>(() => emptyCalendarEventFormDraft());
  const [contacts, setContacts] = useState<readonly EntitySummary[]>([]);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const restoreKeys = i18nKeysForKind('calendar_event');

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const [event, cos] = await Promise.all([
        getCalendarEvent(layerSlug, eventSlug),
        listContacts(layerSlug).catch(() => [] as readonly EntitySummary[]),
      ]);
      setContacts(cos);
      setInput({ status: 'ready', event });
      setDraft(draftFromCalendarEvent(event));
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug, eventSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const contactSlugByContactId = useMemo(() => contactIdToSlugMap(contacts), [contacts]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const view = calendarEventDetailView(input);

  function setField<K extends keyof CalendarEventFormDraft>(
    key: K,
    value: CalendarEventFormDraft[K],
  ): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (savePending || layerSlug === null || view.kind !== 'ready') return;
    setSaveError(null);
    const validation = validateCalendarEventForm(draft);
    if (validation !== null) {
      setSaveError(validation);
      return;
    }
    setSavePending(true);
    try {
      const body = buildUpdateCalendarEventRequest(draft, view.event);
      const updated = await updateCalendarEvent(layerSlug, eventSlug, body);
      setInput({ status: 'ready', event: updated });
      setDraft(draftFromCalendarEvent(updated));
      pushToast({ kind: 'success', message: t('entity.calendar.saved') });
    } catch (err: unknown) {
      setSaveError(errorKeyOf(err));
    } finally {
      setSavePending(false);
    }
  }

  function handleCancel(): void {
    if (view.kind !== 'ready') return;
    setDraft(draftFromCalendarEvent(view.event));
    setSaveError(null);
  }

  async function handleDelete(): Promise<void> {
    if (deletePending || layerSlug === null) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await softDeleteCalendarEvent(layerSlug, eventSlug);
      pushToast({ kind: 'success', message: t('entity.calendar.deleted') });
      navigate(webCalendarPath(layerSlug));
    } catch (err: unknown) {
      setDeleteError(errorKeyOf(err));
    } finally {
      setDeletePending(false);
    }
  }

  async function handleRestore(): Promise<void> {
    if (restorePending || layerSlug === null) return;
    setRestorePending(true);
    setRestoreError(null);
    const startedAt = Date.now();
    const telemetry = restoreTelemetryName('calendar_event');
    try {
      await restoreEntity(layerSlug, 'calendar_event', eventSlug);
      console.log(`[${telemetry}]`, { success: true, latencyMs: Date.now() - startedAt });
      trackEvent('entity_restored', { kind: 'calendar_event', layerSlug });
      pushToast({ kind: 'success', message: t(restoreKeys.restored) });
      setRestoreDialogOpen(false);
      await refresh();
    } catch (err: unknown) {
      console.log(`[${telemetry}]`, { success: false, latencyMs: Date.now() - startedAt });
      setRestoreError(errorKeyOf(err));
    } finally {
      setRestorePending(false);
    }
  }

  const showRestoreBanner =
    view.kind === 'ready' && isSoftDeleted(view.event.meta) && current.canEdit;

  return (
    <div className="space-y-4">
      {showRestoreBanner ? (
        <RestoreBanner
          titleKey={restoreKeys.bannerTitle}
          bodyKey={restoreKeys.bannerBody}
          restoreCtaKey={restoreKeys.restoreCta}
          confirmTitleKey={restoreKeys.confirmTitle}
          confirmBodyKey={restoreKeys.confirmBody}
          cancelKey={restoreKeys.cancel}
          busy={restorePending}
          errorKey={restoreError}
          dialogOpen={restoreDialogOpen}
          onDialogOpenChange={setRestoreDialogOpen}
          onConfirm={() => void handleRestore()}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            {view.kind === 'ready'
              ? t('entity.calendar.detailTitle', { title: view.event.title })
              : t('entity.calendar.detailFallbackTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.calendar.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('errors.entity.calendar.loadFailed') })}
            </p>
          ) : null}
          {view.kind === 'ready' ? (
            <form onSubmit={(e) => void handleSave(e)} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="ce-title">{t('entity.calendar.fieldSummary')}</Label>
                <Input
                  id="ce-title"
                  value={draft.title}
                  onChange={(e) => setField('title', e.target.value)}
                  disabled={savePending}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ce-description">{t('entity.calendar.fieldDescription')}</Label>
                <Textarea
                  id="ce-description"
                  value={draft.description}
                  onChange={(e) => setField('description', e.target.value)}
                  disabled={savePending}
                  rows={4}
                />
              </div>
              {draft.meetingSummaryNote.length > 0 ? (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <Label htmlFor="ce-aiSummary">
                    <span className="mr-2 inline-block rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {t('entity.calendar.meetingSummaryAiLabel')}
                    </span>
                    {t('entity.calendar.fieldMeetingSummary')}
                  </Label>
                  <Textarea
                    id="ce-aiSummary"
                    value={draft.meetingSummaryNote}
                    readOnly
                    disabled
                    rows={4}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="ce-location">{t('entity.calendar.fieldLocation')}</Label>
                <Input
                  id="ce-location"
                  value={draft.location}
                  onChange={(e) => setField('location', e.target.value)}
                  disabled={savePending}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ce-allday" className="flex items-center gap-2">
                  <input
                    id="ce-allday"
                    type="checkbox"
                    checked={draft.allDay}
                    onChange={(e) => setDraft((d) => setAllDay(d, e.target.checked))}
                    disabled={savePending}
                  />
                  <span>{t('entity.calendar.fieldAllDay')}</span>
                </Label>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ce-startsAt">{t('entity.calendar.fieldStartsAt')}</Label>
                  <Input
                    id="ce-startsAt"
                    type={draft.allDay ? 'date' : 'datetime-local'}
                    value={draft.startsAt}
                    onChange={(e) => setField('startsAt', e.target.value)}
                    disabled={savePending}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ce-endsAt">{t('entity.calendar.fieldEndsAt')}</Label>
                  <Input
                    id="ce-endsAt"
                    type={draft.allDay ? 'date' : 'datetime-local'}
                    value={draft.endsAt}
                    onChange={(e) => setField('endsAt', e.target.value)}
                    disabled={savePending}
                  />
                </div>
              </div>

              <AttendeeArrayEditor
                drafts={draft.attendees}
                disabled={savePending}
                layerSlug={layerSlug ?? ''}
                contactSlugByContactId={contactSlugByContactId}
                onAdd={() => setDraft((d) => addAttendee(d))}
                onRemove={(i) => setDraft((d) => removeAttendee(d, i))}
                onUpdate={(i, patch) => setDraft((d) => updateAttendee(d, i, patch))}
              />

              <div className="space-y-2">
                <Label htmlFor="ce-conferenceUrl">{t('entity.calendar.fieldConferenceUrl')}</Label>
                <Input
                  id="ce-conferenceUrl"
                  type="url"
                  value={draft.conferenceUrl}
                  onChange={(e) => setField('conferenceUrl', e.target.value)}
                  disabled={savePending}
                />
              </div>

              {draft.rruleString.length > 0 ? (
                <div className="space-y-1">
                  <Label htmlFor="ce-rrule">{t('entity.calendar.fieldRrule')}</Label>
                  <Input
                    id="ce-rrule"
                    value={draft.rruleString}
                    readOnly
                    disabled
                    aria-describedby="ce-rrule-hint"
                  />
                  <p id="ce-rrule-hint" className="text-xs text-muted-foreground">
                    {t('entity.calendar.fieldRruleReadOnlyHint')}
                  </p>
                </div>
              ) : null}
              {draft.externalCalendarId.length > 0 ? (
                <div className="space-y-1">
                  <Label htmlFor="ce-externalCalendarId">
                    {t('entity.calendar.fieldExternalCalendarId')}
                  </Label>
                  <Input
                    id="ce-externalCalendarId"
                    value={draft.externalCalendarId}
                    readOnly
                    disabled
                  />
                </div>
              ) : null}

              {saveError !== null ? (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  {t(saveError, { defaultValue: t('errors.entity.calendar.saveFailed') })}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={savePending}
                >
                  {t('entity.calendar.deleteCta')}
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={savePending}
                  >
                    {t('entity.calendar.cancel')}
                  </Button>
                  <Button type="submit" disabled={savePending}>
                    {t('entity.calendar.save')}
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {view.kind === 'ready' ? <ExternalLinksReadOnlyCard event={view.event} /> : null}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t('entity.calendar.deleteConfirmTitle')}
        body={t('entity.calendar.deleteConfirmBody')}
        confirmLabel={t('entity.calendar.deleteCta')}
        cancelLabel={t('entity.calendar.cancel')}
        destructive
        busy={deletePending}
        errorKey={deleteError}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          setDeleteConfirmOpen(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface AttendeeArrayEditorProps {
  readonly drafts: readonly AttendeeDraft[];
  readonly disabled: boolean;
  readonly layerSlug: string;
  readonly contactSlugByContactId: ReadonlyMap<string, string>;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly onUpdate: (index: number, patch: Partial<AttendeeDraft>) => void;
}

function AttendeeArrayEditor(props: AttendeeArrayEditorProps): JSX.Element {
  const { t } = useTranslation();
  const statusOptions: readonly { value: CalendarAttendeeStatus; labelKey: string }[] = [
    { value: 'needs_action', labelKey: 'entity.calendar.fieldAttendeeStatusNeedsAction' },
    { value: 'accepted', labelKey: 'entity.calendar.fieldAttendeeStatusAccepted' },
    { value: 'declined', labelKey: 'entity.calendar.fieldAttendeeStatusDeclined' },
    { value: 'tentative', labelKey: 'entity.calendar.fieldAttendeeStatusTentative' },
  ];
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.calendar.fieldAttendees')}</legend>
      {props.drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('entity.calendar.attendeesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {props.drafts.map((a, i) => {
            const linkedContactSlug =
              a.contactEntityId !== null
                ? (props.contactSlugByContactId.get(a.contactEntityId) ?? null)
                : null;
            return (
              <li key={`attendee-${i}`} className="space-y-2 rounded-md border p-2">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
                  <div className="space-y-1 md:col-span-3">
                    <Label htmlFor={`ce-att-value-${i}`}>
                      {t('entity.calendar.fieldAttendeeValue')}
                    </Label>
                    <Input
                      id={`ce-att-value-${i}`}
                      value={a.value}
                      onChange={(ev) => props.onUpdate(i, { value: ev.target.value })}
                      disabled={props.disabled}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label htmlFor={`ce-att-name-${i}`}>
                      {t('entity.calendar.fieldAttendeeName')}
                    </Label>
                    <Input
                      id={`ce-att-name-${i}`}
                      value={a.displayName}
                      onChange={(ev) => props.onUpdate(i, { displayName: ev.target.value })}
                      disabled={props.disabled}
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => props.onRemove(i)}
                      disabled={props.disabled}
                      aria-label={t('entity.calendar.fieldAttendeeRemove')}
                    >
                      {t('entity.calendar.fieldAttendeeRemove')}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`ce-att-status-${i}`}>
                      {t('entity.calendar.fieldAttendeeStatus')}
                    </Label>
                    <select
                      id={`ce-att-status-${i}`}
                      value={a.status}
                      onChange={(ev) =>
                        props.onUpdate(i, { status: ev.target.value as CalendarAttendeeStatus })
                      }
                      disabled={props.disabled}
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      {statusOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {a.contactEntityId !== null ? (
                    linkedContactSlug !== null ? (
                      <Link
                        to={contactDetailWebRoute(props.layerSlug, linkedContactSlug)}
                        className="text-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t('entity.calendar.fieldAttendeeContactLink')}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t('entity.calendar.fieldAttendeeContactLinkUnknown', {
                          id: a.contactEntityId,
                        })}
                      </span>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={props.onAdd}
        disabled={props.disabled}
      >
        {t('entity.calendar.fieldAttendeeAdd')}
      </Button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

interface ExternalLinksReadOnlyCardProps {
  readonly event: {
    readonly externalLinks: readonly import('../lib/api-types').EntityExternalLink[];
  };
}

function ExternalLinksReadOnlyCard(props: ExternalLinksReadOnlyCardProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('entity.calendar.externalLinksTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {props.event.externalLinks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('entity.calendar.externalLinksEmpty')}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {props.event.externalLinks.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {t('entity.calendar.linkConnectorLabel', {
                      connector: link.connector,
                      externalId: link.externalId,
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {syncStateLabel(link.syncState, t)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function syncStateLabel(state: 'idle' | 'syncing' | 'error', t: (k: string) => string): string {
  if (state === 'syncing') return t('entity.calendar.linkSyncSyncing');
  if (state === 'error') return t('entity.calendar.linkSyncError');
  return t('entity.calendar.linkSyncIdle');
}
