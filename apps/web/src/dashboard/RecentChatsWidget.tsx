import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { listLayerChatConversations, type LayerChatConversation } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { feedbackRatioView, pickRecent, RECENT_CHATS_LIMIT } from './recent-chats-widget-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 6.6 — "Recent chats" dashboard widget.
 *
 * Mirrors the shape of `RecentRunsWidget` (phase 5.6) and the four
 * phase-4 widgets: loading / error / empty / ready branches, an
 * `aria-live` announcement on async state, a CTA that links into
 * the per-layer chat.
 *
 * The thumbs-up / thumbs-down ratio is sourced from the conversation
 * list response (phase 6.6 added aggregate counts to the same
 * payload) — no per-conversation endpoint, no N+1 fetches.
 */

type WidgetState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly conversations: readonly LayerChatConversation[] };

export function RecentChatsWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<WidgetState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    listLayerChatConversations(layerSlug)
      .then((rows) => {
        if (!cancelled) {
          setState({ kind: 'ready', conversations: pickRecent(rows) });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', errorKey: errorKeyOf(err) });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug]);

  const titleId = `recent-chats-title-${layerSlug}`;
  const chatHref = `/l/${layerSlug}/chat`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.recentChats.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.recentChats.loading')}
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.recentChats.errorLoadFailed')}
            <span className="sr-only">{` (${state.errorKey})`}</span>
          </div>
        ) : null}
        {state.kind === 'ready' && state.conversations.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('layer.dashboard.widgets.recentChats.emptyDescription')}
            </p>
            <Button asChild size="sm" type="button">
              <Link to={chatHref}>{t('layer.dashboard.widgets.recentChats.linkOpen')}</Link>
            </Button>
          </div>
        ) : null}
        {state.kind === 'ready' && state.conversations.length > 0 ? (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {state.conversations.map((conv) => {
                const ratio = feedbackRatioView(conv);
                return (
                  <li
                    key={conv.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b py-1 last:border-0"
                  >
                    <Link
                      to={chatHref}
                      className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {conv.title.length > 0 ? conv.title : t('chat.conversation.untitled')}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {new Date(conv.updatedAt).toLocaleString()}
                    </span>
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                      {ratio === null ? '—' : ratio.text}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div>
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={chatHref}>{t('layer.dashboard.widgets.recentChats.linkOpen')}</Link>
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Side-effect registration on module evaluation (same pattern as
// every other dashboard widget). `order: 600` places this widget
// after `recent-runs` (500) — chats trail the system runs in the
// visual order.
registerWidget({
  kind: 'recent-chats',
  titleKey: 'layer.dashboard.widgets.recentChats.title',
  renderer: RecentChatsWidget,
  order: 600,
});

// Hint for the test file — it asserts the constant we trim by.
export { RECENT_CHATS_LIMIT };
