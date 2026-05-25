/**
 * Phase 6.5 — pure-logic helpers backing `LayerChatPage.tsx`.
 *
 * The web app has no DOM test runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so the bits of state
 * that would normally be exercised through `@testing-library/react`
 * live here as pure functions that the page calls. The unit tests
 * exercise this module directly, mirroring the
 * `todos-page-state.ts` ↔ `todos-page.test.ts` pattern.
 *
 * Covered:
 *  - Composer key handling — Enter submits, Shift+Enter inserts a
 *    newline.
 *  - Streaming pipeline-step reducer — `step` SSE events fold into a
 *    `Map<PipelineStepKind, PipelineStepView>`.
 *  - Server `event: error` → `chat.errors.*` key mapping.
 *  - Sentence-boundary buffer for the `aria-live="polite"` assistant
 *    bubble (split announcement-ready chunks off the streaming buffer
 *    at `. ! ?` followed by whitespace).
 */

import type { ChatMessage, PipelineStepKind, PipelineStepStatus } from '@bunny2/shared';

// ---------- composer key handling -----------------------------------------

export interface ComposerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
}

/**
 * Returns `true` when the keypress should submit the current composer
 * draft. Mirrors the phase-1 chat page: Enter submits, Shift+Enter
 * (and Cmd/Ctrl+Enter, defensively) does not.
 */
export function shouldComposerSubmit(input: ComposerKeyInput): boolean {
  if (input.key !== 'Enter') return false;
  if (input.shiftKey) return false;
  if (input.metaKey === true) return false;
  if (input.ctrlKey === true) return false;
  return true;
}

// ---------- pipeline-step reducer ----------------------------------------

export const PIPELINE_STEP_ORDER: readonly PipelineStepKind[] = [
  'intent',
  'entities',
  'retrieval',
  'answer',
];

export interface PipelineStepView {
  readonly kind: PipelineStepKind;
  readonly status: PipelineStepStatus;
  readonly attempt: number;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
}

/**
 * SSE `step` event payload, shaped to match the server's
 * `PipelineStepEvent` (see `apps/server/src/chat/pipeline`).
 */
