import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { CompanyPicker } from '../components/contacts/CompanyPicker';
import { EmailListEditor } from '../components/contacts/EmailListEditor';
import { PhoneListEditor } from '../components/contacts/PhoneListEditor';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { RestoreBanner } from '../components/ui/restore-banner';
import { Textarea } from '../components/ui/textarea';
import {
  getContact,
  listCompanies,
  restoreEntity,
  softDeleteContact,
  updateContact,
} from '../lib/api';
import { trackEvent } from '../lib/analytics';
import type { EntityExternalLink, EntitySummary } from '../lib/api-types';
import { contactsListWebRoute } from '../lib/contacts-routes';
import { i18nKeysForKind, isSoftDeleted, restoreTelemetryName } from '../lib/entity-restore';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  addEmail,
  addPhone,
  buildUpdateContactRequest,
  contactDetailView,
  draftFromContact,
  emptyContactFormDraft,
  linkSyncStateBadgeKey,
  promotePrimaryEmail,
  promotePrimaryPhone,
  removeEmail,
  removePhone,
  updateEmail,
  updatePhone,
  validateContactForm,
  type ContactDetailInput,
  type ContactFormDraft,
} from './contacts-page-state';

/**
 * `/l/:layerSlug/contacts/:contactSlug` — detail + edit page.
 *
 * Fetches the full contact (`GET /l/:layerSlug/contact/:contactSlug`) and
 * the layer's companies (for the company-link picker). The external-links
 * block is read-only — the vCard import creates them as provenance and
 * Contacts does not (yet) expose a per-link manual-add flow the way
 * Companies does for KvK numbers.
 *
 * Accessibility:
 *  - Single `<h1>` via the card title.
 *  - Every input has a `<label htmlFor>`.
 *  - Array editors (emails, phones) move focus to the next input after
 *    an "add" / "remove" so keyboard users keep their place.
 *  - The destructive delete control opens `ConfirmDialog` (focus-trap).
 *  - Errors render with `role="alert" aria-live="polite"`.
 */
