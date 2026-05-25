import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  getAdminObservabilityLlmCall,
  getAdminObservabilityLlmCallsRollups,
  listAdminObservabilityLlmCalls,
} from '../../lib/api';
import type {
  AdminObservabilityLlmCallDetail,
  AdminObservabilityLlmCallRow,
  AdminObservabilityLlmCallsFilter,
  AdminObservabilityLlmCallsRollupsResponse,
} from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';

/**
 * Phase 3 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/llm-calls`.
 *
 * Read-only viewer for the `llm_calls` telemetry table. Mirrors the
 * Phase 2 events viewer in shell + filter form + cursor pagination +
 * detail drawer; adds a rolling 24h / 7d rollups card at the top.
 *
 * Column-level redaction rules
 * (`docs/dev/audits/admin-observability-redaction-2026-05-25.md`):
 *  - `request` / `response` are excluded from the list response —
 *    the drawer fetches them lazily via the per-id endpoint.
 *  - Payloads > 200 KB are server-truncated with an explicit marker
 *    (R3 mitigation in the plan).
 *  - The drawer renders JSON inside `<pre tabindex="0">` so screen-
 *    reader users can navigate the content.
 *
 * Accessibility (plan §9):
 *  - Table headers use `<th scope="col">`.
 *  - Status column carries an icon + text label (not color-only).
 *  - Filter form uses real `<label for>` associations.
 *  - Detail drawer reuses the existing `<dialog>`-based `Dialog`
 *    (focus trap, ESC dismiss, focus return — same as the events
 *    viewer).
 */

interface FormState {
  model: string;
  endpoint: string;
  layerId: string;
  userId: string;
  status: '' | 'ok' | 'err';
  from: string;
  to: string;
  costMin: string;
  latencyMaxMs: string;
}

const EMPTY_FORM: FormState = {
  model: '',
  endpoint: '',
  layerId: '',
  userId: '',
  status: '',
  from: '',
  to: '',
  costMin: '',
  latencyMaxMs: '',
};

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly rows: readonly AdminObservabilityLlmCallRow[];
      readonly nextCursor: string | null;
    };

type RollupsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly data: AdminObservabilityLlmCallsRollupsResponse };

type DetailState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly id: string }
  | { readonly kind: 'error'; readonly id: string; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly data: AdminObservabilityLlmCallDetail };

