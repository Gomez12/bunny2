import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CompanyPicker } from '../components/contacts/CompanyPicker';
import { EmailListEditor } from '../components/contacts/EmailListEditor';
import { PhoneListEditor } from '../components/contacts/PhoneListEditor';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { DeletedBadge } from '../components/ui/deleted-badge';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { createContact, listCompanies, listContacts } from '../lib/api';
import type { EntitySummary } from '../lib/api-types';
import { i18nKeysForKind, isSoftDeleted } from '../lib/entity-restore';
import {
  contactDetailWebRoute,
  contactsImportWebRoute,
  contactsNewWebRoute,
  slugifyContactTitle,
} from '../lib/contacts-routes';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  addEmail,
  addPhone,
  buildCreateContactRequest,
  contactsListView,
  emptyContactFormDraft,
  promotePrimaryEmail,
  promotePrimaryPhone,
  removeEmail,
  removePhone,
  updateEmail,
  updatePhone,
  validateContactForm,
  type ContactFormDraft,
  type ContactsListInput,
} from './contacts-page-state';

/**
 * `/l/:layerSlug/contacts` — list page.
 *
 * Fetches `GET /l/:layerSlug/contact` (singular per the §4.0 router; the
 * singular ↔ plural URL mapping lives in
 * `apps/web/src/lib/contacts-routes.ts`). The server returns
 * `EntitySummary[]` which carries `title`, `subtitle` (the contact
 * module projects `primary_email ?? primary_phone ?? jobTitle` per
 * `contactModule.toSummary`), and `meta.updatedAt`.
 *
 * Per-row payload details such as the linked company's title are NOT
 * in the summary. Rather than firing an N+1 per-row `getContact` from
 * the list page, we mirror the Companies pattern: the list ships
 * three columns (name / best contact info / updated) and the user
 * clicks through to the detail page for the company link, the full
 * email/phone array, notes, and so on. The 4b.5 close-out documents
 * this as the place where a `summaryColumns` slot would land if the
 * Calendar / Todos lists need richer per-row data without a per-row
 * round-trip.
 *
 * Loading / error / empty / ready branches are projected by the pure
 * reducer in `./contacts-page-state.ts` so the matrix is testable
 * without a DOM runtime.
 *
 * Accessibility:
 *  - Single `<h1>` via the card title.
 *  - Table uses `<th scope="col">` headers; each row is keyboard-
 *    navigable via the `<Link>` on the title cell.
 *  - Loading: `role="status" aria-live="polite"`; error: `role="alert"`.
 *  - The create dialog inherits the native `<dialog>` focus trap from
 *    `components/ui/dialog.tsx`.
 */
