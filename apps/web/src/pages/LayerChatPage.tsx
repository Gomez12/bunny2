import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog, Dialog } from '../components/ui/dialog';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  createLayerChatConversation,
  deleteLayerChatConversation,
  layerChatMessageStreamPath,
  listLayerChatConversations,
  listLayerChatMessages,
  postLayerChatFeedback,
  regenerateLayerChatConversationTitle,
  type LayerChatConversation,
  type LayerChatFeedbackValue,
  type LayerChatMessage,
} from '../lib/api';
import { trackEvent } from '../lib/analytics';
import { errorKeyOf } from '../lib/errors';
import { sseFetch } from '../lib/sse-fetch';
import { useCurrentLayer } from '../lib/use-current-layer';
import type { PipelineStepStatus } from '@bunny2/shared';
import {
  applyPipelineStepFrame,
  bucketContentLength,
  emptyPipelineStepMap,
  mapServerErrorToChatErrorKey,
  messageElementSelector,
  parseChatDeepLink,
  PIPELINE_STEP_ORDER,
  pipelineStepLabelKey,
  resolveActiveConversationId,
  shouldComposerSubmit,
  splitForAnnouncement,
  type PipelineStepFrame,
  type PipelineStepMap,
} from './layer-chat-page-state';

/**
 * `/l/:layerSlug/chat` — per-layer chat (phase 6.5).
 *
 * Three-pane layout: conversation list (left), thread (center,
 * auto-scrolling), composer (bottom of center). Streaming uses
 * `sseFetch()` (a small `fetch()` + ReadableStream parser) because
 * the browser's native `EventSource` cannot POST, and the
 * phase-6.4 endpoint posts a JSON body.
 *
 * Accessibility notes:
 *  - Streaming assistant bubble's `aria-live="polite"` region is
 *    buffered at sentence boundaries (see
 *    `splitForAnnouncement` in `layer-chat-page-state.ts`) so screen
 *    readers don't read every token chunk.
 *  - Feedback uses real `<button>` elements with `aria-pressed`
 *    reflecting current feedback. Thumbs-down opens a `<dialog>`
 *    (native, focus-trapped) capturing an optional reason.
 *  - Conversation list items are `<button>`s focus-ringed via
 *    `focus-visible:ring-2 focus-visible:ring-ring`.
 *  - Composer textarea has an `sr-only` `<Label>`; Enter submits,
 *    Shift+Enter inserts a newline; the i18n placeholder documents
 *    this for sighted users.
 *
 * Observability:
 *  - Console-only for now. No web-side analytics primitive exists yet
 *    (see follow-up in the 6.5 close-out report). Stream errors and
 *    feedback failures `console.error()` with non-sensitive fields.
 */