export function AdminLlmCallsPage(): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [appliedFilter, setAppliedFilter] = useState<AdminObservabilityLlmCallsFilter>({});
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [rollups, setRollups] = useState<RollupsState>({ kind: 'idle' });
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });

  const load = useCallback(
    async (filter: AdminObservabilityLlmCallsFilter, mode: 'replace' | 'append'): Promise<void> => {
      if (mode === 'replace') setState({ kind: 'loading' });
      try {
        const res = await listAdminObservabilityLlmCalls(filter);
        setState((prev) => {
          if (mode === 'append' && prev.kind === 'ready') {
            return {
              kind: 'ready',
              rows: [...prev.rows, ...res.rows],
              nextCursor: res.nextCursor,
            };
          }
          return { kind: 'ready', rows: res.rows, nextCursor: res.nextCursor };
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
      const data = await getAdminObservabilityLlmCallsRollups();
      setRollups({ kind: 'ready', data });
    } catch (err: unknown) {
      setRollups({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, []);

  useEffect(() => {
    void load(appliedFilter, 'replace');
  }, [appliedFilter, load]);

  useEffect(() => {
    void loadRollups();
  }, [loadRollups]);

  function onApply(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    // Build the mutable shape locally; the `AdminObservabilityLlmCallsFilter`
    // type uses `readonly` properties so we can't assign into a typed
    // empty object — assemble a plain dict and widen at the end.
    const next: {
      model?: string;
      endpoint?: string;
      layerId?: string;
      userId?: string;
      status?: 'ok' | 'err';
      from?: string;
      to?: string;
      costMin?: number;
      latencyMaxMs?: number;
    } = {};
    if (form.model.trim() !== '') next.model = form.model.trim();
    if (form.endpoint.trim() !== '') next.endpoint = form.endpoint.trim();
    if (form.layerId.trim() !== '') next.layerId = form.layerId.trim();
    if (form.userId.trim() !== '') next.userId = form.userId.trim();
    if (form.status !== '') next.status = form.status;
    if (form.from.trim() !== '') next.from = form.from.trim();
    if (form.to.trim() !== '') next.to = form.to.trim();
    if (form.costMin.trim() !== '') {
      const n = Number(form.costMin);
      if (Number.isFinite(n) && n >= 0) next.costMin = n;
    }
    if (form.latencyMaxMs.trim() !== '') {
      const n = Number(form.latencyMaxMs);
      if (Number.isFinite(n) && n >= 0) next.latencyMaxMs = n;
    }
    setAppliedFilter(next);
  }

  function onReset(): void {
    setForm(EMPTY_FORM);
    setAppliedFilter({});
  }

  function onLoadMore(): void {
    if (state.kind !== 'ready' || state.nextCursor === null) return;
    void load({ ...appliedFilter, cursor: state.nextCursor }, 'append');
  }

  function onRefresh(): void {
    void load(appliedFilter, 'replace');
    void loadRollups();
  }

  async function onOpenDetail(row: AdminObservabilityLlmCallRow): Promise<void> {
    setDetail({ kind: 'loading', id: row.id });
    try {
      const data = await getAdminObservabilityLlmCall(row.id);
      setDetail({ kind: 'ready', data });
    } catch (err: unknown) {
      setDetail({ kind: 'error', id: row.id, errorKey: errorKeyOf(err) });
    }
  }

  function onCloseDetail(): void {
    setDetail({ kind: 'idle' });
  }

  return (
    <>
      <AdminPageShell
        title={t('admin.llmCalls.title')}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
            {t('admin.llmCalls.refresh')}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t('admin.llmCalls.description')}</p>

        <RollupsCard state={rollups} />

        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          aria-label={t('admin.llmCalls.filters.label')}
          onSubmit={onApply}
          onReset={onReset}
        >
          <FilterField
            id="adminLlmCallsModel"
            label={t('admin.llmCalls.filters.model')}
            value={form.model}
            onChange={(v) => setForm((f) => ({ ...f, model: v }))}
          />
          <FilterField
            id="adminLlmCallsEndpoint"
            label={t('admin.llmCalls.filters.endpoint')}
            value={form.endpoint}
            onChange={(v) => setForm((f) => ({ ...f, endpoint: v }))}
          />
          <FilterField
            id="adminLlmCallsLayer"
            label={t('admin.llmCalls.filters.layerId')}
            value={form.layerId}
            onChange={(v) => setForm((f) => ({ ...f, layerId: v }))}
          />
          <FilterField
            id="adminLlmCallsUser"
            label={t('admin.llmCalls.filters.userId')}
            value={form.userId}
            onChange={(v) => setForm((f) => ({ ...f, userId: v }))}
          />
          <div className="space-y-1">
            <Label htmlFor="adminLlmCallsStatus">{t('admin.llmCalls.filters.status')}</Label>
            <select
              id="adminLlmCallsStatus"
              className="flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.status}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'ok' || v === 'err' || v === '') {
                  setForm((f) => ({ ...f, status: v }));
                }
              }}
            >
              <option value="">{t('admin.llmCalls.filters.statusAll')}</option>
              <option value="ok">{t('admin.llmCalls.filters.statusOk')}</option>
              <option value="err">{t('admin.llmCalls.filters.statusErr')}</option>
            </select>
          </div>
          <FilterField
            id="adminLlmCallsFrom"
            label={t('admin.llmCalls.filters.from')}
            type="datetime-local"
            value={form.from}
            onChange={(v) => setForm((f) => ({ ...f, from: v }))}
          />
          <FilterField
            id="adminLlmCallsTo"
            label={t('admin.llmCalls.filters.to')}
            type="datetime-local"
            value={form.to}
            onChange={(v) => setForm((f) => ({ ...f, to: v }))}
          />
          <FilterField
            id="adminLlmCallsCostMin"
            label={t('admin.llmCalls.filters.costMin')}
            type="number"
            value={form.costMin}
            onChange={(v) => setForm((f) => ({ ...f, costMin: v }))}
          />
          <FilterField
            id="adminLlmCallsLatencyMaxMs"
            label={t('admin.llmCalls.filters.latencyMaxMs')}
            type="number"
            value={form.latencyMaxMs}
            onChange={(v) => setForm((f) => ({ ...f, latencyMaxMs: v }))}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="reset" variant="ghost" size="sm">
              {t('admin.llmCalls.filters.reset')}
            </Button>
            <Button type="submit" size="sm">
              {t('admin.llmCalls.filters.apply')}
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
            <p className="text-sm text-muted-foreground">{t('admin.llmCalls.empty')}</p>
          ) : null}
          {state.kind === 'ready' && state.rows.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.startedAt')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.model')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.endpoint')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.tokens')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.costUsd')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.latencyMs')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.llmCalls.columns.status')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        <span className="sr-only">{t('admin.llmCalls.columns.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.startedAt}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs">{row.model}</td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.endpoint}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.tokensIn ?? '—'} / {row.tokensOut ?? '—'}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.costUsd === null ? '—' : `$${row.costUsd.toFixed(4)}`}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.latencyMs === null ? '—' : `${row.latencyMs}`}
                        </td>
                        <td className="px-2 py-2 text-xs">
                          <StatusBadge hasError={row.hasError} />
                        </td>
                        <td className="px-2 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void onOpenDetail(row)}
                          >
                            {t('admin.llmCalls.viewDetail')}
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
                    {t('admin.llmCalls.loadMore')}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('admin.llmCalls.endOfResults')}
                  </span>
                )}
              </div>
            </>
          ) : null}
        </div>
      </AdminPageShell>

      <Dialog
        open={detail.kind !== 'idle'}
        onClose={onCloseDetail}
        title={
          detail.kind === 'ready'
            ? `${detail.data.model} · ${detail.data.startedAt}`
            : t('admin.llmCalls.detail.title')
        }
        closeLabel={t('common.close')}
      >
        {detail.kind === 'loading' ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : null}
        {detail.kind === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {t(detail.errorKey, { defaultValue: t('errors.network') })}
          </p>
        ) : null}
        {detail.kind === 'ready' ? <DetailBody detail={detail.data} /> : null}
      </Dialog>
    </>
  );
}

