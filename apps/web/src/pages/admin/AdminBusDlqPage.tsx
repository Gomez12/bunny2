import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  getAdminBusOutboxDetail,
  listAdminBusDlq,
  listAdminBusOutbox,
  replayAdminBusDlq,
} from '../../lib/api';
import type {
  AdminBusDlqRow,
  AdminBusOutboxDetail,
  AdminBusOutboxFilter,
  AdminBusOutboxRow,
  AdminBusOutboxStatus,
} from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { pushToast } from '../../lib/toast';

/**
 * Phase 5.6 (initial DLQ surface) + admin-observability plan §5
 * phase 5 (bus outbox ledger expansion) — `/admin/bus/dlq`.
 *
 * The page presents two tabs:
 *
 *   1. DLQ — rows the durable bus moved to the dead-letter queue.
 *      Each row carries a Replay action (confirm dialog →
 *      `POST /admin/bus/dlq/:outboxId/replay`). Successful replay
 *      removes the row locally and refetches the list so the admin
 *      sees an accurate count.
 *   2. Outbox — non-DLQ outbox rows (pending / in_flight / delivered
 *      / dead / abandoned). Filter on status + event-type prefix +
 *      time range. The list is paginated via cursor (mirrors the
 *      events / llm-calls viewers). Row click opens a drawer with
 *      the redacted payload + metadata. Read-only — DLQ replay
 *      stays as the only write path.
 *
 * Plan §13 accessibility: tabs use `role="tablist"` / `role="tab"` /
 * `aria-controls`. The Replay button is a real `<button>`; the
 * confirm dialog reuses `ConfirmDialog` (native `<dialog>`,
 * focus-trap, ESC dismiss inherited from
 * `components/ui/dialog.tsx`). 503 from the server (durable adapter
 * not wired — tests with the in-memory bus path) lands in the
 * row-level error region as `errors.bus.dlqReplayFailed`.
 */

type TabKey = 'dlq' | 'outbox';

export function AdminBusDlqPage(): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('dlq');

  return (
    <AdminPageShell title={t('admin.bus.title')}>
      <div role="tablist" aria-label={t('admin.bus.tablistLabel')} className="mb-4 flex gap-1">
        <TabButton
          active={tab === 'dlq'}
          onClick={() => setTab('dlq')}
          id="admin-bus-tab-dlq"
          controls="admin-bus-panel-dlq"
        >
          {t('admin.bus.tabs.dlq')}
        </TabButton>
        <TabButton
          active={tab === 'outbox'}
          onClick={() => setTab('outbox')}
          id="admin-bus-tab-outbox"
          controls="admin-bus-panel-outbox"
        >
          {t('admin.bus.tabs.outbox')}
        </TabButton>
      </div>
      {tab === 'dlq' ? (
        <div role="tabpanel" id="admin-bus-panel-dlq" aria-labelledby="admin-bus-tab-dlq">
          <DlqPanel />
        </div>
      ) : (
        <div role="tabpanel" id="admin-bus-panel-outbox" aria-labelledby="admin-bus-tab-outbox">
          <OutboxPanel />
        </div>
      )}
    </AdminPageShell>
  );
}

interface TabButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly id: string;
  readonly controls: string;
  readonly children: ReactNode;
}

function TabButton({ active, onClick, id, controls, children }: TabButtonProps): JSX.Element {
  return (
    <button
      id={id}
      role="tab"
      type="button"
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={
        'rounded-md border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
        (active ? 'bg-muted font-medium' : 'bg-background text-muted-foreground hover:bg-muted')
      }
    >
      {children}
    </button>
  );
}

// ----- DLQ panel (existing behaviour, unchanged) ---------------------------