export interface PipelineStepFrame {
  readonly stepKind: PipelineStepKind;
  readonly status: PipelineStepStatus;
  readonly attempt: number;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

export type PipelineStepMap = ReadonlyMap<PipelineStepKind, PipelineStepView>;

export function emptyPipelineStepMap(): PipelineStepMap {
  // Pre-populate so the indicator always has four pills with a stable
  // order even before the first SSE step lands.
  const seed = new Map<PipelineStepKind, PipelineStepView>();
  for (const kind of PIPELINE_STEP_ORDER) {
    seed.set(kind, {
      kind,
      status: 'pending',
      attempt: 1,
      errorCode: null,
      durationMs: null,
    });
  }
  return seed;
}

export function applyPipelineStepFrame(
  prev: PipelineStepMap,
  frame: PipelineStepFrame,
): PipelineStepMap {
  const next = new Map(prev);
  next.set(frame.stepKind, {
    kind: frame.stepKind,
    status: frame.status,
    attempt: frame.attempt,
    errorCode: frame.errorCode ?? null,
    durationMs: frame.durationMs ?? null,
  });
  return next;
}

/**
 * Localised label key for a pipeline-step pill / Kanban-column tag.
 *
 * The 6.5 inline copy mapped `pending → queued` so the i18n schema
 * could stay flat (`chat.pipeline.steps.<kind>.{queued,running,succeeded,failed,skipped}`).
 * 6.6 lifts the mapping here so the per-conversation page AND the
 * Kanban board AND `RecentChatsWidget` all read from one helper. A
 * regression in the i18n map now fails one shared test, not three.
 */
export function pipelineStepLabelKey(kind: PipelineStepKind, status: PipelineStepStatus): string {
  const tail = status === 'pending' ? 'queued' : status;
  return `chat.pipeline.steps.${kind}.${tail}`;
}

// ---------- error key mapping --------------------------------------------

const SERVER_TO_CHAT_ERROR: Readonly<Record<string, string>> = {
  'errors.chat.streamAborted': 'chat.errors.streamAborted',
  'errors.chat.upstream': 'chat.errors.upstream',
  'errors.chat.badRequest': 'chat.errors.validation',
  'errors.chat.notFound': 'chat.errors.validation',
  'errors.chat.feedbackReasonNotAllowed': 'chat.errors.validation',
  'errors.layer.notVisible': 'chat.errors.layerNotVisible',
  'errors.network': 'chat.errors.network',
};

/**
 * Map a server-emitted error key (either from a JSON `error` envelope
 * or an SSE `event: error` `message` field) to the page-local
 * `chat.errors.*` namespace used by the streaming UI. Unknown keys
 * fall back to `chat.errors.upstream` so the user always sees a
 * localised string.
 */
export function mapServerErrorToChatErrorKey(serverKey: string | undefined): string {
  if (serverKey === undefined || serverKey.length === 0) return 'chat.errors.upstream';
  const mapped = SERVER_TO_CHAT_ERROR[serverKey];
  if (mapped !== undefined) return mapped;
  // Defensive — also pass through anything already in the page-local
  // namespace (lets tests assert via either side).
  if (serverKey.startsWith('chat.errors.')) return serverKey;
  return 'chat.errors.upstream';
}

// ---------- sentence-boundary aria-live buffer ---------------------------

/**
 * Split a streaming buffer into ARIA-announceable chunks. Returns the
 * "ready to announce" prefix (split on `. ! ?` followed by whitespace
 * or end-of-string) and the remaining tail that should keep buffering.
 *
 * The page calls this every time a new token chunk lands, appends the
 * `announce` part to the `aria-live="polite"` region, and keeps the
 * `pending` part in a buffer until the next sentence boundary lands.
 */
export interface SentenceSplit {
  readonly announce: string;
  readonly pending: string;
}

export function splitForAnnouncement(buffer: string): SentenceSplit {
  // Find the LAST sentence boundary in the buffer. Everything up to
  // and including it is "announce"; everything after stays "pending".
  // Regex: a `.` `!` or `?`, followed by whitespace or end-of-string.
  const match = /[.!?](?=\s|$)/g;
  let lastIdx = -1;
  for (let m = match.exec(buffer); m !== null; m = match.exec(buffer)) {
    lastIdx = m.index;
  }
  if (lastIdx === -1) {
    return { announce: '', pending: buffer };
  }
  // Include the punctuation char + any trailing whitespace.
  let split = lastIdx + 1;
  while (split < buffer.length && /\s/.test(buffer[split] ?? '')) split += 1;
  return {
    announce: buffer.slice(0, split),
    pending: buffer.slice(split),
  };
}

// ---------- helpers --------------------------------------------------------

/**
 * The thread view sorts messages by `createdAt` ascending. The server
 * already returns them in insertion order; this helper exists so the
 * page can fold a freshly streamed assistant message into the list
 * without re-fetching.
 */
export function appendOrReplaceMessage(
  prev: readonly ChatMessage[],
  next: ChatMessage,
): readonly ChatMessage[] {
  const idx = prev.findIndex((m) => m.id === next.id);
  if (idx === -1) return [...prev, next];
  const out = prev.slice();
  out[idx] = next;
  return out;
}

// ---------- deep-link helpers -------------------------------------------

/**
 * Parsed `?message=:id` deep-link parameter shape used by the chat
 * page. Lives here as a pure helper so the test runtime (which has
 * no DOM) can assert the contract without booting React Router.
 *
 * The board page emits links of the form
 * `/l/<slug>/chat?conversation=<id>&message=<id>`; the page reads
 * `message` and scrolls / focuses the corresponding `<article
 * data-message-id="…">` element after it renders.
 */
export interface ChatDeepLinkParams {
  readonly conversationId: string | null;
  readonly messageId: string | null;
}

export interface SearchParamsLike {
  readonly get: (name: string) => string | null;
}

export function parseChatDeepLink(search: SearchParamsLike): ChatDeepLinkParams {
  const rawMessage = search.get('message');
  const rawConversation = search.get('conversation');
  return {
    conversationId:
      rawConversation === null || rawConversation.length === 0 ? null : rawConversation,
    messageId: rawMessage === null || rawMessage.length === 0 ? null : rawMessage,
  };
}

/**
 * Pure selector: resolves which conversation should be active given a
 * `?conversation=` deep-link param and the currently-loaded list. When
 * the param names a conversation present in the list, that one wins.
 * Otherwise we fall back to the first conversation (the historical
 * default), or `null` when the list is empty.
 */
export function resolveActiveConversationId(
  conversations: readonly { readonly id: string }[],
  deepLinkConversationId: string | null,
): string | null {
  if (deepLinkConversationId !== null) {
    const match = conversations.find((c) => c.id === deepLinkConversationId);
    if (match !== undefined) return match.id;
  }
  const first = conversations[0];
  return first === undefined ? null : first.id;
}

/**
 * DOM selector for a chat-message bubble. Co-located with the parser
 * so the test pins the contract the page renders (`data-message-id`)
 * against the contract the deep-link effect queries.
 */
export function messageElementSelector(messageId: string): string {
  // CSS attribute selectors don't accept the raw id wholesale; use
  // JSON encoding to escape any double quote that might land in an id.
  return `[data-message-id=${JSON.stringify(messageId)}]`;
}

/**
 * Bucket the request body's byte length into a coarse range so an
 * analytics caller (when one ships — phase-6.5 only logs to console,
 * see follow-up) can record message length without sending content.
 */
export function bucketContentLength(content: string): 'xs' | 'sm' | 'md' | 'lg' | 'xl' {
  const n = content.length;
  if (n < 32) return 'xs';
  if (n < 128) return 'sm';
  if (n < 512) return 'md';
  if (n < 2048) return 'lg';
  return 'xl';
}
