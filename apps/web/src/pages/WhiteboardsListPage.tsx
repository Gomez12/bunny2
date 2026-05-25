import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { createWhiteboard, listWhiteboardsWithThumbnails } from '../lib/api';
import type { WhiteboardPayload } from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { formatRelativeTime } from '../lib/relative-time';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  slugifyWhiteboardTitle,
  webWhiteboardPath,
  webWhiteboardsPath,
} from '../lib/whiteboards-routes';
import { whiteboardsListView, type WhiteboardsListInput } from './whiteboards-list-page-state';

/**
 * `/l/:layerSlug/whiteboards` — phase 11.5 whiteboards list.
 *
 * Mirrors the Calendar / Companies / Contacts list pages:
 *  - Loads the layer's whiteboards (via the dedicated
 *    `_list-with-thumbnails` endpoint) and renders them as a vertical
 *    list of cards with a thumbnail, title, "edited Xm ago by Y", and
 *    a link to the detail page.
 *  - Loading / empty / error branches use the `whiteboardsListView`
 *    pure reducer so the same logic is exercised by `bun test`.
 *  - "New" CTA opens an inline mini-form that POSTs an empty
 *    whiteboard (scene with no elements, no files) and navigates to
 *    the detail page on success — the Excalidraw canvas opens
 *    lazy-loaded there.
 *  - Per ADR 0029 the list page MUST NOT import
 *    `@excalidraw/excalidraw` — the bundle weight is reserved for the
 *    detail route only.
 *
 * Accessibility:
 *  - `<main>` heading carries the page title.
 *  - Loading branch sets `role="status" aria-live="polite"`.
 *  - Error branch sets `role="alert"` and offers a Retry button.
 *  - Each row is a `<li>` containing a `<Link>` for the title — the
 *    thumbnail and metadata are inside the link so the entire card is
 *    clickable.
 *  - Placeholder thumbnail glyph has `aria-hidden="true"` (the title
 *    link already names the row).
 */
export function WhiteboardsListPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const [input, setInput] = useState<WhiteboardsListInput>({ status: 'loading' });
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const items = await listWhiteboardsWithThumbnails(layerSlug);
      setInput({ status: 'ready', items });
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    if (layerSlug === null) return;
    const trimmed = createTitle.trim();
    if (trimmed.length === 0) {
      setCreateError('errors.entity.validation');
      return;
    }
    setCreateError(null);
    setCreating(true);
    const slug = slugifyWhiteboardTitle(trimmed);
    const emptyPayload: WhiteboardPayload = {
      scene: { elements: [] },
      files: {},
    };
    try {
      const created = await createWhiteboard(layerSlug, {
        title: trimmed,
        ...(slug.length > 0 ? { slug } : {}),
        originalLocale: i18n.resolvedLanguage ?? 'en',
        payload: emptyPayload,
      });
      navigate(webWhiteboardPath(layerSlug, created.slug));
    } catch (err: unknown) {
      setCreateError(errorKeyOf(err));
    } finally {
      setCreating(false);
    }
  }

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  // After the `current.status === 'ready'` guard, the layer slug is
  // non-null. Re-bind it locally so the JSX below can pass it to URL
  // helpers without a non-null assertion.
  const readySlug = current.layer.slug;
  const view = whiteboardsListView(input);

  return (
    <section aria-labelledby="whiteboards-list-heading" className="space-y-4">
      <header className="flex items-center justify-between gap-4">
        <h1 id="whiteboards-list-heading" className="text-xl font-semibold">
          {t('entity.whiteboards.list.title')}
        </h1>
        <Button
          type="button"
          onClick={() => {
            setCreateOpen((v) => !v);
            setCreateError(null);
          }}
          aria-expanded={createOpen}
        >
          {t('entity.whiteboards.list.new')}
        </Button>
      </header>

      {createOpen ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('entity.whiteboards.list.createTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(ev) => void handleCreate(ev)} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="whiteboard-create-title">
                  {t('entity.whiteboards.list.createTitleLabel')}
                </Label>
                <Input
                  id="whiteboard-create-title"
                  value={createTitle}
                  onChange={(ev) => setCreateTitle(ev.target.value)}
                  autoFocus
                  required
                />
              </div>
              {createError !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(createError)}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={creating}>
                  {creating
                    ? t('entity.whiteboards.list.createPending')
                    : t('entity.whiteboards.list.createCta')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCreateOpen(false);
                    setCreateTitle('');
                    setCreateError(null);
                  }}
                  disabled={creating}
                >
                  {t('entity.whiteboards.list.createCancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {view.kind === 'loading' ? (
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('entity.whiteboards.list.loading')}
        </div>
      ) : null}

      {view.kind === 'error' ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t('entity.whiteboards.list.error')}</p>
          <Button type="button" variant="outline" onClick={() => void refresh()}>
            {t('entity.whiteboards.list.retry')}
          </Button>
        </div>
      ) : null}

      {view.kind === 'empty' ? (
        <p className="text-sm text-muted-foreground">{t('entity.whiteboards.list.empty')}</p>
      ) : null}

      {view.kind === 'ready' ? (
        <ul className="space-y-3">
          {view.items.map((item) => {
            const when = formatRelativeTime(item.updatedAt, {
              locale: i18n.resolvedLanguage ?? 'en',
            });
            const titleText =
              item.title.trim().length > 0 ? item.title : t('entity.whiteboards.list.untitled');
            return (
              <li key={item.id}>
                <Link
                  to={webWhiteboardPath(readySlug, item.slug)}
                  className="block rounded-md border bg-card transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <article className="flex items-stretch gap-4 p-3">
                    <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded border bg-muted">
                      {item.thumbnailBlobBase64 !== null ? (
                        <img
                          src={`data:image/png;base64,${item.thumbnailBlobBase64}`}
                          alt={t('entity.whiteboards.list.thumbnailAlt', { title: titleText })}
                          className="max-h-full max-w-full rounded object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <span aria-hidden="true" className="text-xs text-muted-foreground">
                          {t('entity.whiteboards.list.thumbnailPlaceholder')}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 space-y-1">
                      <p className="font-medium">{titleText}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('entity.whiteboards.list.elementCount', {
                          count: item.elementCount,
                        })}
                      </p>
                      {when !== null ? (
                        <p className="text-xs text-muted-foreground">
                          {t('entity.whiteboards.list.editedAgo', {
                            when,
                            author: item.updatedBy,
                          })}
                        </p>
                      ) : null}
                    </div>
                  </article>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="text-xs text-muted-foreground">
        <Link to={webWhiteboardsPath(readySlug)} className="underline">
          {t('entity.whiteboards.widget.viewAll')}
        </Link>
      </p>
    </section>
  );
}
