import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { createCompany, listCompanies } from '../lib/api';
import {
  companiesNewWebRoute,
  companyDetailWebRoute,
  slugifyCompanyTitle,
} from '../lib/companies-routes';
import { errorKeyOf } from '../lib/errors';
import { formatRelativeTime, isWithinHours } from '../lib/relative-time';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  buildCreateCompanyRequest,
  companiesListView,
  emptyCompanyFormDraft,
  validateCompanyForm,
  type CompaniesListInput,
  type CompanyFormDraft,
} from './companies-page-state';

/**
 * `/l/:layerSlug/companies` — list page.
 *
 * Fetches `GET /l/:layerSlug/company` (singular per the §4.0 router;
 * the singular ↔ plural URL mapping lives in
 * `apps/web/src/lib/companies-routes.ts`). The server returns
 * `EntitySummary[]` which carries `title`, `subtitle` (KvK number or
 * website per `companyModule.subtitle`), and `meta.updatedAt`. Per-row
 * payload fields like `address.city` and enrichment status are NOT in
 * the summary; clicking through to the detail page loads the full
 * payload (see `docs/dev/follow-ups/companies-list-columns.md` for the
 * gap and the follow-up).
 *
 * Loading / error / empty / ready branches are projected by the pure
 * reducer in `./companies-page-state.ts` so the matrix is testable
 * without a DOM runtime.
 *
 * Accessibility:
 *  - The page exposes a single `<h1>` via the card title.
 *  - The table uses `<th scope="col">` headers; each row is
 *    keyboard-navigable via the `<Link>` on the title cell.
 *  - Loading state uses `role="status" aria-live="polite"`; error uses
 *    `role="alert"`.
 *  - The create dialog inherits the native `<dialog>` focus trap from
 *    `components/ui/dialog.tsx`.
 */
export function CompaniesListPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const [input, setInput] = useState<CompaniesListInput>({ status: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const companies = await listCompanies(layerSlug);
      setInput({ status: 'ready', companies });
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug]);

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

  const view = companiesListView(input);
  const originalLocale = i18n.resolvedLanguage ?? 'en';
  const layer = current.layer;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('entity.companies.listTitle', { name: layer.name })}</CardTitle>
          <Button type="button" onClick={() => setDialogOpen(true)}>
            {t('entity.companies.createCta')}
          </Button>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.companies.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('entity.companies.listError') })}
            </p>
          ) : null}
          {view.kind === 'empty' ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">{t('entity.companies.listEmpty')}</p>
              <Button type="button" onClick={() => setDialogOpen(true)}>
                {t('entity.companies.createCta')}
              </Button>
            </div>
          ) : null}
          {view.kind === 'ready' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.companies.colTitle')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.companies.colSubtitle')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.companies.colCity')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.companies.colEnriched')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('entity.companies.colUpdatedAt')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.companies.map((c) => {
                    const extras = (c.extras ?? {}) as {
                      readonly city?: string | null;
                      readonly enrichmentLastRunAt?: string | null;
                    };
                    const enrichmentAt = extras.enrichmentLastRunAt ?? null;
                    const enrichmentLabel =
                      enrichmentAt === null
                        ? t('entity.companies.enrichmentNever')
                        : isWithinHours(enrichmentAt, 24)
                          ? t('entity.companies.enrichmentRecent')
                          : t('entity.companies.enrichmentStale');
                    const updatedRel =
                      formatRelativeTime(c.meta.updatedAt, {
                        ...(i18n.resolvedLanguage === undefined
                          ? {}
                          : { locale: i18n.resolvedLanguage }),
                      }) ?? c.meta.updatedAt;
                    return (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-medium">
                          <Link
                            to={companyDetailWebRoute(layer.slug, c.slug)}
                            className="text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {c.title}
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {c.subtitle ?? t('entity.companies.subtitle.noDetails')}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{extras.city ?? '—'}</td>
                        <td className="px-2 py-2 text-muted-foreground">
                          <span
                            data-enrichment-state={
                              enrichmentAt === null
                                ? 'never'
                                : isWithinHours(enrichmentAt, 24)
                                  ? 'recent'
                                  : 'stale'
                            }
                            title={enrichmentAt ?? undefined}
                          >
                            {enrichmentLabel}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground" title={c.meta.updatedAt}>
                          {updatedRel}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {dialogOpen ? (
        <CreateCompanyDialog
          layerSlug={layer.slug}
          originalLocale={originalLocale}
          onClose={() => setDialogOpen(false)}
          onCreated={async (companySlug) => {
            setDialogOpen(false);
            pushToast({ kind: 'success', message: t('entity.companies.created') });
            await refresh();
            navigate(companyDetailWebRoute(layer.slug, companySlug));
          }}
        />
      ) : null}

      {/* The /companies/new deep link (used by the dashboard widget's
          "Create company" CTA) renders the same dialog by mounting this
          page with `?new=1`. The router wires `/companies/new` to this
          same component; we open the dialog on first paint when the URL
          matches. */}
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
 * When the current location is `/l/:slug/companies/new`, automatically
 * open the create dialog on mount. The widget's "Create company" CTA
 * uses this entry point; the list page is the single canonical
 * surface, no separate `/new` page exists.
 */
function NewRouteDialogTrigger(props: NewRouteDialogTriggerProps): null {
  const { onOpen } = props;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname.endsWith('/companies/new')) {
      onOpen();
    }
    // Run once on mount — opening on subsequent renders would loop.
    // The intentional empty dep-list is checked in the test file
    // `companies-list-page.test.ts`; the codebase has no
    // react-hooks/exhaustive-deps rule configured.
  }, []);
  return null;
}