interface FilterFieldProps {
  readonly id: string;
  readonly label: string;
  readonly type?: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

function FilterField(props: FilterFieldProps): JSX.Element {
  const { id, label, type, value, onChange } = props;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function StatusBadge({ hasError }: { readonly hasError: boolean }): JSX.Element {
  const { t } = useTranslation();
  // Per plan §9 / accessibility: never color-only. Carry an icon + label.
  if (hasError) {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <span aria-hidden="true">{'✕'}</span>
        <span>{t('admin.llmCalls.status.err')}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-foreground">
      <span aria-hidden="true">{'✓'}</span>
      <span>{t('admin.llmCalls.status.ok')}</span>
    </span>
  );
}

function RollupsCard({ state }: { readonly state: RollupsState }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t('admin.llmCalls.rollups.label')}
      className="mt-4 rounded-md border bg-muted/30 p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('admin.llmCalls.rollups.heading')}
      </h2>
      {state.kind === 'loading' ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t(state.errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
          <RollupWindow
            heading={t('admin.llmCalls.rollups.window24h')}
            data={state.data.window24h}
          />
          <RollupWindow heading={t('admin.llmCalls.rollups.window7d')} data={state.data.window7d} />
        </dl>
      ) : null}
    </section>
  );
}

function RollupWindow({
  heading,
  data,
}: {
  readonly heading: string;
  readonly data: {
    count: number;
    errorRate: number;
    totalCostUsd: number;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
  };
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{heading}</p>
      <div className="grid grid-cols-2 gap-1 font-mono text-xs">
        <span>{t('admin.llmCalls.rollups.count')}</span>
        <span className="text-right">{data.count}</span>
        <span>{t('admin.llmCalls.rollups.cost')}</span>
        <span className="text-right">${data.totalCostUsd.toFixed(4)}</span>
        <span>{t('admin.llmCalls.rollups.p50')}</span>
        <span className="text-right">
          {data.p50LatencyMs === null ? '—' : `${data.p50LatencyMs} ms`}
        </span>
        <span>{t('admin.llmCalls.rollups.p95')}</span>
        <span className="text-right">
          {data.p95LatencyMs === null ? '—' : `${data.p95LatencyMs} ms`}
        </span>
        <span>{t('admin.llmCalls.rollups.errorRate')}</span>
        <span className="text-right">{(data.errorRate * 100).toFixed(2)}%</span>
      </div>
    </div>
  );
}

