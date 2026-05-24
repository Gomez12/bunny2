import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { ConfirmDialog } from '../../components/ui/dialog';
import { listAdminBusDlq, replayAdminBusDlq } from '../../lib/api';
import type { AdminBusDlqRow } from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { pushToast } from '../../lib/toast';

/**
 * Phase 5.6 — `/admin/bus/dlq`.
 *
 * Lists rows the durable bus moved to the dead-letter queue (plan
 * §4.4 — non-recoverable handler failures past `maxAttempts`). Per
 * row, an admin can press Replay → confirm dialog → `POST
 * /admin/bus/dlq/:outboxId/replay`. Successful replay removes the
 * row locally and refetches the list so the admin sees an accurate
 * count.
 *
 * Plan §13 accessibility: the Replay button is a real `<button>`;
 * the confirm dialog reuses `ConfirmDialog` (native `<dialog>`,
 * focus-trap, ESC dismiss inherited from `components/ui/dialog.tsx`).
 *
 * 503 from the server (durable adapter not wired — tests with the
 * in-memory bus path) lands in the row-level error region as
 * `errors.bus.dlqReplayFailed`.
 */
export function AdminBusDlqPage(): JSX.Element {
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
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>{t('admin.bus.dlq.title')}</CardTitle>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
            {t('admin.bus.dlq.refresh')}
          </Button>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

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
    </div>
  );
}
