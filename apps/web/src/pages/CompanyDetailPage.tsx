import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  addCompanyExternalLink,
  getCompany,
  removeCompanyExternalLink,
  softDeleteCompany,
  updateCompany,
} from '../lib/api';
import type { EntityExternalLink } from '../lib/api-types';
import { companiesListWebRoute } from '../lib/companies-routes';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  buildUpdateCompanyRequest,
  companyDetailView,
  draftFromCompany,
  emptyCompanyFormDraft,
  linkSyncStateBadgeKey,
  validateCompanyForm,
  type CompanyDetailInput,
  type CompanyFormDraft,
} from './companies-page-state';
import { CompanyTextField } from './CompaniesListPage';

/**
 * `/l/:layerSlug/companies/:companySlug` — detail + edit page.
 *
 * Fetches the full entity (`GET /l/:layerSlug/company/:companySlug`)
 * and renders an editable form bound to `UpdateCompanyRequestSchema`.
 * Save calls `PATCH`; cancel reverts to the last loaded payload. The
 * external-links section embeds a small form for linking a KvK
 * number — calls `POST .../external-links` with
 * `{ connector: 'kvk', externalId: <kvk> }`. Refresh re-fetches the
 * detail so the asynchronous `sync_state` transition surfaces in the
 * UI.
 *
 * The enrichment activity log endpoint is intentionally NOT consumed
 * here (per the 4a.5 plan note — adding a log endpoint is its own
 * surface). The current enrichment outcome is visible as the
 * AI-generated `description` field, which the §4a.3 jobs fill in.
 *
 * Accessibility:
 *  - Single `<h1>` via the page card title.
 *  - Every field uses `<label htmlFor>`.
 *  - The destructive delete control opens a `ConfirmDialog` that
 *    inherits the native `<dialog>` focus trap.
 *  - Errors render with `role="alert" aria-live="polite"`.
 */
