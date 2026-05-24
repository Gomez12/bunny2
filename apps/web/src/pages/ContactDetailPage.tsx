import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { getContact, listCompanies, softDeleteContact, updateContact } from '../lib/api';
import type { EntityExternalLink, EntitySummary } from '../lib/api-types';
import { contactsListWebRoute } from '../lib/contacts-routes';
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

  return (
    <div className="space-y-4">
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

              <EmailArrayEditor
                drafts={draft.emails}
                disabled={savePending}
                onAdd={() => setDraft((d) => addEmail(d))}
                onRemove={(i) => setDraft((d) => removeEmail(d, i))}
                onUpdate={(i, patch) => setDraft((d) => updateEmail(d, i, patch))}
                onPromote={(i) => setDraft((d) => promotePrimaryEmail(d, i))}
              />

              <PhoneArrayEditor
                drafts={draft.phones}
                disabled={savePending}
                onAdd={() => setDraft((d) => addPhone(d))}
                onRemove={(i) => setDraft((d) => removePhone(d, i))}
                onUpdate={(i, patch) => setDraft((d) => updatePhone(d, i, patch))}
                onPromote={(i) => setDraft((d) => promotePrimaryPhone(d, i))}
              />

              <CompanyLinkPicker
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

interface EmailArrayEditorProps {
  readonly drafts: ContactFormDraft['emails'];
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly onUpdate: (index: number, patch: Partial<ContactFormDraft['emails'][number]>) => void;
  readonly onPromote: (index: number) => void;
}

function EmailArrayEditor(props: EmailArrayEditorProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.contacts.fieldEmails')}</legend>
      {props.drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('entity.contacts.emailsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {props.drafts.map((e, i) => (
            <li key={`email-${i}`} className="grid grid-cols-1 gap-2 md:grid-cols-6">
              <div className="space-y-1 md:col-span-3">
                <Label htmlFor={`c-email-value-${i}`}>{t('entity.contacts.fieldEmailValue')}</Label>
                <Input
                  id={`c-email-value-${i}`}
                  type="email"
                  value={e.value}
                  onChange={(ev) => props.onUpdate(i, { value: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor={`c-email-label-${i}`}>{t('entity.contacts.fieldEmailLabel')}</Label>
                <Input
                  id={`c-email-label-${i}`}
                  value={e.label}
                  onChange={(ev) => props.onUpdate(i, { label: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={e.isPrimary ? 'default' : 'ghost'}
                  onClick={() => props.onPromote(i)}
                  disabled={props.disabled}
                  aria-pressed={e.isPrimary}
                  title={t('entity.contacts.fieldEmailPrimary')}
                >
                  {t('entity.contacts.fieldEmailPrimary')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onRemove(i)}
                  disabled={props.disabled}
                  aria-label={t('entity.contacts.fieldEmailRemove')}
                >
                  {t('entity.contacts.fieldEmailRemove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={props.onAdd}
        disabled={props.disabled}
      >
        {t('entity.contacts.fieldEmailAdd')}
      </Button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

interface PhoneArrayEditorProps {
  readonly drafts: ContactFormDraft['phones'];
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly onUpdate: (index: number, patch: Partial<ContactFormDraft['phones'][number]>) => void;
  readonly onPromote: (index: number) => void;
}

function PhoneArrayEditor(props: PhoneArrayEditorProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.contacts.fieldPhones')}</legend>
      {props.drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('entity.contacts.phonesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {props.drafts.map((p, i) => (
            <li key={`phone-${i}`} className="grid grid-cols-1 gap-2 md:grid-cols-6">
              <div className="space-y-1 md:col-span-3">
                <Label htmlFor={`c-phone-value-${i}`}>{t('entity.contacts.fieldPhoneValue')}</Label>
                <Input
                  id={`c-phone-value-${i}`}
                  type="tel"
                  value={p.value}
                  onChange={(ev) => props.onUpdate(i, { value: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor={`c-phone-label-${i}`}>{t('entity.contacts.fieldPhoneLabel')}</Label>
                <Input
                  id={`c-phone-label-${i}`}
                  value={p.label}
                  onChange={(ev) => props.onUpdate(i, { label: ev.target.value })}
                  disabled={props.disabled}
                  autoComplete="off"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={p.isPrimary ? 'default' : 'ghost'}
                  onClick={() => props.onPromote(i)}
                  disabled={props.disabled}
                  aria-pressed={p.isPrimary}
                  title={t('entity.contacts.fieldPhonePrimary')}
                >
                  {t('entity.contacts.fieldPhonePrimary')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onRemove(i)}
                  disabled={props.disabled}
                  aria-label={t('entity.contacts.fieldPhoneRemove')}
                >
                  {t('entity.contacts.fieldPhoneRemove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={props.onAdd}
        disabled={props.disabled}
      >
        {t('entity.contacts.fieldPhoneAdd')}
      </Button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

interface CompanyLinkPickerProps {
  readonly value: string | null;
  readonly companies: readonly EntitySummary[];
  readonly disabled: boolean;
  readonly onChange: (next: string | null) => void;
}

/**
 * A plain `<select>` populated from the layer's companies. Accessible
 * out of the box (keyboard + screen reader). The "Clear" button sets
 * `companyEntityId` to `null`, omitting the field from the next PATCH.
 *
 * If the contact carries a `companyEntityId` that is not in the loaded
 * companies list (deleted, hidden, or just not yet fetched), we still
 * render it as a disabled option labelled "unknown" so the user does
 * not silently lose the link on save — they can clear it explicitly.
 */
function CompanyLinkPicker(props: CompanyLinkPickerProps): JSX.Element {
  const { t } = useTranslation();
  const inListed = props.companies.some((c) => c.id === props.value);
  return (
    <div className="space-y-2">
      <Label htmlFor="c-company">{t('entity.contacts.fieldCompany')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="c-company"
          value={props.value ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            props.onChange(v.length === 0 ? null : v);
          }}
          disabled={props.disabled}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t('entity.contacts.fieldCompanyPlaceholder')}</option>
          {props.value !== null && !inListed ? (
            <option value={props.value}>
              {t('entity.contacts.fieldCompanyUnknown', { id: props.value })}
            </option>
          ) : null}
          {props.companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
              {c.subtitle !== null ? ` · ${c.subtitle}` : ''}
            </option>
          ))}
        </select>
        {props.value !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => props.onChange(null)}
            disabled={props.disabled}
          >
            {t('entity.contacts.fieldCompanyClear')}
          </Button>
        ) : null}
      </div>
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