function DetailBody({ detail }: { readonly detail: AdminObservabilityLlmCallDetail }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <DetailRow label={t('admin.llmCalls.detail.id')} value={detail.id} />
        <DetailRow label={t('admin.llmCalls.detail.model')} value={detail.model} />
        <DetailRow label={t('admin.llmCalls.detail.endpoint')} value={detail.endpoint} />
        <DetailRow
          label={t('admin.llmCalls.detail.modelSource')}
          value={detail.modelSource ?? '—'}
        />
        <DetailRow
          label={t('admin.llmCalls.detail.latencyMs')}
          value={detail.latencyMs === null ? '—' : `${detail.latencyMs}`}
        />
        <DetailRow
          label={t('admin.llmCalls.detail.costUsd')}
          value={detail.costUsd === null ? '—' : `$${detail.costUsd.toFixed(6)}`}
        />
        <DetailRow
          label={t('admin.llmCalls.detail.tokensIn')}
          value={detail.tokensIn === null ? '—' : `${detail.tokensIn}`}
        />
        <DetailRow
          label={t('admin.llmCalls.detail.tokensOut')}
          value={detail.tokensOut === null ? '—' : `${detail.tokensOut}`}
        />
        <DetailRow
          label={t('admin.llmCalls.detail.correlationId')}
          value={detail.correlationId ?? '—'}
        />
        <DetailRow label={t('admin.llmCalls.detail.flowId')} value={detail.flowId ?? '—'} />
        <DetailRow label={t('admin.llmCalls.detail.layerId')} value={detail.layerId ?? '—'} />
        <DetailRow label={t('admin.llmCalls.detail.userId')} value={detail.userId ?? '—'} />
      </dl>
      {detail.error !== null ? (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('admin.llmCalls.detail.error')}
          </p>
          <p className="text-sm text-destructive">{detail.error}</p>
        </div>
      ) : null}
      <CollapsibleJson
        label={t('admin.llmCalls.detail.request')}
        raw={detail.request}
        truncated={detail.requestTruncated}
        originalBytes={detail.requestOriginalBytes}
      />
      <CollapsibleJson
        label={t('admin.llmCalls.detail.response')}
        raw={detail.response}
        truncated={detail.responseTruncated}
        originalBytes={detail.responseOriginalBytes}
      />
      <LinkedEventsSection events={detail.linkedEvents} />
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

/**
 * Collapsed-by-default JSON renderer used for `request` and
 * `response`. The plan calls out "render only a sensible prefix
 * by default with explicit expander when the payload is long" —
 * the `<details>` element gives keyboard-accessible expand/collapse
 * with focus and ARIA built-in.
 */
function CollapsibleJson({
  label,
  raw,
  truncated,
  originalBytes,
}: {
  readonly label: string;
  readonly raw: string | null;
  readonly truncated: boolean;
  readonly originalBytes: number;
}): JSX.Element {
  const { t } = useTranslation();
  if (raw === null || raw === '') {
    return (
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">{t('admin.llmCalls.detail.empty')}</p>
      </div>
    );
  }
  let pretty = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    pretty = JSON.stringify(parsed, null, 2);
  } catch {
    // Non-JSON or partial (truncated) — render verbatim.
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        {truncated ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {t('admin.llmCalls.detail.truncated', { bytes: originalBytes })}
          </span>
        ) : null}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          {t('admin.llmCalls.detail.expandJson')}
        </summary>
        <pre
          tabIndex={0}
          className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-snug"
        >
          {pretty}
        </pre>
      </details>
    </div>
  );
}

function LinkedEventsSection({
  events,
}: {
  readonly events: readonly AdminObservabilityLlmCallDetail['linkedEvents'][number][];
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {t('admin.llmCalls.detail.linkedEvents')}
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.llmCalls.detail.linkedEventsEmpty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.llmCalls.detail.linkedEventsColumns.occurredAt')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.llmCalls.detail.linkedEventsColumns.type')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('admin.llmCalls.detail.linkedEventsColumns.id')}
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} className="border-b last:border-0">
                  <td className="px-2 py-1 font-mono text-muted-foreground">{ev.occurredAt}</td>
                  <td className="px-2 py-1 font-mono">{ev.type}</td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">{ev.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