export function CompanyDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const params = useParams<{ layerSlug: string; companySlug: string }>();
  const companySlug = params.companySlug ?? '';

  const [input, setInput] = useState<CompanyDetailInput>({ status: 'loading' });
  const [draft, setDraft] = useState<CompanyFormDraft>(() => emptyCompanyFormDraft());
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState<string>('');
  const [linkPending, setLinkPending] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkRemovePending, setLinkRemovePending] = useState<string | null>(null);

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const company = await getCompany(layerSlug, companySlug);
      setInput({ status: 'ready', company });
      setDraft(draftFromCompany(company));
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug, companySlug]);

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

  const view = companyDetailView(input);

  function setField<K extends keyof CompanyFormDraft>(key: K, value: CompanyFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (savePending || layerSlug === null) return;
    setSaveError(null);
    const validation = validateCompanyForm(draft);
    if (validation !== null) {
      setSaveError(validation);
      return;
    }
    setSavePending(true);
    try {
      const body = buildUpdateCompanyRequest(draft);
      const updated = await updateCompany(layerSlug, companySlug, body);
      setInput({ status: 'ready', company: updated });
      setDraft(draftFromCompany(updated));
      pushToast({ kind: 'success', message: t('entity.companies.saved') });
    } catch (err: unknown) {
      setSaveError(errorKeyOf(err));
    } finally {
      setSavePending(false);
    }
  }

  function handleCancel(): void {
    if (view.kind !== 'ready') return;
    setDraft(draftFromCompany(view.company));
    setSaveError(null);
  }

  async function handleDelete(): Promise<void> {
    if (deletePending || layerSlug === null) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await softDeleteCompany(layerSlug, companySlug);
      pushToast({ kind: 'success', message: t('entity.companies.deleted') });
      navigate(companiesListWebRoute(layerSlug));
    } catch (err: unknown) {
      setDeleteError(errorKeyOf(err));
    } finally {
      setDeletePending(false);
    }
  }

  async function handleAddLink(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (linkPending || layerSlug === null) return;
    setLinkError(null);
    const trimmed = linkForm.trim();
    if (!/^\d{8}$/.test(trimmed)) {
      setLinkError('errors.entity.companies.kvkInvalid');
      return;
    }
    setLinkPending(true);
    try {
      await addCompanyExternalLink(layerSlug, companySlug, {
        connector: 'kvk',
        externalId: trimmed,
      });
      setLinkForm('');
      pushToast({ kind: 'success', message: t('entity.companies.linkAdded') });
      await refresh();
    } catch (err: unknown) {
      setLinkError(errorKeyOf(err));
    } finally {
      setLinkPending(false);
    }
  }

  async function handleRemoveLink(linkId: string): Promise<void> {
    if (layerSlug === null) return;
    setLinkRemovePending(linkId);
    setLinkError(null);
    try {
      await removeCompanyExternalLink(layerSlug, companySlug, linkId);
      pushToast({ kind: 'success', message: t('entity.companies.linkRemoved') });
      await refresh();
    } catch (err: unknown) {
      setLinkError(errorKeyOf(err));
    } finally {
      setLinkRemovePending(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {view.kind === 'ready'
              ? t('entity.companies.detailTitle', { title: view.company.title })
              : t('entity.companies.detailFallbackTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.companies.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('errors.entity.companies.loadFailed') })}
            </p>
          ) : null}
          {view.kind === 'ready' ? (
            <form onSubmit={(e) => void handleSave(e)} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="co-title">{t('entity.companies.fieldTitle')}</Label>
                <Input
                  id="co-title"
                  value={draft.title}
                  onChange={(e) => setField('title', e.target.value)}
                  disabled={savePending}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <CompanyTextField
                  id="co-legalName"
                  labelKey="entity.companies.fieldLegalName"
                  value={draft.legalName}
                  onChange={(v) => setField('legalName', v)}
                  disabled={savePending}
                />
                <CompanyTextField
                  id="co-tradeName"
                  labelKey="entity.companies.fieldTradeName"
                  value={draft.tradeName}
                  onChange={(v) => setField('tradeName', v)}
                  disabled={savePending}
                />
                <CompanyTextField
                  id="co-kvkNumber"
                  labelKey="entity.companies.fieldKvkNumber"
                  value={draft.kvkNumber}
                  onChange={(v) => setField('kvkNumber', v)}
                  disabled={savePending}
                  inputMode="numeric"
                />
                <CompanyTextField
                  id="co-website"
                  labelKey="entity.companies.fieldWebsite"
                  value={draft.website}
                  onChange={(v) => setField('website', v)}
                  disabled={savePending}
                  type="url"
                />
                <CompanyTextField
                  id="co-email"
                  labelKey="entity.companies.fieldEmail"
                  value={draft.email}
                  onChange={(v) => setField('email', v)}
                  disabled={savePending}
                  type="email"
                />
                <CompanyTextField
                  id="co-phone"
                  labelKey="entity.companies.fieldPhone"
                  value={draft.phone}
                  onChange={(v) => setField('phone', v)}
                  disabled={savePending}
                  type="tel"
                />
                <CompanyTextField
                  id="co-industry"
                  labelKey="entity.companies.fieldIndustry"
                  value={draft.industry}
                  onChange={(v) => setField('industry', v)}
                  disabled={savePending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="co-description">{t('entity.companies.fieldDescription')}</Label>
                <Textarea
                  id="co-description"
                  value={draft.description}
                  onChange={(e) => setField('description', e.target.value)}
                  disabled={savePending}
                  rows={4}
                  aria-describedby="co-description-hint"
                />
                <p id="co-description-hint" className="text-xs text-muted-foreground">
                  {t('entity.companies.enrichmentSummary')}
                </p>
              </div>
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">
                  {t('entity.companies.fieldAddressLegend')}
                </legend>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <CompanyTextField
                    id="co-addr-street"
                    labelKey="entity.companies.fieldAddressStreet"
                    value={draft.addressStreet}
                    onChange={(v) => setField('addressStreet', v)}
                    disabled={savePending}
                  />
                  <CompanyTextField
                    id="co-addr-house"
                    labelKey="entity.companies.fieldAddressHouseNumber"
                    value={draft.addressHouseNumber}
                    onChange={(v) => setField('addressHouseNumber', v)}
                    disabled={savePending}
                  />
                  <CompanyTextField
                    id="co-addr-postal"
                    labelKey="entity.companies.fieldAddressPostalCode"
                    value={draft.addressPostalCode}
                    onChange={(v) => setField('addressPostalCode', v)}
                    disabled={savePending}
                  />
                  <CompanyTextField
                    id="co-addr-city"
                    labelKey="entity.companies.fieldAddressCity"
                    value={draft.addressCity}
                    onChange={(v) => setField('addressCity', v)}
                    disabled={savePending}
                  />
                  <CompanyTextField
                    id="co-addr-country"
                    labelKey="entity.companies.fieldAddressCountry"
                    value={draft.addressCountry}
                    onChange={(v) => setField('addressCountry', v)}
                    disabled={savePending}
                  />
                </div>
              </fieldset>
              {saveError !== null ? (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  {t(saveError, { defaultValue: t('errors.entity.companies.saveFailed') })}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={savePending}
                >
                  {t('entity.companies.deleteCta')}
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={savePending}
                  >
                    {t('entity.companies.cancel')}
                  </Button>
                  <Button type="submit" disabled={savePending}>
                    {t('entity.companies.save')}
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {view.kind === 'ready' ? (
        <ExternalLinksCard
          links={view.company.externalLinks}
          linkForm={linkForm}
          onLinkFormChange={setLinkForm}
          onAdd={(e) => void handleAddLink(e)}
          onRefresh={() => void refresh()}
          onRemove={(id) => void handleRemoveLink(id)}
          pending={linkPending}
          removePending={linkRemovePending}
          errorKey={linkError}
        />
      ) : null}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t('entity.companies.deleteConfirmTitle')}
        body={t('entity.companies.deleteConfirmBody')}
        confirmLabel={t('entity.companies.deleteCta')}
        cancelLabel={t('entity.companies.cancel')}
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

interface ExternalLinksCardProps {
  readonly links: readonly EntityExternalLink[];
  readonly linkForm: string;
  readonly onLinkFormChange: (next: string) => void;
  readonly onAdd: (e: FormEvent<HTMLFormElement>) => void;
  readonly onRefresh: () => void;
  readonly onRemove: (id: string) => void;
  readonly pending: boolean;
  readonly removePending: string | null;
  readonly errorKey: string | null;
}

function ExternalLinksCard(props: ExternalLinksCardProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('entity.companies.externalLinksTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('entity.companies.externalLinksEmpty')}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {props.links.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {t('entity.companies.linkConnectorLabel', {
                      connector: link.connector,
                      externalId: link.externalId,
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(linkSyncStateBadgeKey(link.syncState))}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={props.onRefresh}
                    disabled={props.removePending !== null}
                  >
                    {t('entity.companies.linkSyncRefresh')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => props.onRemove(link.id)}
                    disabled={props.removePending === link.id}
                  >
                    {t('entity.companies.linkRemove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={props.onAdd} className="space-y-2" noValidate>
          <Label htmlFor="link-kvk">{t('entity.companies.linkKvkNumberLabel')}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="link-kvk"
              value={props.linkForm}
              onChange={(e) => props.onLinkFormChange(e.target.value)}
              disabled={props.pending}
              inputMode="numeric"
              autoComplete="off"
              className="max-w-xs"
            />
            <Button type="submit" disabled={props.pending}>
              {t('entity.companies.linkKvkAdd')}
            </Button>
          </div>
          {props.errorKey !== null ? (
            <p role="alert" aria-live="polite" className="text-sm text-destructive">
              {t(props.errorKey, { defaultValue: t('errors.entity.companies.linkAddFailed') })}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