export function ContactDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const params = useParams<{ layerSlug: string; contactSlug: string }>();
  const contactSlug = params.contactSlug ?? '';

  const [input, setInput] = useState<ContactDetailInput>({ status: 'loading' });
  const [draft, setDraft] = useState<ContactFormDraft>(() => emptyContactFormDraft());
  const [companies, setCompanies] = useState<readonly EntitySummary[]>([]);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const restoreKeys = i18nKeysForKind('contact');

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const [contact, cos] = await Promise.all([
        getContact(layerSlug, contactSlug),
        listCompanies(layerSlug).catch(() => [] as readonly EntitySummary[]),
      ]);
      setCompanies(cos);
      setInput({ status: 'ready', contact });
      setDraft(draftFromContact(contact));
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug, contactSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const view = contactDetailView(input);

  function setField<K extends keyof ContactFormDraft>(key: K, value: ContactFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (savePending || layerSlug === null) return;
    setSaveError(null);
    const validation = validateContactForm(draft);
    if (validation !== null) {
      setSaveError(validation);
      return;
    }
    setSavePending(true);
    try {
      const body = buildUpdateContactRequest(draft);
      const updated = await updateContact(layerSlug, contactSlug, body);
      setInput({ status: 'ready', contact: updated });
      setDraft(draftFromContact(updated));
      pushToast({ kind: 'success', message: t('entity.contacts.saved') });
    } catch (err: unknown) {
      setSaveError(errorKeyOf(err));
    } finally {
      setSavePending(false);
    }
  }

  function handleCancel(): void {
    if (view.kind !== 'ready') return;
    setDraft(draftFromContact(view.contact));
    setSaveError(null);
  }

  async function handleDelete(): Promise<void> {
    if (deletePending || layerSlug === null) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await softDeleteContact(layerSlug, contactSlug);
      pushToast({ kind: 'success', message: t('entity.contacts.deleted') });
      navigate(contactsListWebRoute(layerSlug));
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
    const telemetry = restoreTelemetryName('contact');
    try {
      await restoreEntity(layerSlug, 'contact', contactSlug);
      console.log(`[${telemetry}]`, { success: true, latencyMs: Date.now() - startedAt });
      trackEvent('entity_restored', { kind: 'contact', layerSlug });
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
    view.kind === 'ready' && isSoftDeleted(view.contact.meta) && current.canEdit;

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
              ? t('entity.contacts.detailTitle', { title: view.contact.title })
              : t('entity.contacts.detailFallbackTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.contacts.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('errors.entity.contacts.loadFailed') })}
            </p>
          ) : null}
          {view.kind === 'ready' ? (
            <form onSubmit={(e) => void handleSave(e)} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="c-title">{t('entity.contacts.fieldTitle')}</Label>
                <Input
                  id="c-title"
                  value={draft.title}
                  onChange={(e) => setField('title', e.target.value)}
                  disabled={savePending}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="c-givenName">{t('entity.contacts.fieldGivenName')}</Label>
                  <Input
                    id="c-givenName"
                    value={draft.givenName}
                    onChange={(e) => setField('givenName', e.target.value)}
                    disabled={savePending}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="c-familyName">{t('entity.contacts.fieldFamilyName')}</Label>
                  <Input
                    id="c-familyName"
                    value={draft.familyName}
                    onChange={(e) => setField('familyName', e.target.value)}
                    disabled={savePending}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="c-displayName">{t('entity.contacts.fieldDisplayName')}</Label>
                  <Input
                    id="c-displayName"
                    value={draft.displayName}
                    onChange={(e) => setField('displayName', e.target.value)}
                    disabled={savePending}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="c-jobTitle">{t('entity.contacts.fieldJobTitle')}</Label>
                  <Input
                    id="c-jobTitle"
                    value={draft.jobTitle}
                    onChange={(e) => setField('jobTitle', e.target.value)}
                    disabled={savePending}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="c-birthday">{t('entity.contacts.fieldBirthday')}</Label>
                  <Input
                    id="c-birthday"
                    type="date"
                    value={draft.birthday}
                    onChange={(e) => setField('birthday', e.target.value)}
                    disabled={savePending}
                    autoComplete="off"
                  />
                </div>
              </div>

              <EmailListEditor
                drafts={draft.emails}
                disabled={savePending}
                onAdd={() => setDraft((d) => addEmail(d))}
                onRemove={(i) => setDraft((d) => removeEmail(d, i))}
                onUpdate={(i, patch) => setDraft((d) => updateEmail(d, i, patch))}
                onPromote={(i) => setDraft((d) => promotePrimaryEmail(d, i))}
              />

              <PhoneListEditor
                drafts={draft.phones}
                disabled={savePending}
                onAdd={() => setDraft((d) => addPhone(d))}
                onRemove={(i) => setDraft((d) => removePhone(d, i))}
                onUpdate={(i, patch) => setDraft((d) => updatePhone(d, i, patch))}
                onPromote={(i) => setDraft((d) => promotePrimaryPhone(d, i))}
              />

              <CompanyPicker
                value={draft.companyEntityId}
                companies={companies}
                disabled={savePending}
                onChange={(next) => setField('companyEntityId', next)}
              />

              <div className="space-y-2">
                <Label htmlFor="c-notes">{t('entity.contacts.fieldNotes')}</Label>
                <Textarea
                  id="c-notes"
                  value={draft.notes}
                  onChange={(e) => setField('notes', e.target.value)}
                  disabled={savePending}
                  rows={4}
                />
              </div>

              {saveError !== null ? (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  {t(saveError, { defaultValue: t('errors.entity.contacts.saveFailed') })}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={savePending}
                >
                  {t('entity.contacts.deleteCta')}
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={savePending}
                  >
                    {t('entity.contacts.cancel')}
                  </Button>
                  <Button type="submit" disabled={savePending}>
                    {t('entity.contacts.save')}
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {view.kind === 'ready' ? (
        <ExternalLinksReadOnlyCard links={view.contact.externalLinks} />
      ) : null}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t('entity.contacts.deleteConfirmTitle')}
        body={t('entity.contacts.deleteConfirmBody')}
        confirmLabel={t('entity.contacts.deleteCta')}
        cancelLabel={t('entity.contacts.cancel')}
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

interface ExternalLinksReadOnlyCardProps {
  readonly links: readonly EntityExternalLink[];
}

/**
 * Read-only provenance list. The vCard import (`POST .../_ingest/vcard`)
 * creates external-link rows with `connector: 'vcard'`; the user can
 * inspect them here but cannot add or remove (spec: external-links
 * section read-only). The 4b.7+ "manage external links" surface, if it
 * ever ships, will reuse the Companies pattern.
 */
function ExternalLinksReadOnlyCard(props: ExternalLinksReadOnlyCardProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('entity.contacts.externalLinksTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {props.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('entity.contacts.externalLinksEmpty')}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {props.links.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {t('entity.contacts.linkConnectorLabel', {
                      connector: link.connector,
                      externalId: link.externalId,
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(linkSyncStateBadgeKey(link.syncState))}
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
