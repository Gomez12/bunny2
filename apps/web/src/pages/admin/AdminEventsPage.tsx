import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { listAdminObservabilityEvents } from '../../lib/api';
import type {
  AdminObservabilityEventRow,
  AdminObservabilityEventsFilter,
} from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';

/**
 * Phase 2 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/events`.
 *
 * Read-only view of the canonical `events` log. The wireframe lives
 * in the plan §5 "Phase 2"; the column-level redaction rules live in
 * `docs/dev/audits/admin-observability-redaction-2026-05-25.md`:
 * `payload` + `metadata` are surfaced only inside the detail drawer,
 * collapsed by default. Inline rows show metadata-only columns (id,
 * type, timestamp, layer / flow / correlation ids).
 *
 * Pagination is cursor-based — the server returns the next cursor
 * alongside the page; "Next" appends a page below the current page.
 * "Reset filters" wipes the form and re-fetches from the top.
 *
 * Accessibility (plan §9):
 *  - Table headers use `<th scope="col">`.
 *  - Filter form uses real `<label for>` associations.
 *  - Detail drawer uses the existing native-`<dialog>`-based `Dialog`
 *    component, which gives focus trap, ESC dismiss, and focus
 *    return for free.
 *  - JSON payloads render inside `<pre tabindex="0">` so screen
 *    readers can navigate them.
 *  - Status is never color-only — every row carries the textual
 *    event `type`.
 */

interface FormState {
  kind: string;
  from: string;
  to: string;
  layerId: string;
  flowId: string;
  correlationId: string;
}

const EMPTY_FORM: FormState = {
  kind: '',
  from: '',
  to: '',
  layerId: '',
  flowId: '',
  correlationId: '',
};

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly rows: readonly AdminObservabilityEventRow[];
      readonly nextCursor: string | null;
    };

export function AdminEventsPage(): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // Snapshot of the filters most recently applied (separate from
  // `form` so typing in the form does not re-fire the query).
  const [appliedFilter, setAppliedFilter] = useState<AdminObservabilityEventsFilter>({});
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [selectedRow, setSelectedRow] = useState<AdminObservabilityEventRow | null>(null);

  const load = useCallback(
    async (filter: AdminObservabilityEventsFilter, mode: 'replace' | 'append'): Promise<void> => {
      if (mode === 'replace') setState({ kind: 'loading' });
      try {
        const res = await listAdminObservabilityEvents(filter);
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

  useEffect(() => {
    void load(appliedFilter, 'replace');
  }, [appliedFilter, load]);

  function onApply(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const next: {
      kind?: string;
      from?: string;
      to?: string;
      layerId?: string;
      flowId?: string;
      correlationId?: string;
    } = {};
    if (form.kind.trim() !== '') next.kind = form.kind.trim();
    if (form.from.trim() !== '') next.from = form.from.trim();
    if (form.to.trim() !== '') next.to = form.to.trim();
    if (form.layerId.trim() !== '') next.layerId = form.layerId.trim();
    if (form.flowId.trim() !== '') next.flowId = form.flowId.trim();
    if (form.correlationId.trim() !== '') next.correlationId = form.correlationId.trim();
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
  }

  return (
    <>
      <AdminPageShell
        title={t('admin.events.title')}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
            {t('admin.events.refresh')}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t('admin.events.description')}</p>

        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          aria-label={t('admin.events.filters.label')}
          onSubmit={onApply}
          onReset={onReset}
        >
          <FilterField
            id="adminEventsKind"
            label={t('admin.events.filters.kind')}
            hint={t('admin.events.filters.kindHint')}
            value={form.kind}
            onChange={(v) => setForm((f) => ({ ...f, kind: v }))}
            placeholder={t('admin.events.filters.kindPlaceholder')}
          />
          <FilterField
            id="adminEventsFrom"
            label={t('admin.events.filters.from')}
            type="datetime-local"
            value={form.from}
            onChange={(v) => setForm((f) => ({ ...f, from: v }))}
          />
          <FilterField
            id="adminEventsTo"
            label={t('admin.events.filters.to')}
            type="datetime-local"
            value={form.to}
            onChange={(v) => setForm((f) => ({ ...f, to: v }))}
          />
          <FilterField
            id="adminEventsLayer"
            label={t('admin.events.filters.layerId')}
            value={form.layerId}
            onChange={(v) => setForm((f) => ({ ...f, layerId: v }))}
          />
          <FilterField
            id="adminEventsFlow"
            label={t('admin.events.filters.flowId')}
            value={form.flowId}
            onChange={(v) => setForm((f) => ({ ...f, flowId: v }))}
          />
          <FilterField
            id="adminEventsCorrelation"
            label={t('admin.events.filters.correlationId')}
            value={form.correlationId}
            onChange={(v) => setForm((f) => ({ ...f, correlationId: v }))}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="reset" variant="ghost" size="sm">
              {t('admin.events.filters.reset')}
            </Button>
            <Button type="submit" size="sm">
              {t('admin.events.filters.apply')}
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
            <p className="text-sm text-muted-foreground">{t('admin.events.empty')}</p>
          ) : null}
          {state.kind === 'ready' && state.rows.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.events.columns.occurredAt')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.events.columns.type')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.events.columns.flowId')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        {t('admin.events.columns.correlationId')}
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        <span className="sr-only">{t('admin.events.columns.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.occurredAt}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs">{row.type}</td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.flowId ?? '—'}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                          {row.correlationId ?? '—'}
                        </td>
                        <td className="px-2 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedRow(row)}
                          >
                            {t('admin.events.viewDetail')}
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
                    {t('admin.events.loadMore')}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('admin.events.endOfResults')}
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
            ? t('admin.events.detail.title')
            : `${selectedRow.type} · ${selectedRow.occurredAt}`
        }
        closeLabel={t('common.close')}
      >
        {selectedRow === null ? null : (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <DetailRow label={t('admin.events.detail.id')} value={selectedRow.id} />
              <DetailRow
                label={t('admin.events.detail.correlationId')}
                value={selectedRow.correlationId ?? '—'}
              />
              <DetailRow
                label={t('admin.events.detail.flowId')}
                value={selectedRow.flowId ?? '—'}
              />
            </dl>
            <JsonBlock label={t('admin.events.detail.payload')} raw={selectedRow.payload} />
            <JsonBlock label={t('admin.events.detail.metadata')} raw={selectedRow.metadata} />
          </div>
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
  readonly placeholder?: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

function FilterField(props: FilterFieldProps): JSX.Element {
  const { id, label, hint, type, placeholder, value, onChange } = props;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint !== undefined ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
 * Pretty-prints a raw JSON-string column (`events.payload` or
 * `.metadata`) inside a `<pre>`. Falls back to the raw string when
 * the column is null or not parseable, so a partial / non-JSON
 * payload never crashes the drawer. The `<pre>` carries
 * `tabindex="0"` so screen readers can step into it
 * (plan §9 accessibility).
 */
function JsonBlock({
  label,
  raw,
}: {
  readonly label: string;
  readonly raw: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  if (raw === null || raw === '') {
    return (
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">{t('admin.events.detail.empty')}</p>
      </div>
    );
  }
  let pretty = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    pretty = JSON.stringify(parsed, null, 2);
  } catch {
    // Leave `pretty = raw` — the field is not JSON; render verbatim.
  }
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-snug"
      >
        {pretty}
      </pre>
    </div>
  );
}
