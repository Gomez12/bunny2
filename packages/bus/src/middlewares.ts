import type { Middleware } from './middleware';
import type { BusEvent } from './types';

/**
 * Ensures every event carries a `correlationId`. If the incoming event already
 * has one (e.g. set by an HTTP handler that started the flow), it is preserved.
 */
export const correlationIdMiddleware: Middleware = async (event, next) => {
  if (event.correlationId) {
    await next(event);
    return;
  }
  const corr = crypto.randomUUID();
  const enriched: BusEvent = { ...event, correlationId: corr };
  await next(enriched);
};

/**
 * A writer that persists an event to durable storage.
 *
 * Kept as a function type so the bus package never imports `bun:sqlite` or any
 * other DB-specific module. Apps wire a concrete writer (e.g. SQLite) in.
 */
export type TelemetryWriter = (event: BusEvent) => Promise<void> | void;

/**
 * Persists the event before passing control to the rest of the chain.
 *
 * Writing on the way in (before `next()`) means the event log captures the
 * event even if a downstream handler throws. That is what makes the bus
 * "event-sourced" rather than "best-effort".
 */
export function telemetryMiddleware(writer: TelemetryWriter): Middleware {
  return async (event, next) => {
    await writer(event);
    await next(event);
  };
}

export type ErrorLogger = (error: unknown, event: BusEvent) => void;

const defaultErrorLogger: ErrorLogger = (error, event) => {
  // Intentional console.error: the bus has no logger dependency yet.
  console.error(`[bus] handler error on type=${event.type} id=${event.id}:`, error);
};

/**
 * Catches anything thrown by inner middleware or handlers and logs it.
 *
 * Decision: errors are swallowed, NOT rethrown. A bad subscriber must not
 * poison the bus or block other subscribers. The event has already been
 * written to the log by `telemetryMiddleware` (which sits OUTSIDE this one),
 * so failures are observable post-hoc.
 *
 * Place this as the INNERMOST built-in middleware so that the telemetry
 * write succeeds before any handler gets a chance to throw.
 */
export function errorCaptureMiddleware(logger: ErrorLogger = defaultErrorLogger): Middleware {
  return async (event, next) => {
    try {
      await next(event);
    } catch (err) {
      logger(err, event);
    }
  };
}
