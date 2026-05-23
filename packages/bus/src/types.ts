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

export interface MessageBus {
  publish<TPayload>(input: PublishInput<TPayload>): Promise<BusEvent<TPayload>>;
  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): Unsubscribe;
}
