import { describe, expect, it } from 'bun:test';
import {
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
  type BusEvent,
  type Middleware,
} from '../src';
import { InMemoryMessageBus } from '../test-utils';

describe('correlationIdMiddleware', () => {
  it('assigns a correlation id when the incoming event has none', async () => {
    const received: BusEvent[] = [];
    const bus = new InMemoryMessageBus({ middlewares: [correlationIdMiddleware] });
    bus.subscribe('demo.corr', (event) => {
      received.push(event);
    });

    await bus.publish({ type: 'demo.corr', payload: null });

    expect(received).toHaveLength(1);
    expect(received[0]?.correlationId).toBeTruthy();
    expect(typeof received[0]?.correlationId).toBe('string');
  });

  it('preserves a caller-supplied correlation id', async () => {
    const received: BusEvent[] = [];
    const bus = new InMemoryMessageBus({ middlewares: [correlationIdMiddleware] });
    bus.subscribe('demo.corr', (event) => {
      received.push(event);
    });

    await bus.publish({
      type: 'demo.corr',
      payload: null,
      correlationId: 'caller-supplied',
    });

    expect(received[0]?.correlationId).toBe('caller-supplied');
  });
});

describe('telemetryMiddleware', () => {
  it('calls the writer once per published event with the full event shape', async () => {
    const written: BusEvent[] = [];
    const bus = new InMemoryMessageBus({
      middlewares: [telemetryMiddleware((e) => void written.push(e))],
    });
    bus.subscribe('demo.tel', () => {
      /* no-op */
    });

    const published = await bus.publish({
      type: 'demo.tel',
      payload: { hello: 'world' },
      flowId: 'flow-1',
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.id).toBe(published.id);
    expect(written[0]?.type).toBe('demo.tel');
    expect(written[0]?.payload).toEqual({ hello: 'world' });
    expect(written[0]?.flowId).toBe('flow-1');
    expect(typeof written[0]?.occurredAt).toBe('string');
  });

  it('writes BEFORE handler dispatch so a thrown handler does not lose the event', async () => {
    const written: BusEvent[] = [];
    const bus = new InMemoryMessageBus({
      middlewares: [
        telemetryMiddleware((e) => void written.push(e)),
        errorCaptureMiddleware(() => {
          /* swallow */
        }),
      ],
      onHandlerError: () => {
        /* swallow */
      },
    });
    bus.subscribe('demo.bad', () => {
      throw new Error('boom');
    });

    await bus.publish({ type: 'demo.bad', payload: null });

    expect(written).toHaveLength(1);
    expect(written[0]?.type).toBe('demo.bad');
  });
});

describe('errorCaptureMiddleware', () => {
  it('logs and swallows errors thrown by inner middleware so publish resolves', async () => {
    const logged: Array<{ error: unknown; type: string }> = [];
    const exploder: Middleware = async () => {
      throw new Error('inner-mw-boom');
    };
    const bus = new InMemoryMessageBus({
      middlewares: [
        errorCaptureMiddleware((error, event) => logged.push({ error, type: event.type })),
        exploder,
      ],
    });
    bus.subscribe('demo.err', () => {
      /* never reached */
    });

    // Must not reject.
    await bus.publish({ type: 'demo.err', payload: null });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.type).toBe('demo.err');
    expect((logged[0]?.error as Error).message).toBe('inner-mw-boom');
  });
});