// ---------------------------------------------------------------------------

interface CreateCompanyDialogProps {
  readonly layerSlug: string;
  readonly originalLocale: string;
  readonly onClose: () => void;
  readonly onCreated: (companySlug: string) => Promise<void>;
}

function CreateCompanyDialog(props: CreateCompanyDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CompanyFormDraft>(() => emptyCompanyFormDraft());
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function setField<K extends keyof CompanyFormDraft>(key: K, value: CompanyFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleTitleChange(value: string): void {
    setDraft((prev) => ({
      ...prev,
      title: value,
      slug: slugTouched ? (prev.slug ?? '') : slugifyCompanyTitle(value),
    }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    const validation = validateCompanyForm(draft);
    if (validation !== null) {
      setErrorKey(validation);
      return;
    }
    setPending(true);
    try {
      const body = buildCreateCompanyRequest(draft, props.originalLocale);
      const created = await createCompany(props.layerSlug, body);
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
      title={t('entity.companies.createDialogTitle')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="newco-title">{t('entity.companies.fieldTitle')}</Label>
          <Input
            id="newco-title"
            value={draft.title}
            onChange={(e) => handleTitleChange(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newco-slug">{t('entity.companies.slug')}</Label>
          <Input
            id="newco-slug"
            value={draft.slug ?? ''}
            onChange={(e) => {
              setField('slug', e.target.value);
              setSlugTouched(true);
            }}
            disabled={pending}
            autoComplete="off"
            aria-describedby="newco-slug-hint"
          />
          <p id="newco-slug-hint" className="text-xs text-muted-foreground">
            {t('entity.companies.slugHint')}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <CompanyTextField
            id="newco-legalName"
            labelKey="entity.companies.fieldLegalName"
            value={draft.legalName}
            onChange={(v) => setField('legalName', v)}
            disabled={pending}
          />
          <CompanyTextField
            id="newco-tradeName"
            labelKey="entity.companies.fieldTradeName"
            value={draft.tradeName}
            onChange={(v) => setField('tradeName', v)}
            disabled={pending}
          />
          <CompanyTextField
            id="newco-kvkNumber"
            labelKey="entity.companies.fieldKvkNumber"
            value={draft.kvkNumber}
            onChange={(v) => setField('kvkNumber', v)}
            disabled={pending}
            inputMode="numeric"
          />
          <CompanyTextField
            id="newco-website"
            labelKey="entity.companies.fieldWebsite"
            value={draft.website}
            onChange={(v) => setField('website', v)}
            disabled={pending}
            type="url"
          />
          <CompanyTextField
            id="newco-email"
            labelKey="entity.companies.fieldEmail"
            value={draft.email}
            onChange={(v) => setField('email', v)}
            disabled={pending}
            type="email"
          />
          <CompanyTextField
            id="newco-phone"
            labelKey="entity.companies.fieldPhone"
            value={draft.phone}
            onChange={(v) => setField('phone', v)}
            disabled={pending}
            type="tel"
          />
          <CompanyTextField
            id="newco-industry"
            labelKey="entity.companies.fieldIndustry"
            value={draft.industry}
            onChange={(v) => setField('industry', v)}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newco-description">{t('entity.companies.fieldDescription')}</Label>
          <Textarea
            id="newco-description"
            value={draft.description}
            onChange={(e) => setField('description', e.target.value)}
            disabled={pending}
            rows={3}
          />
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.entity.companies.saveFailed') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('entity.companies.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('entity.companies.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

interface CompanyTextFieldProps {
  readonly id: string;
  readonly labelKey: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly disabled?: boolean;
  readonly type?: 'text' | 'url' | 'email' | 'tel';
  readonly inputMode?: 'text' | 'numeric';
}

/**
 * Small wrapper to keep the create / edit forms consistent and DRY
 * (label + input + spacing). Always renders a real `<label htmlFor>`
 * so the field is screen-reader accessible.
 */
export function CompanyTextField(props: CompanyTextFieldProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{t(props.labelKey)}</Label>
      <Input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.disabled === true}
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        autoComplete="off"
      />
    </div>
  );
}

// Re-export the `/companies/new` route landing point for the router —
// it is the same component as the list page, the dialog opens
// automatically on mount when the path matches.
export { CompaniesListPage as CompaniesNewPage };
export { companiesNewWebRoute };