function DlqPanel(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'error'; readonly errorKey: string }
    | { readonly kind: 'ready'; readonly items: readonly AdminBusDlqRow[] }
  >({ kind: 'loading' });
  const [target, setTarget] = useState<AdminBusDlqRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const items = await listAdminBusDlq();
      setState({ kind: 'ready', items });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleConfirmReplay(): Promise<void> {
    if (target === null || busy) return;
    setBusy(true);
    setReplayError(null);
    try {
      await replayAdminBusDlq(target.outboxId);
      pushToast({ kind: 'success', message: t('admin.bus.dlq.replayed') });
      setTarget(null);
      await refresh();
    } catch (err: unknown) {
      setReplayError(errorKeyOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">{t('admin.bus.dlq.title')}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
          {t('admin.bus.dlq.refresh')}
        </Button>
      </div>
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
      {state.kind === 'ready' && state.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('admin.bus.dlq.empty')}</p>
      ) : null}
      {state.kind === 'ready' && state.items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.bus.dlq.columns.eventType')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.bus.dlq.columns.subscriberKey')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.bus.dlq.columns.attempts')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.bus.dlq.columns.error')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.bus.dlq.columns.failedAt')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.bus.dlq.columns.action')}
                </th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="px-2 py-2 font-mono text-xs">{item.eventType}</td>
                  <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                    {item.subscriberKey}
                  </td>
                  <td className="px-2 py-2 text-xs">{item.attempts}</td>
                  <td className="px-2 py-2 text-xs text-muted-foreground" title={item.error}>
                    {item.error.length > 80 ? `${item.error.slice(0, 80)}…` : item.error}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{item.failedAt}</td>
                  <td className="px-2 py-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setReplayError(null);
                        setTarget(item);
                      }}
                    >
                      {t('admin.bus.dlq.replay')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {target !== null ? (
        <ConfirmDialog
          open
          title={t('admin.bus.dlq.replayConfirm.title')}
          body={t('admin.bus.dlq.replayConfirm.body')}
          confirmLabel={t('admin.bus.dlq.replayConfirm.cta')}
          busy={busy}
          errorKey={replayError}
          onConfirm={() => void handleConfirmReplay()}
          onClose={() => {
            if (busy) return;
            setTarget(null);
            setReplayError(null);
          }}
        />
      ) : null}
    </>
  );
}

// ----- Outbox panel (admin-observability plan §5 phase 5) ------------------

interface OutboxFormState {
  status: '' | AdminBusOutboxStatus;
  type: string;
  from: string;
  to: string;
}

const EMPTY_OUTBOX_FORM: OutboxFormState = {
  status: '',
  type: '',
  from: '',
  to: '',
};

const OUTBOX_STATUSES: readonly AdminBusOutboxStatus[] = [
  'pending',
  'in_flight',
  'delivered',
  'dead',
  'abandoned',
];

type OutboxLoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly rows: readonly AdminBusOutboxRow[];
      readonly nextCursor: string | null;
    };

type DetailState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly id: string }
  | { readonly kind: 'ready'; readonly detail: AdminBusOutboxDetail }
  | { readonly kind: 'error'; readonly id: string; readonly errorKey: string };