export function LayerChatPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;
  const [searchParams] = useSearchParams();
  const { conversationId: deepLinkConversationId, messageId: deepLinkMessageId } =
    parseChatDeepLink(searchParams);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const [conversations, setConversations] = useState<readonly LayerChatConversation[]>([]);
  const [convoLoadError, setConvoLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly LayerChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [streamingBuffer, setStreamingBuffer] = useState('');
  const [announceBuffer, setAnnounceBuffer] = useState('');
  const [streamPending, setStreamPending] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamErrorKey, setStreamErrorKey] = useState<string | null>(null);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStepMap>(() => emptyPipelineStepMap());
  const [composer, setComposer] = useState('');
  const [feedbackByMessage, setFeedbackByMessage] = useState<
    Record<string, LayerChatFeedbackValue>
  >({});
  const [feedbackDialog, setFeedbackDialog] = useState<{ messageId: string } | null>(null);
  const [feedbackReason, setFeedbackReason] = useState('');
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSavedKey, setFeedbackSavedKey] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingConvo, setDeletingConvo] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // ---------- conversation list ------------------------------------------

  const refreshConversations = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    try {
      const list = await listLayerChatConversations(layerSlug);
      setConversations(list);
      setConvoLoadError(null);
      if (activeId === null && list.length > 0) {
        // 6.6 follow-up: honor `?conversation=` deep links from the
        // chat board so a card click lands on the right thread instead
        // of the most-recently-updated conversation. Falls back to
        // `list[0]` when the param is absent or names a conversation
        // the caller cannot see.
        const next = resolveActiveConversationId(list, deepLinkConversationId);
        if (next !== null) setActiveId(next);
      }
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      setConvoLoadError(mapServerErrorToChatErrorKey(key));
      console.error('[chat.page] conversations load failed', { errorKey: key });
    }
  }, [layerSlug, activeId, deepLinkConversationId]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // ---------- thread messages --------------------------------------------

  useEffect(() => {
    if (layerSlug === null || activeId === null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    void (async (): Promise<void> => {
      try {
        const msgs = await listLayerChatMessages(layerSlug, activeId);
        if (!cancelled) {
          setMessages(msgs);
          setStreamErrorKey(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const key = errorKeyOf(err);
          setStreamErrorKey(mapServerErrorToChatErrorKey(key));
          console.error('[chat.page] messages load failed', { errorKey: key, activeId });
        }
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug, activeId]);

  // Auto-scroll to bottom on message / stream changes.
  useEffect(() => {
    const node = threadRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, streamingBuffer]);

  // `?message=:id` deep link — scroll the matching bubble into view,
  // briefly highlight it, and move keyboard focus there for screen
  // readers. No-op when the target id is not in the rendered thread
  // (e.g. wrong conversation, message belongs to a sibling layer).
  useEffect(() => {
    if (deepLinkMessageId === null || messagesLoading) return;
    if (typeof document === 'undefined') return;
    const target = document.querySelector<HTMLElement>(
      messageElementSelector(deepLinkMessageId),
    );
    if (target === null) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // `tabindex="-1"` on the bubble makes the element programmatically
    // focusable so screen readers announce the message on jump.
    target.focus({ preventScroll: true });
    setHighlightedMessageId(deepLinkMessageId);
    const timer = setTimeout(() => setHighlightedMessageId(null), 2000);
    return (): void => clearTimeout(timer);
  }, [deepLinkMessageId, messages, messagesLoading]);

  // Abort any in-flight stream on unmount or layer change.
  useEffect(() => {
    return (): void => {
      abortRef.current?.abort();
    };
  }, []);

  // ---------- new conversation -------------------------------------------

  async function handleNewConversation(): Promise<void> {
    if (layerSlug === null) return;
    try {
      const created = await createLayerChatConversation(layerSlug);
      setConversations((prev) => [created, ...prev]);
      setActiveId(created.id);
      setMessages([]);
      setStreamingBuffer('');
      setAnnounceBuffer('');
      setStreamPending('');
      setStreamErrorKey(null);
      setPipelineSteps(emptyPipelineStepMap());
      trackEvent('chat_conversation_started', { layerSlug });
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      setConvoLoadError(mapServerErrorToChatErrorKey(key));
      console.error('[chat.page] create conversation failed', { errorKey: key });
    }
  }

  // ---------- delete conversation ----------------------------------------

  async function handleConfirmDelete(): Promise<void> {
    if (layerSlug === null || deleteConfirmId === null) return;
    setDeletingConvo(true);
    try {
      await deleteLayerChatConversation(layerSlug, deleteConfirmId);
      setConversations((prev) => prev.filter((c) => c.id !== deleteConfirmId));
      if (activeId === deleteConfirmId) {
        setActiveId(null);
        setMessages([]);
      }
      setDeleteConfirmId(null);
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      setConvoLoadError(mapServerErrorToChatErrorKey(key));
      console.error('[chat.page] delete conversation failed', { errorKey: key });
    } finally {
      setDeletingConvo(false);
    }
  }

  // ---------- regenerate title -------------------------------------------

  const [regenTitleBusyId, setRegenTitleBusyId] = useState<string | null>(null);

  async function handleRegenerateTitle(conversationId: string): Promise<void> {
    if (layerSlug === null || regenTitleBusyId !== null) return;
    setRegenTitleBusyId(conversationId);
    try {
      const updated = await regenerateLayerChatConversationTitle(layerSlug, conversationId);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                title: updated.title,
                updatedAt: updated.updatedAt,
              }
            : c,
        ),
      );
      trackEvent('chat_conversation_title_regenerated', { layerSlug });
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      console.error('[chat.page] regenerate title failed', { errorKey: key });
    } finally {
      setRegenTitleBusyId(null);
    }
  }

  // ---------- send message + stream --------------------------------------

  const handleSend = useCallback(async (): Promise<void> => {
    const trimmed = composer.trim();
    if (trimmed.length === 0 || layerSlug === null || activeId === null || streaming) return;
    const content = trimmed;
    setComposer('');
    setStreamingBuffer('');
    setAnnounceBuffer('');
    setStreamPending('');
    setStreamErrorKey(null);
    setPipelineSteps(emptyPipelineStepMap());
    setStreaming(true);

    // Optimistically render the user's bubble before the server roundtrips.
    const optimisticUser: LayerChatMessage = {
      id: `optimistic-${crypto.randomUUID()}`,
      conversationId: activeId,
      role: 'user',
      content,
      status: 'done',
      model: null,
      tokensIn: null,
      tokensOut: null,
      correlationId: '',
      flowId: '',
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    setMessages((prev) => [...prev, optimisticUser]);

    trackEvent('chat_message_sent', {
      layerSlug,
      conversationId: activeId,
      lengthBucket: bucketContentLength(content),
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let buf = '';
      for await (const frame of sseFetch(layerChatMessageStreamPath(layerSlug, activeId), {
        method: 'POST',
        body: { content },
        signal: controller.signal,
      })) {
        if (frame.event === 'step') {
          try {
            const parsed = JSON.parse(frame.data) as PipelineStepFrame;
            setPipelineSteps((prev) => applyPipelineStepFrame(prev, parsed));
          } catch {
            console.error('[chat.page] bad step frame', { data: frame.data });
          }
        } else if (frame.event === 'token') {
          try {
            const parsed = JSON.parse(frame.data) as { delta: string };
            buf += parsed.delta;
            setStreamingBuffer(buf);
            const { announce, pending } = splitForAnnouncement(buf);
            setAnnounceBuffer(announce);
            setStreamPending(pending);
          } catch {
            console.error('[chat.page] bad token frame', { data: frame.data });
          }
        } else if (frame.event === 'done') {
          // Refresh the canonical messages list so the assistant
          // message carries its real server-issued id (needed for
          // feedback POSTs).
          try {
            const msgs = await listLayerChatMessages(layerSlug, activeId);
            setMessages(msgs);
            setStreamingBuffer('');
            setAnnounceBuffer('');
            setStreamPending('');
          } catch {
            /* fall through — keep optimistic state */
          }
          break;
        } else if (frame.event === 'error') {
          try {
            const parsed = JSON.parse(frame.data) as { message?: string };
            setStreamErrorKey(mapServerErrorToChatErrorKey(parsed.message));
          } catch {
            setStreamErrorKey('chat.errors.upstream');
          }
          // Also re-fetch so any partial assistant message persists.
          try {
            const msgs = await listLayerChatMessages(layerSlug, activeId);
            setMessages(msgs);
            setStreamingBuffer('');
            setAnnounceBuffer('');
            setStreamPending('');
          } catch {
            /* keep optimistic state */
          }
          break;
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        setStreamErrorKey('chat.errors.streamAborted');
        trackEvent('chat_stream_aborted', {
          layerSlug,
          conversationId: activeId,
        });
      } else {
        const key = errorKeyOf(err);
        setStreamErrorKey(mapServerErrorToChatErrorKey(key));
        console.error('[chat.page] stream failed', { errorKey: key });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [activeId, composer, layerSlug, streaming]);

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      shouldComposerSubmit({
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
      })
    ) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleComposerSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void handleSend();
  }

  // ---------- feedback ---------------------------------------------------

  async function sendFeedback(
    messageId: string,
    value: LayerChatFeedbackValue,
    reason?: string,
  ): Promise<void> {
    if (layerSlug === null) return;
    setFeedbackSubmitting(true);
    try {
      await postLayerChatFeedback(layerSlug, messageId, {
        value,
        ...(value === 'down' && reason !== undefined ? { reason } : {}),
      });
      setFeedbackByMessage((prev) => ({ ...prev, [messageId]: value }));
      setFeedbackSavedKey('chat.feedback.saved');
      setFeedbackDialog(null);
      setFeedbackReason('');
      trackEvent('chat_feedback_submitted', { value });
    } catch (err: unknown) {
      const key = errorKeyOf(err);
      console.error('[chat.page] feedback failed', { errorKey: key });
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  async function handleThumbsUp(messageId: string): Promise<void> {
    await sendFeedback(messageId, 'up');
  }

  function openThumbsDown(messageId: string): void {
    setFeedbackDialog({ messageId });
    setFeedbackReason('');
  }

  async function submitThumbsDown(): Promise<void> {
    if (feedbackDialog === null) return;
    const trimmed = feedbackReason.trim();
    await sendFeedback(feedbackDialog.messageId, 'down', trimmed.length > 0 ? trimmed : undefined);
  }

  // ---------- render -----------------------------------------------------

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="p-4 text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      {/* ---------- left pane: conversation list ------------------------ */}
      <aside aria-label={t('chat.conversation.listLabel')} className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('chat.conversation.listLabel')}</h2>
          <Button type="button" size="sm" onClick={() => void handleNewConversation()}>
            {t('chat.conversation.newCta')}
          </Button>
        </div>
        {convoLoadError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {t(convoLoadError, { defaultValue: t('chat.errors.upstream') })}
          </p>
        ) : null}
        {conversations.length === 0 ? (
          <Card>
            <CardContent className="space-y-2 pt-6 text-sm text-muted-foreground">
              <p>{t('chat.empty.noConversations')}</p>
              <p>{t('chat.empty.startWith')}</p>
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => {
              const isActive = c.id === activeId;
              const title = c.title.length > 0 ? c.title : t('chat.conversation.untitled');
              return (
                <li key={c.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={
                      'flex-1 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                      (isActive
                        ? 'border-primary bg-muted'
                        : 'border-input bg-background hover:bg-muted')
                    }
                  >
                    <span className="block truncate font-medium">{title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('chat.conversation.regenerateTitle.cta')}
                    title={t('chat.conversation.regenerateTitle.cta')}
                    disabled={regenTitleBusyId !== null}
                    onClick={() => void handleRegenerateTitle(c.id)}
                  >
                    {regenTitleBusyId === c.id ? '…' : '↻'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('chat.conversation.deleteCta')}
                    onClick={() => setDeleteConfirmId(c.id)}
                  >
                    {'×'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* ---------- center pane: thread + composer --------------------- */}
      <section aria-label={t('chat.thread.label')} className="flex min-h-[60vh] flex-col gap-3">
        <Card className="flex flex-1 flex-col">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle>
              {activeConversation !== null
                ? activeConversation.title.length > 0
                  ? activeConversation.title
                  : t('chat.conversation.untitled')
                : t('chat.conversation.emptyTitle')}
            </CardTitle>
            <Button asChild size="sm" variant="outline" type="button">
              <Link to={`/l/${layerSlug ?? ''}/chat/board`}>{t('chat.board.openCta')}</Link>
            </Button>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <div
              ref={threadRef}
              className="flex-1 space-y-3 overflow-y-auto rounded-md border bg-background p-3"
              role="log"
            >
              {messagesLoading ? (
                <p className="text-sm text-muted-foreground">{t('chat.thread.loading')}</p>
              ) : null}
              {!messagesLoading && messages.length === 0 && !streaming ? (
                <p className="text-sm text-muted-foreground">{t('chat.thread.empty')}</p>
              ) : null}
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  feedbackValue={feedbackByMessage[m.id] ?? null}
                  onUp={() => void handleThumbsUp(m.id)}
                  onDown={() => openThumbsDown(m.id)}
                  feedbackSubmitting={feedbackSubmitting}
                  highlighted={highlightedMessageId === m.id}
                />
              ))}
              {streaming ? (
                <StreamingAssistantBubble
                  buffer={streamingBuffer}
                  announceBuffer={announceBuffer}
                  pendingBuffer={streamPending}
                />
              ) : null}
              {streamErrorKey !== null && !streaming ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(streamErrorKey, { defaultValue: t('chat.errors.upstream') })}
                </p>
              ) : null}
              {feedbackSavedKey !== null ? (
                <p
                  aria-live="polite"
                  className="text-xs text-muted-foreground"
                  onAnimationEnd={() => setFeedbackSavedKey(null)}
                >
                  {t(feedbackSavedKey)}
                </p>
              ) : null}
            </div>

            {streaming ? <PipelineIndicator steps={pipelineSteps} /> : null}

            <form onSubmit={handleComposerSubmit} className="space-y-2">
              <Label htmlFor="chat-composer" className="sr-only">
                {t('chat.composer.label')}
              </Label>
              <Textarea
                id="chat-composer"
                value={composer}
                onChange={(e): void => setComposer(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={t('chat.composer.placeholder')}
                disabled={streaming || activeConversation === null}
                rows={3}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={streaming || activeConversation === null}>
                  {streaming ? t('chat.composer.sendingCta') : t('chat.composer.sendCta')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </section>

      {/* ---------- thumbs-down dialog --------------------------------- */}
      <Dialog
        open={feedbackDialog !== null}
        onClose={(): void => setFeedbackDialog(null)}
        title={t('chat.feedback.dialogTitle')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={(): void => setFeedbackDialog(null)}
              disabled={feedbackSubmitting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={(): void => void submitThumbsDown()}
              disabled={feedbackSubmitting}
            >
              {t('chat.feedback.submit')}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="chat-feedback-reason">{t('chat.feedback.reasonLabel')}</Label>
          <Textarea
            id="chat-feedback-reason"
            value={feedbackReason}
            onChange={(e): void => setFeedbackReason(e.target.value)}
            placeholder={t('chat.feedback.reasonPlaceholder')}
            rows={3}
          />
        </div>
      </Dialog>

      {/* ---------- delete-conversation confirm ------------------------ */}
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={t('chat.conversation.deleteCta')}
        body={t('chat.conversation.deleteConfirm')}
        destructive
        busy={deletingConvo}
        confirmLabel={t('chat.conversation.deleteCta')}
        onConfirm={(): void => void handleConfirmDelete()}
        onClose={(): void => setDeleteConfirmId(null)}
      />
    </div>
  );
}

// ---------- message bubble -----------------------------------------------

interface MessageBubbleProps {
  readonly message: LayerChatMessage;
  readonly feedbackValue: LayerChatFeedbackValue | null;
  readonly onUp: () => void;
  readonly onDown: () => void;
  readonly feedbackSubmitting: boolean;
  readonly highlighted: boolean;
}

function MessageBubble(props: MessageBubbleProps): JSX.Element {
  const { t } = useTranslation();
  const { message, feedbackValue, onUp, onDown, feedbackSubmitting, highlighted } = props;
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  return (
    <article
      data-message-id={message.id}
      tabIndex={-1}
      className={
        'rounded-md border px-3 py-2 text-sm transition-shadow focus-visible:outline-none ' +
        (isUser
          ? 'ml-12 border-primary/30 bg-primary/5'
          : 'mr-12 border-muted-foreground/20 bg-muted') +
        (highlighted ? ' ring-2 ring-primary' : '')
      }
    >
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {isUser ? t('chat.message.userYou') : t('chat.message.assistant')}
        </span>
        {message.status !== 'done' ? (
          <span className="text-xs text-muted-foreground">
            {message.status === 'queued'
              ? t('chat.message.statusQueued')
              : message.status === 'running'
                ? t('chat.message.statusRunning')
                : message.status === 'failed'
                  ? t('chat.message.statusFailed')
                  : t('chat.message.statusDone')}
          </span>
        ) : null}
      </header>
      <p className="whitespace-pre-wrap">{message.content}</p>
      {isAssistant ? (
        <footer className="mt-2 flex gap-1">
          <button
            type="button"
            onClick={onUp}
            disabled={feedbackSubmitting}
            aria-pressed={feedbackValue === 'up'}
            aria-label={t('chat.feedback.upAria')}
            className={
              'inline-flex h-7 items-center rounded-md border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
              (feedbackValue === 'up'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-background hover:bg-muted')
            }
          >
            {t('chat.feedback.upLabel')}
          </button>
          <button
            type="button"
            onClick={onDown}
            disabled={feedbackSubmitting}
            aria-pressed={feedbackValue === 'down'}
            aria-label={t('chat.feedback.downAria')}
            className={
              'inline-flex h-7 items-center rounded-md border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
              (feedbackValue === 'down'
                ? 'border-destructive bg-destructive text-destructive-foreground'
                : 'border-input bg-background hover:bg-muted')
            }
          >
            {t('chat.feedback.downLabel')}
          </button>
        </footer>
      ) : null}
    </article>
  );
}

// ---------- streaming assistant bubble -----------------------------------

interface StreamingAssistantBubbleProps {
  readonly buffer: string;
  readonly announceBuffer: string;
  readonly pendingBuffer: string;
}

function StreamingAssistantBubble(props: StreamingAssistantBubbleProps): JSX.Element {
  const { t } = useTranslation();
  const { buffer, announceBuffer, pendingBuffer } = props;
  return (
    <article className="mr-12 rounded-md border border-muted-foreground/20 bg-muted px-3 py-2 text-sm">
      <header className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('chat.message.assistant')}
        </span>
        <span className="text-xs text-muted-foreground">{t('chat.message.statusRunning')}</span>
      </header>
      {/* Buffered sentence-boundary announcement for screen readers. */}
      <p aria-live="polite" className="sr-only">
        {announceBuffer}
      </p>
      {/* The visible streaming text — pending tail joins the announced
          prefix so sighted users see every token immediately. */}
      <p className="whitespace-pre-wrap" aria-hidden={buffer.length === 0 ? undefined : 'true'}>
        {announceBuffer + pendingBuffer}
      </p>
    </article>
  );
}

// ---------- pipeline indicator -------------------------------------------

interface PipelineIndicatorProps {
  readonly steps: PipelineStepMap;
}

function PipelineIndicator(props: PipelineIndicatorProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('chat.pipeline.title')} className="flex flex-wrap gap-2">
      {PIPELINE_STEP_ORDER.map((kind) => {
        const view = props.steps.get(kind);
        const status: PipelineStepStatus = view?.status ?? 'pending';
        return (
          <li key={kind}>
            <span
              data-step-kind={kind}
              data-step-status={status}
              className={
                'inline-flex h-6 items-center rounded-full border px-2 text-xs ' +
                pipelinePillClass(status)
              }
            >
              {t(pipelineStepLabelKey(kind, status))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function pipelinePillClass(status: PipelineStepStatus): string {
  switch (status) {
    case 'running':
      return 'border-primary bg-primary/10 text-primary';
    case 'succeeded':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'failed':
      return 'border-destructive bg-destructive/10 text-destructive';
    case 'skipped':
      return 'border-muted-foreground/30 bg-muted text-muted-foreground';
    case 'pending':
    default:
      return 'border-input bg-background text-muted-foreground';
  }
}
