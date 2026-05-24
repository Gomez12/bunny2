import { composeMiddleware, type Middleware, type MiddlewareNext } from '../middleware';
import type {
  BusEvent,
  EventHandler,
  MessageBus,
  PublishInput,
  SubscribeOptions,
  Unsubscribe,
} from '../types';

export type HandlerErrorLogger = (error: unknown, event: BusEvent) => void;

export interface InMemoryMessageBusOptions {
  readonly middlewares?: readonly Middleware[];
  /** Override for tests; defaults to {@link crypto.randomUUID}. */
  readonly idFactory?: () => string;
  /** Override for tests; defaults to ISO string `now`. */
  readonly clock?: () => string;
  /**
   * Invoked when a subscribed handler throws. The bus catches per-handler so
   * a single bad subscriber cannot starve its siblings. Default logs to
   * `console.error`.
   */
  readonly onHandlerError?: HandlerErrorLogger;
}

const defaultHandlerErrorLogger: HandlerErrorLogger = (error, event) => {
  console.error(`[bus] handler error on type=${event.type} id=${event.id}:`, error);
};

/**
 * In-process pub/sub bus. Primary implementation for phase 1.
 *
 * - Handlers run sequentially in registration order so the contract test
 *   stays deterministic and so "middleware chain order" tests don't race.
 * - Each handler is wrapped in its own try/catch — one bad subscriber must
 *   not skip the rest.
 * - `id` and `occurredAt` are assigned at publish entry, BEFORE middleware
 *   runs, so every middleware sees a complete {@link BusEvent}.
 */
export class InMemoryMessageBus implements MessageBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly run: MiddlewareNext;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly onHandlerError: HandlerErrorLogger;

  constructor(opts: InMemoryMessageBusOptions = {}) {
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.onHandlerError = opts.onHandlerError ?? defaultHandlerErrorLogger;
    const middlewares = opts.middlewares ?? [];
    this.run = composeMiddleware(middlewares, (event) => this.dispatch(event));
  }

  async publish<TPayload>(input: PublishInput<TPayload>): Promise<BusEvent<TPayload>> {
    const event: BusEvent<TPayload> = {
      id: input.id ?? this.idFactory(),
      type: input.type,
      occurredAt: input.occurredAt ?? this.clock(),
      payload: input.payload,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    await this.run(event as BusEvent);
    return event;
  }

  subscribe<TPayload>(
    type: string,
    handler: EventHandler<TPayload>,
    _options?: SubscribeOptions,
  ): Unsubscribe {
    // Options are accepted for API symmetry with the durable adapter but
    // ignored here — the in-memory fixture has no offset / DLQ machinery.
    void _options;
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);
    return () => {
      const current = this.handlers.get(type);
      if (!current) return;
      current.delete(handler as EventHandler);
      if (current.size === 0) this.handlers.delete(type);
    };
  }

  private async dispatch(event: BusEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set || set.size === 0) return;
    // Snapshot so a handler unsubscribing mid-loop can't reshuffle the set.
    const snapshot = [...set];
    for (const handler of snapshot) {
      try {
        await handler(event);
      } catch (err) {
        // Per-handler isolation: one bad subscriber must not skip the rest.
        // The outer errorCaptureMiddleware (if installed) never sees this
        // because we don't rethrow; that middleware is the safety net for
        // failures that originate INSIDE the middleware chain itself.
        this.onHandlerError(err, event);
      }
    }
  }
}
