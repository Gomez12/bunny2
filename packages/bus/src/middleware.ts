import type { BusEvent } from './types';

export type MiddlewareNext = (event: BusEvent) => Promise<void>;

export type Middleware = (event: BusEvent, next: MiddlewareNext) => Promise<void>;

/**
 * Compose a chain of middlewares around a terminal handler-dispatch step.
 *
 * Execution order is the array order: `[a, b, c]` runs `a` first, then `b`,
 * then `c`, then the terminal `dispatch`. Middlewares are expected to call
 * `next` exactly once with the (possibly modified) event.
 */
export function composeMiddleware(
  middlewares: readonly Middleware[],
  dispatch: MiddlewareNext,
): MiddlewareNext {
  if (middlewares.length === 0) return dispatch;
  return async (event: BusEvent): Promise<void> => {
    let index = -1;
    const run = async (i: number, ev: BusEvent): Promise<void> => {
      if (i <= index) {
        throw new Error('bus middleware called next() more than once');
      }
      index = i;
      const mw = middlewares[i];
      if (!mw) {
        await dispatch(ev);
        return;
      }
      await mw(ev, (nextEvent) => run(i + 1, nextEvent));
    };
    await run(0, event);
  };
}
