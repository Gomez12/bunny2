export interface BusEvent<TPayload = unknown> {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly payload: TPayload;
}

export interface MessageBus {
  publish<TPayload>(event: BusEvent<TPayload>): Promise<void>;
  subscribe<TPayload>(type: string, handler: (event: BusEvent<TPayload>) => Promise<void>): void;
}