export function ContactsListPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const [searchParams, setSearchParams] = useSearchParams();
  const includeDeleted = searchParams.get('includeDeleted') === '1';
  const [input, setInput] = useState<ContactsListInput>({ status: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const restoreKeys = i18nKeysForKind('contact');

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const contacts = await listContacts(layerSlug, { includeDeleted });
      setInput({ status: 'ready', contacts });
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug, includeDeleted]);

  function toggleIncludeDeleted(): void {
    const next = new URLSearchParams(searchParams);
    if (includeDeleted) {
      next.delete('includeDeleted');
    } else {
      next.set('includeDeleted', '1');
    }
    setSearchParams(next, { replace: true });
  }

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

  const view = contactsListView(input);
  const originalLocale = i18n.resolvedLanguage ?? 'en';
  const layer = current.layer;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('entity.contacts.listTitle', { name: layer.name })}</CardTitle>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleIncludeDeleted}
              aria-pressed={includeDeleted}
            >
              {includeDeleted ? t(restoreKeys.toggleHideDeleted) : t(restoreKeys.toggleShowDeleted)}
            </Button>
            <Button asChild type="button" variant="ghost">
              <Link to={contactsImportWebRoute(layer.slug)}>{t('entity.contacts.importCta')}</Link>
            </Button>
            <Button type="button" onClick={() => setDialogOpen(true)}>
              {t('entity.contacts.createCta')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.contacts.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('entity.contacts.listError') })}
            </p>
          ) : null}
          {view.kind === 'empty' ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">{t('entity.contacts.listEmpty')}</p>
              <div className="flex gap-2">
                <Button type="button" onClick={() => setDialogOpen(true)}>
                  {t('entity.contacts.createCta')}
                </Button>
                <Button asChild type="button" variant="ghost">
                  <Link to={contactsImportWebRoute(layer.slug)}>
                    {t('entity.contacts.importCta')}
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
          {view.kind === 'ready' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.contacts.colTitle')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.contacts.colContactInfo')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.contacts.colUpdatedAt')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.contacts.map((c) => (
                    <tr key={c.id} className="border-b last:border-0" data-row-id={c.id}>
                      <td className="px-2 py-2 font-medium">
                        <div className="flex items-center gap-2">
                          <Link
                            to={contactDetailWebRoute(layer.slug, c.slug)}
                            className="text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {c.title}
                          </Link>
                          {isSoftDeleted(c.meta) ? (
                            <DeletedBadge labelKey={restoreKeys.deletedBadge} />
                          ) : null}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {c.subtitle ?? t('entity.contacts.subtitle.noContactInfo')}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{c.meta.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {dialogOpen ? (
        <CreateContactDialog
          layerSlug={layer.slug}
          originalLocale={originalLocale}
          onClose={() => setDialogOpen(false)}
          onCreated={async (contactSlug) => {
            setDialogOpen(false);
            pushToast({ kind: 'success', message: t('entity.contacts.created') });
            await refresh();
            navigate(contactDetailWebRoute(layer.slug, contactSlug));
          }}
        />
      ) : null}

      {/* `/contacts/new` deep link: the router mounts this same component
          on the `/new` path and the trigger opens the dialog on first
          paint. Same pattern as `CompaniesListPage`. */}
      <NewRouteDialogTrigger
        onOpen={() => {
          if (!dialogOpen) setDialogOpen(true);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface NewRouteDialogTriggerProps {
  readonly onOpen: () => void;
}

/**
 * When the current location is `/l/:slug/contacts/new`, open the create
 * dialog on mount — the page is the canonical surface; there is no
 * separate `/new` component. Mirrors `CompaniesListPage`.
 */
function NewRouteDialogTrigger(props: NewRouteDialogTriggerProps): null {
  const { onOpen } = props;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname.endsWith('/contacts/new')) {
      onOpen();
    }
    // Run once on mount — opening on subsequent renders would loop.
    // The intentional empty dep-list is checked in the test file
    // `contacts-list-page.test.ts`; the codebase has no
    // react-hooks/exhaustive-deps rule configured.
  }, []);
  return null;
}

// ---------------------------------------------------------------------------

interface CreateContactDialogProps {
  readonly layerSlug: string;
  readonly originalLocale: string;
  readonly onClose: () => void;
  readonly onCreated: (contactSlug: string) => Promise<void>;
}

function CreateContactDialog(props: CreateContactDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ContactFormDraft>(() => emptyContactFormDraft());
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [companies, setCompanies] = useState<readonly EntitySummary[]>([]);

  // Load the layer's companies once on mount so the picker is populated
  // before the user reaches it. Failures degrade gracefully: the picker
  // still renders an empty list and lets the user submit without a
  // company link (the create still succeeds — the field is optional).
  useEffect(() => {
    let cancelled = false;
    listCompanies(props.layerSlug)
      .then((cos) => {
        if (!cancelled) setCompanies(cos);
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.layerSlug]);

  function setField<K extends keyof ContactFormDraft>(key: K, value: ContactFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleTitleChange(value: string): void {
    setDraft((prev) => ({
      ...prev,
      title: value,
      slug: slugTouched ? (prev.slug ?? '') : slugifyContactTitle(value),
    }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    const validation = validateContactForm(draft);
    if (validation !== null) {
      setErrorKey(validation);
      return;
    }
    setPending(true);
    try {
      const body = buildCreateContactRequest(draft, props.originalLocale);
      const created = await createContact(props.layerSlug, body);
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
      title={t('entity.contacts.createDialogTitle')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        {/* Above-the-fold required fields: title + slug stay visible at
            the top of the dialog so the user sees what is mandatory before
            scrolling into the optional rich editors below. */}
        <div className="space-y-2">
          <Label htmlFor="newc-title">{t('entity.contacts.fieldTitle')}</Label>
          <Input
            id="newc-title"
            value={draft.title}
            onChange={(e) => handleTitleChange(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newc-slug">{t('entity.contacts.slug')}</Label>
          <Input
            id="newc-slug"
            value={draft.slug ?? ''}
            onChange={(e) => {
              setField('slug', e.target.value);
              setSlugTouched(true);
            }}
            disabled={pending}
            autoComplete="off"
            aria-describedby="newc-slug-hint"
          />
          <p id="newc-slug-hint" className="text-xs text-muted-foreground">
            {t('entity.contacts.slugHint')}
          </p>
        </div>
        {/* Scrollable body for the rich optional fields. The native
            `<dialog>` clips to the viewport on its own; the inner
            `max-h-[60vh]` keeps the required block above the fold even
            when the user adds many emails / phones. */}
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="newc-givenName">{t('entity.contacts.fieldGivenName')}</Label>
              <Input
                id="newc-givenName"
                value={draft.givenName}
                onChange={(e) => setField('givenName', e.target.value)}
                disabled={pending}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newc-familyName">{t('entity.contacts.fieldFamilyName')}</Label>
              <Input
                id="newc-familyName"
                value={draft.familyName}
                onChange={(e) => setField('familyName', e.target.value)}
                disabled={pending}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="newc-jobTitle">{t('entity.contacts.fieldJobTitle')}</Label>
              <Input
                id="newc-jobTitle"
                value={draft.jobTitle}
                onChange={(e) => setField('jobTitle', e.target.value)}
                disabled={pending}
                autoComplete="off"
              />
            </div>
          </div>

          <EmailListEditor
            drafts={draft.emails}
            disabled={pending}
            idPrefix="newc"
            onAdd={() => setDraft((d) => addEmail(d))}
            onRemove={(i) => setDraft((d) => removeEmail(d, i))}
            onUpdate={(i, patch) => setDraft((d) => updateEmail(d, i, patch))}
            onPromote={(i) => setDraft((d) => promotePrimaryEmail(d, i))}
          />

          <PhoneListEditor
            drafts={draft.phones}
            disabled={pending}
            idPrefix="newc"
            onAdd={() => setDraft((d) => addPhone(d))}
            onRemove={(i) => setDraft((d) => removePhone(d, i))}
            onUpdate={(i, patch) => setDraft((d) => updatePhone(d, i, patch))}
            onPromote={(i) => setDraft((d) => promotePrimaryPhone(d, i))}
          />

          <CompanyPicker
            value={draft.companyEntityId}
            companies={companies}
            disabled={pending}
            idPrefix="newc"
            onChange={(next) => setField('companyEntityId', next)}
          />

          <div className="space-y-2">
            <Label htmlFor="newc-notes">{t('entity.contacts.fieldNotes')}</Label>
            <Textarea
              id="newc-notes"
              value={draft.notes}
              onChange={(e) => setField('notes', e.target.value)}
              disabled={pending}
              rows={3}
            />
          </div>
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.entity.contacts.saveFailed') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('entity.contacts.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('entity.contacts.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// Re-export the `/contacts/new` route landing point — same component as
// the list page; the dialog opens automatically when the path matches.
export { ContactsListPage as ContactsNewPage };
export { contactsNewWebRoute };
