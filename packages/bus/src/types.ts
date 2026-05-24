/**
 * A persisted, replayable event passing through the bus.
 *
 * `id` and `occurredAt` are always present once a publish has been accepted
 * by the bus; callers usually hand in a {@link PublishInput} and let the
 * bus assign them.
 */
export interface BusEvent<TPayload = unknown> {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly payload: TPayload;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * What callers may pass to {@link MessageBus.publish}. The bus fills in `id`
 * and `occurredAt` before any middleware runs, so middleware always sees a
 * complete {@link BusEvent}.
 */
export interface PublishInput<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly id?: string;
  readonly occurredAt?: string;
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EventHandler<TPayload = unknown> = (event: BusEvent<TPayload>) => Promise<void> | void;

export type Unsubscribe = () => void;

/**
 * Optional per-subscriber configuration. Both fields are honored only by
 * the durable adapter; the in-memory fixture ignores them.
 *
 * Phase 5.1: the durable adapter uses a single bus-level
 * `subscriberKey` (set at construction time) for offset + DLQ
 * bookkeeping; `subscriberKey` here is reserved for future
 * per-subscriber fan-out and currently ignored. `idempotent` is the
 * bus-level idempotency declaration — when ANY subscriber on the bus
 * declares itself idempotent, the durable adapter replays `in_flight`
 * rows past the lease window on boot rather than abandoning them.
 */
export interface SubscribeOptions {
  /** Stable id used by the durable adapter for offset + DLQ rows. */
  readonly subscriberKey?: string;
  /** Opt in to replay of `in_flight` rows past the lease window. */
  readonly idempotent?: boolean;
}

export interface MessageBus {
  publish<TPayload>(input: PublishInput<TPayload>): Promise<BusEvent<TPayload>>;
  subscribe<TPayload>(
    type: string,
    handler: EventHandler<TPayload>,
    options?: SubscribeOptions,
  ): Unsubscribe;
}
