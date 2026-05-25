import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  getAdminObservabilityAnalyticsRollups,
  listAdminObservabilityAnalytics,
} from '../../lib/api';
import type {
  AdminObservabilityAnalyticsCatalogueEntry,
  AdminObservabilityAnalyticsFilter,
  AdminObservabilityAnalyticsResponse,
  AdminObservabilityAnalyticsRollupItem,
  AdminObservabilityAnalyticsRollupsResponse,
  AdminObservabilityAnalyticsRow,
} from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';

/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/analytics`.
 *
 * Read-only viewer for the `analytics_events` table seeded by the
 * web sink (`POST /analytics/events`). The wireframe lives in the
 * plan §5 "Phase 6"; per the redaction audit, properties_json is
 * catalogue-bounded so inline rendering is safe.
 *
 * Three regions on the page:
 *   - Rollups card with rolling 24h / 7d per-event counts.
 *   - Filter form (event name dropdown sourced from the catalogue,
 *     layer slug, user id hash, from / to).
 *   - Table with cursor pagination; row click opens a drawer that
 *     pairs the row's `propertiesJson` with the catalogue's
 *     documented schema for that event name (drift detection).
 *
 * Accessibility mirrors the other admin viewer pages: native
 * `<dialog>` drawer, `<th scope="col">` headers, real form labels,
 * `tabindex="0"` on the JSON `<pre>` so screen readers can step in.
 */

interface FormState {
  eventName: string;
  layerSlug: string;
  userIdHash: string;
  from: string;
  to: string;
}

const EMPTY_FORM: FormState = {
  eventName: '',
  layerSlug: '',
  userIdHash: '',
  from: '',
  to: '',
};

type ListState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly rows: readonly AdminObservabilityAnalyticsRow[];
      readonly nextCursor: string | null;
      readonly catalogue: readonly AdminObservabilityAnalyticsCatalogueEntry[];
    };

type RollupsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly value: AdminObservabilityAnalyticsRollupsResponse };

export function AdminAnalyticsPage(): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [applied, setApplied] = useState<AdminObservabilityAnalyticsFilter>({});
  const [state, setState] = useState<ListState>({ kind: 'idle' });
  const [rollups, setRollups] = useState<RollupsState>({ kind: 'idle' });
  const [selectedRow, setSelectedRow] = useState<AdminObservabilityAnalyticsRow | null>(null);
  const [catalogue, setCatalogue] = useState<readonly AdminObservabilityAnalyticsCatalogueEntry[]>(
    [],
  );

  const loadList = useCallback(
    async (
      filter: AdminObservabilityAnalyticsFilter,
      mode: 'replace' | 'append',
    ): Promise<void> => {
      if (mode === 'replace') setState({ kind: 'loading' });
      try {
        const res: AdminObservabilityAnalyticsResponse =
          await listAdminObservabilityAnalytics(filter);
        setCatalogue(res.catalogue);
        setState((prev) => {
          if (mode === 'append' && prev.kind === 'ready') {
            return {
              kind: 'ready',
              rows: [...prev.rows, ...res.rows],
              nextCursor: res.nextCursor,
              catalogue: res.catalogue,
            };
          }
          return {
            kind: 'ready',
            rows: res.rows,
            nextCursor: res.nextCursor,
            catalogue: res.catalogue,
          };
        });
      } catch (err: unknown) {
        setState({ kind: 'error', errorKey: errorKeyOf(err) });
      }
    },
    [],
  );

  const loadRollups = useCallback(async (): Promise<void> => {
    setRollups({ kind: 'loading' });
    try {
      const res = await getAdminObservabilityAnalyticsRollups();
      setRollups({ kind: 'ready', value: res });
    } catch (err: unknown) {
      setRollups({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, []);

  useEffect(() => {
    void loadList(applied, 'replace');
  }, [applied, loadList]);

  useEffect(() => {
    void loadRollups();
  }, [loadRollups]);

  function onApply(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const next: {
      eventName?: string;
      layerSlug?: string;
      userIdHash?: string;
      from?: string;
      to?: string;
    } = {};
    if (form.eventName !== '') next.eventName = form.eventName;
    if (form.layerSlug.trim() !== '') next.layerSlug = form.layerSlug.trim();
    if (form.userIdHash.trim() !== '') next.userIdHash = form.userIdHash.trim();
    if (form.from.trim() !== '') next.from = form.from.trim();
    if (form.to.trim() !== '') next.to = form.to.trim();
    setApplied(next);
  }

  function onReset(): void {
    setForm(EMPTY_FORM);
    setApplied({});
  }

  function onLoadMore(): void {
    if (state.kind !== 'ready' || state.nextCursor === null) return;
    void loadList({ ...applied, cursor: state.nextCursor }, 'append');
  }

  function onRefresh(): void {
    void loadList(applied, 'replace');
    void loadRollups();
  }

  const catalogueByName = useMemo(() => {
    const map = new Map<string, readonly string[]>();
    for (const entry of catalogue) map.set(entry.name, entry.allowedProps);
    return map;
  }, [catalogue]);

  return (
    <>
      <AdminPageShell
        title={t('admin.analytics.title')}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
            {t('admin.analytics.refresh')}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t('admin.analytics.description')}</p>

        <RollupsCard state={rollups} />

        <form
          className="mt-6 grid gap-3 sm:grid-cols-2"
          aria-label={t('admin.analytics.filters.label')}
          onSubmit={onApply}
          onReset={onReset}
        >
          <div className="space-y-1">
            <Label htmlFor="adminAnalyticsEventName">
              {t('admin.analytics.filters.eventName')}
            </Label>
            <select
              id="adminAnalyticsEventName"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.eventName}
              onChange={(e) => setForm((f) => ({ ...f, eventName: e.target.value }))}
            >
              <option value="">{t('admin.analytics.filters.eventNameAll')}</option>
              {catalogue.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
          <FilterField
            id="adminAnalyticsLayerSlug"
            label={t('admin.analytics.filters.layerSlug')}
            value={form.layerSlug}
            onChange={(v) => setForm((f) => ({ ...f, layerSlug: v }))}
          />
          <FilterField
            id="adminAnalyticsUserIdHash"
            label={t('admin.analytics.filters.userIdHash')}
            hint={t('admin.analytics.filters.userIdHashHint')}
            value={form.userIdHash}
            onChange={(v) => setForm((f) => ({ ...f, userIdHash: v }))}
          />
          <FilterField
            id="adminAnalyticsFrom"
            label={t('admin.analytics.filters.from')}
            type="datetime-local"
            value={form.from}
            onChange={(v) => setForm((f) => ({ ...f, from: v }))}
          />
          <FilterField
            id="adminAnalyticsTo"
            label={t('admin.analytics.filters.to')}
            type="datetime-local"
            value={form.to}
            onChange={(v) => setForm((f) => ({ ...f, to: v }))}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="reset" variant="ghost" size="sm">
              {t('admin.analytics.filters.reset')}
            </Button>
            <Button type="submit" size="sm">
              {t('admin.analytics.filters.apply')}
            </Button>
          </div>
        </form>

        <div className="mt-6">
          {state.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          ) : null}
          {state.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(state.errorKey, { defaultValue: t('errors.network') })}
            </p>
          ) : null}
          {state.kind === 'ready' && state.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.analytics.empty')}</p>
          ) : null}
          {state.kind === 'ready' && state.rows.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.analytics.columns.occurredAt')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.analytics.columns.eventName')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.analytics.columns.layerSlug')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.analytics.columns.userIdHash')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        <span className="sr-only">{t('admin.analytics.columns.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.occurredAt}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs">{row.eventName}</td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.layerSlug ?? '—'}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.userIdHash === null ? '—' : `${row.userIdHash.slice(0, 8)}…`}
                        </td>
                        <td className="px-2 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedRow(row)}
                          >
                            {t('admin.analytics.viewDetail')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex justify-end">
                {state.nextCursor !== null ? (
                  <Button type="button" size="sm" variant="ghost" onClick={onLoadMore}>
                    {t('admin.analytics.loadMore')}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('admin.analytics.endOfResults')}
                  </span>
                )}
              </div>
            </>
          ) : null}
        </div>
      </AdminPageShell>

      <Dialog
        open={selectedRow !== null}
        onClose={() => setSelectedRow(null)}
        title={
          selectedRow === null
            ? t('admin.analytics.detail.title')
            : `${selectedRow.eventName} · ${selectedRow.occurredAt}`
        }
        closeLabel={t('common.close')}
      >
        {selectedRow === null ? null : (
          <DetailDrawer row={selectedRow} catalogueByName={catalogueByName} />
        )}
      </Dialog>
    </>
  );
}

interface FilterFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly type?: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

function FilterField(props: FilterFieldProps): JSX.Element {
  const { id, label, hint, type, value, onChange } = props;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint !== undefined ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RollupsCard({ state }: { readonly state: RollupsState }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('admin.analytics.rollups.label')}
      className="mt-4 rounded-md border bg-muted/20 p-4"
    >
      <h2 className="text-sm font-medium">{t('admin.analytics.rollups.heading')}</h2>
      {state.kind === 'loading' ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}
      {state.kind === 'error' ? (
        <p className="mt-2 text-sm text-destructive">
          {t(state.errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <RollupsColumn
            title={t('admin.analytics.rollups.window24h')}
            totalLabel={t('admin.analytics.rollups.total', {
              count: state.value.totalCount24h,
            })}
            items={state.value.window24h}
          />
          <RollupsColumn
            title={t('admin.analytics.rollups.window7d')}
            totalLabel={t('admin.analytics.rollups.total', {
              count: state.value.totalCount7d,
            })}
            items={state.value.window7d}
          />
        </div>
      ) : null}
    </section>
  );
}

function RollupsColumn({
  title,
  totalLabel,
  items,
}: {
  readonly title: string;
  readonly totalLabel: string;
  readonly items: readonly AdminObservabilityAnalyticsRollupItem[];
}): JSX.Element {
  const { t } = useTranslation();
  const topItems = items.slice(0, 5);
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="text-sm text-muted-foreground">{totalLabel}</p>
      {topItems.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('admin.analytics.rollups.empty')}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {topItems.map((item) => (
            <li key={item.eventName} className="flex justify-between gap-3 font-mono text-xs">
              <span className="truncate">{item.eventName}</span>
              <span className="tabular-nums text-muted-foreground">{item.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailDrawer({
  row,
  catalogueByName,
}: {
  readonly row: AdminObservabilityAnalyticsRow;
  readonly catalogueByName: ReadonlyMap<string, readonly string[]>;
}): JSX.Element {
  const { t } = useTranslation();
  const documented = catalogueByName.get(row.eventName);
  const parsed = useMemo<Record<string, unknown> | null>(() => {
    try {
      const v = JSON.parse(row.propertiesJson) as unknown;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }, [row.propertiesJson]);
  const presentKeys = parsed === null ? [] : Object.keys(parsed).sort();
  const documentedKeys = documented ?? [];
  // Drift detection: any key on this row that is NOT in the catalogue
  // for this event name. With ingest validation in place this should
  // be empty for any post-Phase-6 row, but the column persists for
  // historical rows from any earlier sink configuration.
  const driftedKeys = presentKeys.filter((k) => !documentedKeys.includes(k));
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <DetailRow label={t('admin.analytics.detail.id')} value={row.id} />
        <DetailRow label={t('admin.analytics.detail.layerSlug')} value={row.layerSlug ?? '—'} />
        <DetailRow label={t('admin.analytics.detail.userIdHash')} value={row.userIdHash ?? '—'} />
        <DetailRow label={t('admin.analytics.detail.ingestedAt')} value={row.ingestedAt} />
      </dl>

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('admin.analytics.detail.documentedProps')}
        </p>
        {documented === undefined ? (
          <p className="mt-1 text-sm text-destructive">
            {t('admin.analytics.detail.eventNameUnknown')}
          </p>
        ) : documentedKeys.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('admin.analytics.detail.documentedPropsEmpty')}
          </p>
        ) : (
          <ul className="mt-1 list-inside list-disc text-sm">
            {documentedKeys.map((k) => (
              <li key={k} className="font-mono text-xs">
                {k}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('admin.analytics.detail.rowProps')}
        </p>
        {parsed === null ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('admin.analytics.detail.rowPropsInvalid')}
          </p>
        ) : presentKeys.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('admin.analytics.detail.rowPropsEmpty')}
          </p>
        ) : (
          <pre
            tabIndex={0}
            className="mt-1 max-h-60 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-snug"
          >
            {JSON.stringify(parsed, null, 2)}
          </pre>
        )}
        {driftedKeys.length > 0 ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t('admin.analytics.detail.driftedKeys', { keys: driftedKeys.join(', ') })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs break-all">{value}</dd>
    </div>
  );
}
