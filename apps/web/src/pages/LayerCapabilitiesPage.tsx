/**
 * Phase 7.6 — `/l/:layerSlug/capabilities` page.
 *
 * Lists the per-layer activated tools / skills / agents. The
 * "Deactivate" action is admin-only and confirmed via a small
 * dialog. The mutation calls `capabilityRegistry.deactivate(...)`
 * on the server, which publishes `proposal.deactivated` and detaches
 * the agent subscriber when relevant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { useCurrentLayer } from '../lib/use-current-layer';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import {
  deactivateLayerCapability,
  fetchLayerCapabilities,
  type LayerCapabilityItem,
} from '../lib/api';

interface State {
  readonly status: 'loading' | 'ready' | 'error';
  readonly items: readonly LayerCapabilityItem[];
  readonly errorKey: string | null;
}

export function LayerCapabilitiesPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;
  const canEdit = current.status === 'ready' ? current.canEdit : false;
  const [state, setState] = useState<State>({ status: 'loading', items: [], errorKey: null });
  const [pendingDeactivate, setPendingDeactivate] = useState<LayerCapabilityItem | null>(null);
  const [version, setVersion] = useState(0);

  useMemo(() => {
    if (layerSlug === null) return;
    console.log('[chat.analytics] capabilities_page_opened', { layerSlug });
  }, [layerSlug]);

  useEffect(() => {
    if (layerSlug === null) return;
    let cancelled = false;
    setState({ status: 'loading', items: [], errorKey: null });
    fetchLayerCapabilities(layerSlug)
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', items: res.items, errorKey: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', items: [], errorKey: errorKeyOf(err) });
      });
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug, version]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="p-4 text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }
  const slug = current.layer.slug;
  const titleId = `capabilities-title-${slug}`;

  return (
    <>
      <Card aria-labelledby={titleId} role="region">
        <CardHeader>
          <CardTitle id={titleId}>{t('capabilities.list.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {state.status === 'loading' ? (
            <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </div>
          ) : null}
          {state.status === 'error' ? (
            <div role="alert" className="text-sm text-destructive">
              {t('capabilities.list.errorLoadFailed')}
              <span className="sr-only">{` (${state.errorKey ?? ''})`}</span>
            </div>
          ) : null}
          {state.status === 'ready' && state.items.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm font-medium">{t('capabilities.list.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('capabilities.list.emptyDescription')}
              </p>
            </div>
          ) : null}
          {state.status === 'ready' && state.items.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-4">
                      {t('capabilities.list.nameHeader')}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {t('capabilities.list.kindHeader')}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {t('capabilities.list.originHeader')}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {t('capabilities.list.activatedAtHeader')}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {t('capabilities.list.deactivateCta')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{row.name}</td>
                      <td className="py-2 pr-4">{t(`proposals.kind.${row.kind}`)}</td>
                      <td className="py-2 pr-4">
                        {row.origin === 'builtin'
                          ? t('capabilities.list.originBuiltin')
                          : t('capabilities.list.originProposal')}
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{row.activatedAt}</td>
                      <td className="py-2 pr-4">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDeactivate(row)}
                          disabled={!canEdit}
                          title={!canEdit ? t('proposals.detail.adminOnlyTooltip') : undefined}
                        >
                          {t('capabilities.list.deactivateCta')}
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
      {pendingDeactivate !== null ? (
        <DeactivateDialog
          item={pendingDeactivate}
          layerSlug={slug}
          onClose={() => setPendingDeactivate(null)}
          onDone={() => {
            setPendingDeactivate(null);
            setVersion((v) => v + 1);
          }}
        />
      ) : null}
    </>
  );
}

function DeactivateDialog({
  item,
  layerSlug,
  onClose,
  onDone,
}: {
  readonly item: LayerCapabilityItem;
  readonly layerSlug: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el !== null && !el.open) el.showModal();
    return (): void => {
      if (el !== null && el.open) el.close();
    };
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      await deactivateLayerCapability(layerSlug, item.id);
      console.log('[chat.analytics] capability_deactivated', {
        layerSlug,
        capabilityId: item.id,
      });
      onDone();
    } catch (err) {
      pushToast({ kind: 'error', message: errorKeyOf(err) });
    } finally {
      setBusy(false);
    }
  }, [layerSlug, item.id, onDone]);

  return (
    <dialog
      ref={ref}
      aria-label={t('capabilities.list.deactivateConfirm')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="rounded-md border bg-background p-4 backdrop:bg-black/50"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex w-72 flex-col gap-3"
      >
        <p className="text-sm">{t('capabilities.list.deactivateConfirm')}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('capabilities.list.deactivateCta')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
