import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { listRecentWhiteboards, type RecentWhiteboardItem } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import {
  WHITEBOARDS_WIDGET_LIMIT,
  whiteboardsWidgetView,
  type WhiteboardsWidgetInput,
} from './whiteboards-widget-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 11.4 — Whiteboards dashboard widget.
 *
 * Mirrors the shape of `TodosWidget` (4d.4) and `RecentChatsWidget`
 * (6.6): loading / error / empty / ready branches, an `aria-live`
 * announcement on async state, and forward-linking CTAs that resolve
 * once 11.5 mounts the `/l/:slug/whiteboards` list + detail pages.
 *
 * Reads from `GET /l/:slug/whiteboard/_recent?limit=N` — a thin
 * endpoint that wraps the per-kind `whiteboards` table to surface the
 * `thumbnail_blob` column (which the generic §4.0 list endpoint can
 * NOT expose because `EntitySummary` carries payload + audit only).
 * Each row's thumbnail (base64-encoded PNG) renders inline as
 * `<img src="data:image/png;base64,…">`. Until 11.5's PATCH/checkpoint
 * flow lands, every row's blob is `null` — the widget shows the
 * placeholder glyph branch for every row by default.
 *
 * Accessibility:
 *  - Card uses `<section>` semantics via `role="region"` +
 *    `aria-labelledby` to the heading.
 *  - Loading branch sets `role="status" aria-live="polite"`.
 *  - Error branch sets `role="alert"`.
 *  - Each thumbnail image carries an `alt` text derived from the
 *    whiteboard title; the placeholder glyph carries
 *    `aria-hidden="true"` because the title link already names the
 *    row.
 *  - Buttons inherit the shared `<Button>` focus ring.
 */
export function WhiteboardsWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState<WhiteboardsWidgetInput>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setInput({ status: 'loading' });
    listRecentWhiteboards(layerSlug, WHITEBOARDS_WIDGET_LIMIT)
      .then((items: readonly RecentWhiteboardItem[]) => {
        if (cancelled) return;
        setInput({ status: 'ready', items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setInput({ status: 'error', errorKey: errorKeyOf(err) });
      });
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug]);

  const view = whiteboardsWidgetView(input);
  // The 11.5 web UI mounts `/l/:slug/whiteboards` (list) and
  // `/l/:slug/whiteboards/:id` (detail). Linking ahead is intentional
  // per plan §11.4 — until 11.5 ships the links resolve through the
  // App router's 404; the widget never produces a dead link in the
  // loaded-and-ready state because that state implies at least one
  // whiteboard already exists in the layer (the only way to get a row
  // in 11.4 is via the contract suite / direct API call).
  const viewAllHref = `/l/${layerSlug}/whiteboards`;
  const newWhiteboardHref = `/l/${layerSlug}/whiteboards/new`;
  const titleId = `whiteboards-widget-title-${layerSlug}`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('entity.whiteboards.widget.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {view.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('entity.whiteboards.widget.loading')}
          </div>
        ) : null}
        {view.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('entity.whiteboards.widget.error')}
            <span className="sr-only">{` (${view.errorKey})`}</span>
          </div>
        ) : null}
        {view.kind === 'empty' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{t('entity.whiteboards.widget.empty')}</p>
            <Button asChild size="sm" type="button">
              <Link to={newWhiteboardHref}>{t('entity.whiteboards.widget.new')}</Link>
            </Button>
          </div>
        ) : null}
        {view.kind === 'ready' ? (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {view.items.map((wb) => (
                <li key={wb.id} className="flex items-center gap-3 border-b py-1 last:border-0">
                  {wb.thumbnailBlobBase64 === null ? (
                    <div
                      aria-hidden="true"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded border bg-muted text-base text-muted-foreground"
                    >
                      {/* Placeholder glyph (Unicode box-drawing) until 11.5
                          renders real thumbnails. Non-alphabetic so the
                          `i18n:check` JSX-text scanner does not flag it as
                          a hardcoded user-facing string. */}
                      <span>▦</span>
                    </div>
                  ) : (
                    <img
                      src={`data:image/png;base64,${wb.thumbnailBlobBase64}`}
                      alt={wb.title}
                      className="h-10 w-10 shrink-0 rounded border object-cover"
                    />
                  )}
                  <Link
                    to={`/l/${layerSlug}/whiteboards/${wb.slug}`}
                    className="flex-1 truncate font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={wb.title}
                  >
                    {wb.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(wb.updatedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={viewAllHref}>{t('entity.whiteboards.widget.viewAll')}</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={newWhiteboardHref}>{t('entity.whiteboards.widget.new')}</Link>
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Side-effect registration on module evaluation. The dashboard imports
// the barrel `./widgets` once, which imports this file once, which
// performs exactly one registry insertion per process. `order: 800`
// puts the Whiteboards widget after Proposals (`order: 700`).
registerWidget({
  kind: 'whiteboards',
  titleKey: 'entity.whiteboards.widget.title',
  renderer: WhiteboardsWidget,
  order: 800,
});
