import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { trackEvent } from '../lib/analytics';
import { addEntityExternalLink, removeEntityExternalLink } from '../lib/api';
import type { EntityExternalLink } from '../lib/api-types';
import {
  externalLinkI18nKeysForKind,
  externalLinkTelemetryName,
  linkSyncStateBadgeKey,
  type ExternalLinkEntityKind,
} from '../lib/entity-external-links';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';

/**
 * Phase 3 (ui-exposure-gaps) — shared external-link CRUD block for the
 * four non-Company detail pages (`contact`, `calendar_event`, `todo`,
 * `whiteboard`).
 *
 * Reused from the Companies external-link block in
 * `CompanyDetailPage.tsx` per the plan §5 phase 3 instructions:
 *   - Each kind keeps its own i18n namespace (`entity.<ns>.externalLinks.*`)
 *     so callers can swap or remove individual kinds cleanly.
 *   - Telemetry surfaces a placeholder `[entity.<kind>.external-link.add]`
 *     / `.remove` console log next to the analytics emit; the web bundle
 *     has no real telemetry sink yet — see `restoreTelemetryName` in
 *     `entity-restore.ts` for the matching Phase 1 pattern.
 *   - Analytics emits `entity_external_link_added` /
 *     `entity_external_link_removed` with `{ kind, layerSlug }` only.
 *     No URL / external-id content per plan §13 + §10 privacy rules.
 *
 * Companies is intentionally NOT migrated onto this component as part
 * of THIS plan (non-goal §2). The duplication is tracked in
 * `docs/dev/follow-ups/shared-entity-external-links-component.md`.
 *
 * Connector-ingest coexistence (plan §14): the matching connectors
 * (vCard for contacts, Google Calendar for events, the whiteboard
 * enrichment subscriber) may write external-link rows from upstream.
 * The Companies-side block already coexists with KvK ingest by letting
 * the user delete any link; this component mirrors that — every link
 * is removable from the UI. A future per-kind "ingest-owned read-only"
 * variant can be added without changing this component's shape (the
 * follow-up doc notes the option).
 *
 * Accessibility:
 *  - The card title is a single `<h3>` via shadcn `<CardTitle>`.
 *  - The add form uses `<Label htmlFor>` on every input.
 *  - Errors render with `role="alert" aria-live="polite"`.
 *  - Destructive remove uses the shadcn `destructive` variant; disabled
 *    while pending so the button cannot fire twice.
 */
interface EntityExternalLinksProps {
  readonly kind: ExternalLinkEntityKind;
  readonly layerSlug: string;
  readonly entitySlug: string;
  readonly links: readonly EntityExternalLink[];
  readonly onChanged: () => void | Promise<void>;
}

export function EntityExternalLinks(props: EntityExternalLinksProps): JSX.Element {
  const { t } = useTranslation();
  const keys = externalLinkI18nKeysForKind(props.kind);

  const [connectorDraft, setConnectorDraft] = useState('');
  const [externalIdDraft, setExternalIdDraft] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removePendingId, setRemovePendingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Stable element id prefix per kind so multiple instances on the same
  // page (none today, but cheap to guard) get unique label associations.
  const idPrefix = `ext-link-${props.kind}`;
  const connectorInputId = `${idPrefix}-connector`;
  const externalIdInputId = `${idPrefix}-externalId`;

  async function handleAdd(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (addPending) return;
    setAddError(null);
    setRemoveError(null);
    const connector = connectorDraft.trim();
    const externalId = externalIdDraft.trim();
    if (connector.length === 0) {
      setAddError(keys.connectorRequired);
      return;
    }
    if (externalId.length === 0) {
      setAddError(keys.externalIdRequired);
      return;
    }
    setAddPending(true);
    const startedAt = Date.now();
    const telemetry = externalLinkTelemetryName(props.kind, 'add');
    try {
      await addEntityExternalLink(props.layerSlug, props.kind, props.entitySlug, {
        connector,
        externalId,
      });
      // Placeholder telemetry surface — see `restoreTelemetryName` in
      // `entity-restore.ts` and `docs/dev/observability/telemetry.md`.
      console.log(`[${telemetry}]`, { success: true, latencyMs: Date.now() - startedAt });
      trackEvent('entity_external_link_added', {
        kind: props.kind,
        layerSlug: props.layerSlug,
      });
      setConnectorDraft('');
      setExternalIdDraft('');
      pushToast({ kind: 'success', message: t(keys.added) });
      await props.onChanged();
    } catch (err: unknown) {
      console.log(`[${telemetry}]`, { success: false, latencyMs: Date.now() - startedAt });
      setAddError(errorKeyOf(err));
    } finally {
      setAddPending(false);
    }
  }

  async function handleRemove(linkId: string): Promise<void> {
    if (removePendingId !== null) return;
    setRemovePendingId(linkId);
    setRemoveError(null);
    const startedAt = Date.now();
    const telemetry = externalLinkTelemetryName(props.kind, 'remove');
    try {
      await removeEntityExternalLink(props.layerSlug, props.kind, props.entitySlug, linkId);
      console.log(`[${telemetry}]`, { success: true, latencyMs: Date.now() - startedAt });
      trackEvent('entity_external_link_removed', {
        kind: props.kind,
        layerSlug: props.layerSlug,
      });
      pushToast({ kind: 'success', message: t(keys.removed) });
      await props.onChanged();
    } catch (err: unknown) {
      console.log(`[${telemetry}]`, { success: false, latencyMs: Date.now() - startedAt });
      setRemoveError(errorKeyOf(err));
    } finally {
      setRemovePendingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(keys.title)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(keys.empty)}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {props.links.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {t(keys.connectorLabel, {
                      connector: link.connector,
                      externalId: link.externalId,
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(linkSyncStateBadgeKey(props.kind, link.syncState))}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void props.onChanged()}
                    disabled={removePendingId !== null}
                  >
                    {t(keys.refresh)}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => void handleRemove(link.id)}
                    disabled={removePendingId === link.id}
                  >
                    {t(keys.remove)}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {removeError !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(removeError, { defaultValue: t(keys.removeFailed) })}
          </p>
        ) : null}

        <form onSubmit={(e) => void handleAdd(e)} className="space-y-2" noValidate>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={connectorInputId}>{t(keys.connectorField)}</Label>
              <Input
                id={connectorInputId}
                value={connectorDraft}
                onChange={(e) => setConnectorDraft(e.target.value)}
                disabled={addPending}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={externalIdInputId}>{t(keys.externalIdField)}</Label>
              <Input
                id={externalIdInputId}
                value={externalIdDraft}
                onChange={(e) => setExternalIdDraft(e.target.value)}
                disabled={addPending}
                autoComplete="off"
              />
            </div>
          </div>
          <Button type="submit" disabled={addPending}>
            {t(keys.addCta)}
          </Button>
          {addError !== null ? (
            <p role="alert" aria-live="polite" className="text-sm text-destructive">
              {t(addError, { defaultValue: t(keys.addFailed) })}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