function OutboxPanel(): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<OutboxFormState>(EMPTY_OUTBOX_FORM);
  const [appliedFilter, setAppliedFilter] = useState<AdminBusOutboxFilter>({});
  const [state, setState] = useState<OutboxLoadState>({ kind: 'idle' });
  const [detail, setDetail] = useState<DetailState>({ kind: 'closed' });

  const load = useCallback(
    async (filter: AdminBusOutboxFilter, mode: 'replace' | 'append'): Promise<void> => {
      if (mode === 'replace') setState({ kind: 'loading' });
      try {
        const res = await listAdminBusOutbox(filter);
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
      status?: AdminBusOutboxStatus;
      type?: string;
      from?: string;
      to?: string;
    } = {};
    if (form.status !== '') next.status = form.status;
    if (form.type.trim() !== '') next.type = form.type.trim();
    if (form.from.trim() !== '') next.from = form.from.trim();
    if (form.to.trim() !== '') next.to = form.to.trim();
    setAppliedFilter(next);
  }

  function onReset(): void {
    setForm(EMPTY_OUTBOX_FORM);
    setAppliedFilter({});
  }

  function onLoadMore(): void {
    if (state.kind !== 'ready' || state.nextCursor === null) return;
    void load({ ...appliedFilter, cursor: state.nextCursor }, 'append');
  }

  async function openDetail(row: AdminBusOutboxRow): Promise<void> {
    setDetail({ kind: 'loading', id: row.id });
    try {
      const result = await getAdminBusOutboxDetail(row.id);
      setDetail({ kind: 'ready', detail: result });
    } catch (err: unknown) {
      setDetail({ kind: 'error', id: row.id, errorKey: errorKeyOf(err) });
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">{t('admin.bus.outbox.title')}</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void load(appliedFilter, 'replace')}
        >
          {t('admin.bus.outbox.refresh')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('admin.bus.outbox.description')}</p>

      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        aria-label={t('admin.bus.outbox.filters.label')}
        onSubmit={onApply}
        onReset={onReset}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="adminBusOutboxStatus">{t('admin.bus.outbox.filters.status')}</Label>
          <select
            id="adminBusOutboxStatus"
            className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={form.status}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                status: e.target.value === '' ? '' : (e.target.value as AdminBusOutboxStatus),
              }))
            }
          >
            <option value="">{t('admin.bus.outbox.filters.statusAll')}</option>
            {OUTBOX_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`admin.bus.outbox.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="adminBusOutboxType">{t('admin.bus.outbox.filters.type')}</Label>
          <Input
            id="adminBusOutboxType"
            value={form.type}
            placeholder={t('admin.bus.outbox.filters.typePlaceholder')}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="adminBusOutboxFrom">{t('admin.bus.outbox.filters.from')}</Label>
          <Input
            id="adminBusOutboxFrom"
            type="datetime-local"
            value={form.from}
            onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="adminBusOutboxTo">{t('admin.bus.outbox.filters.to')}</Label>
          <Input
            id="adminBusOutboxTo"
            type="datetime-local"
            value={form.to}
            onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
          />
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="reset" variant="ghost" size="sm">
            {t('admin.bus.outbox.filters.reset')}
          </Button>
          <Button type="submit" size="sm">
            {t('admin.bus.outbox.filters.apply')}
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
          <p className="text-sm text-muted-foreground">{t('admin.bus.outbox.empty')}</p>
        ) : null}
        {state.kind === 'ready' && state.rows.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.bus.outbox.columns.occurredAt')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.bus.outbox.columns.type')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.bus.outbox.columns.status')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.bus.outbox.columns.attempt')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      {t('admin.bus.outbox.columns.deliveredAt')}
                    </th>
                    <th scope="col" className="px-2 py-2 font-medium">
                      <span className="sr-only">{t('admin.bus.outbox.columns.actions')}</span>
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
                      <td className="px-2 py-2 text-xs">
                        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                          {t(`admin.bus.outbox.status.${row.status}`, {
                            defaultValue: row.status,
                          })}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-xs">{row.attempt}</td>
                      <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                        {row.deliveredAt ?? '—'}
                      </td>
                      <td className="px-2 py-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void openDetail(row)}
                        >
                          {t('admin.bus.outbox.viewDetail')}
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
                  {t('admin.bus.outbox.loadMore')}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t('admin.bus.outbox.endOfResults')}
                </span>
              )}
            </div>
          </>
        ) : null}
      </div>

      <Dialog
        open={detail.kind !== 'closed'}
        onClose={() => setDetail({ kind: 'closed' })}
        title={
          detail.kind === 'ready'
            ? `${detail.detail.type} · ${detail.detail.occurredAt}`
            : t('admin.bus.outbox.detail.title')
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
        {detail.kind === 'ready' ? <OutboxDetailBody detail={detail.detail} /> : null}
      </Dialog>
    </>
  );
}

function OutboxDetailBody({ detail }: { readonly detail: AdminBusOutboxDetail }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.id')}
          </dt>
          <dd className="font-mono text-xs">{detail.id}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.status')}
          </dt>
          <dd>
            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
              {t(`admin.bus.outbox.status.${detail.status}`, { defaultValue: detail.status })}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.correlationId')}
          </dt>
          <dd className="font-mono text-xs text-muted-foreground">{detail.correlationId ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.flowId')}
          </dt>
          <dd className="font-mono text-xs text-muted-foreground">{detail.flowId ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.deliveredAt')}
          </dt>
          <dd className="font-mono text-xs text-muted-foreground">{detail.deliveredAt ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.attempt')}
          </dt>
          <dd className="text-xs">{detail.attempt}</dd>
        </div>
      </dl>
      {detail.error !== null ? (
        <div>
          <h4 className="text-xs uppercase text-muted-foreground">
            {t('admin.bus.outbox.detail.error')}
          </h4>
          <p className="mt-1 text-sm text-destructive">{detail.error}</p>
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t('admin.bus.outbox.detail.payload')}
          {detail.payloadTruncated ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {t('admin.bus.outbox.detail.truncated', { bytes: detail.payloadOriginalBytes })}
            </span>
          ) : null}
        </summary>
        <pre tabIndex={0} className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
          {detail.payload}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t('admin.bus.outbox.detail.metadata')}
          {detail.metadataTruncated ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {t('admin.bus.outbox.detail.truncated', { bytes: detail.metadataOriginalBytes })}
            </span>
          ) : null}
        </summary>
        <pre tabIndex={0} className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
          {detail.metadata ?? t('admin.bus.outbox.detail.empty')}
        </pre>
      </details>
    </div>
  );
}
