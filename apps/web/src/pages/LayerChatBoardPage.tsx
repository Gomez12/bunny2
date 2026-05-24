import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { errorKeyOf } from '../lib/errors';
import { listLayerChatBoard, type LayerChatBoardItem } from '../lib/api';
import { useCurrentLayer } from '../lib/use-current-layer';
import { mapServerErrorToChatErrorKey } from './layer-chat-page-state';
import {
  BOARD_COLUMN_ORDER,
  columnTitleKey,
  groupBoardItemsByColumn,
  jumpToConversationPath,
  startBoardPolling,
  type BoardColumnKind,
} from './layer-chat-board-page-state';

/**
 * `/l/:layerSlug/chat/board` — per-message Kanban (phase 6.6).
 *
 * Mirrors the `TodosKanbanView` shape (`apps/web/src/pages/TodosPage.tsx`):
 *  - One `<section>` per column, in `BOARD_COLUMN_ORDER`.
 *  - Each `<section>` carries an `<h2>` heading with the localised
 *    title + count (plan §9 a11y requirement — the todos template
 *    uses `<header><span>` headings, but the plan explicitly asks
 *    for `<h2>` on the board so screen readers can navigate by
 *    heading level).
 *  - Cards are focusable `<Link>`s; tab order is column-major
 *    (HTML's natural order).
 *  - Empty columns render a localised message.
 *
 * Auto-refresh polls every 5 seconds (`5_000` ms). The poll pauses
 * when `document.hidden === true` (page-visibility API) and resumes
 * on the next `visibilitychange` event. No SSE.
 *
 * Observability:
 *  - Console-only for now (the web side does not have an analytics
 *    primitive yet — see the 6.5 follow-up). Stream / fetch errors
 *    `console.error()` with non-sensitive fields.
 */
export function LayerChatBoardPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const [items, setItems] = useState<readonly LayerChatBoardItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // Track visibility so the poll can pause / resume; we read the
  // ref inside the poller's `isVisible()` callback so a tab switch
  // takes effect on the next tick boundary without recreating the
  // scheduler.
  const visibleRef = useRef<boolean>(typeof document === 'undefined' ? true : !document.hidden);

  const fetchItems = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    try {
      const next = await listLayerChatBoard(layerSlug);
      setItems(next);
      setErrorKey(null);
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      setErrorKey(mapServerErrorToChatErrorKey(key));
      console.error('[chat.board] fetch failed', { errorKey: key });
    } finally {
      setLoaded(true);
    }
  }, [layerSlug]);

  // Mount: start the poll. Cleanup: stop on unmount / layer change.
  useEffect(() => {
    if (layerSlug === null) return undefined;
    const handle = startBoardPolling({
      intervalMs: 5_000,
      isVisible: () => visibleRef.current,
      poll: fetchItems,
    });
    return (): void => handle.stop();
  }, [fetchItems, layerSlug]);

  // Page-visibility listener: flip the ref so the next tick respects
  // it. `visibilitychange` is browser-only; SSR / Electron without a
  // document falls back to always-visible.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = (): void => {
      visibleRef.current = !document.hidden;
    };
    document.addEventListener('visibilitychange', onChange);
    return (): void => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const grouped = useMemo(() => groupBoardItemsByColumn(items), [items]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="p-4 text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('chat.board.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{t('chat.board.description')}</p>
          {errorKey !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {t(errorKey, { defaultValue: t('chat.errors.upstream') })}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {BOARD_COLUMN_ORDER.map((col) => {
          const cards = grouped.get(col) ?? [];
          return (
            <BoardColumn
              key={col}
              column={col}
              cards={cards}
              layerSlug={layerSlug ?? ''}
              loaded={loaded}
            />
          );
        })}
      </div>
    </div>
  );
}

interface BoardColumnProps {
  readonly column: BoardColumnKind;
  readonly cards: readonly LayerChatBoardItem[];
  readonly layerSlug: string;
  readonly loaded: boolean;
}

function BoardColumn(props: BoardColumnProps): JSX.Element {
  const { t } = useTranslation();
  const { column, cards, layerSlug, loaded } = props;
  const headingId = `chat-board-col-${column}-heading`;
  const titleKey = columnTitleKey(column);
  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-md border bg-muted/30 p-2">
      <h2
        id={headingId}
        className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <span>{t(titleKey)}</span>
        <span aria-hidden>{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
          {loaded ? t('chat.board.cardEmpty') : t('common.loading')}
        </p>
      ) : (
        <ul className="space-y-2">
          {cards.map((card) => (
            <li key={card.messageId}>
              <BoardCard card={card} layerSlug={layerSlug} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface BoardCardProps {
  readonly card: LayerChatBoardItem;
  readonly layerSlug: string;
}

function BoardCard(props: BoardCardProps): JSX.Element {
  const { t } = useTranslation();
  const { card, layerSlug } = props;
  const title =
    card.conversationTitle.length > 0 ? card.conversationTitle : t('chat.conversation.untitled');
  const trimmedTitle = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  const preview =
    card.contentPreview.length > 120
      ? `${card.contentPreview.slice(0, 120)}…`
      : card.contentPreview;
  const statusLabelKey = boardCardStatusLabelKey(card);
  return (
    <article className="space-y-1 rounded-md border bg-background p-2">
      <Link
        to={jumpToConversationPath(layerSlug, card.conversationId, card.messageId)}
        aria-label={t('chat.board.jumpToMessage', { defaultValue: 'Open conversation' })}
        className="block font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {trimmedTitle}
      </Link>
      <p className="text-xs text-muted-foreground line-clamp-2">{preview}</p>
      <div className="flex items-center gap-2 pt-1">
        <span
          data-message-status={card.status}
          className="inline-flex h-6 items-center rounded-full border px-2 text-xs"
        >
          {t(statusLabelKey)}
        </span>
        <time className="text-xs text-muted-foreground" dateTime={card.createdAt}>
          {new Date(card.createdAt).toLocaleString()}
        </time>
      </div>
    </article>
  );
}

function boardCardStatusLabelKey(card: LayerChatBoardItem): string {
  switch (card.status) {
    case 'failed':
      return 'chat.message.statusFailed';
    case 'done':
      return 'chat.message.statusDone';
    case 'running':
      return 'chat.message.statusRunning';
    case 'queued':
    default:
      return 'chat.message.statusQueued';
  }
}
