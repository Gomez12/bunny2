import { describe, expect, it } from 'bun:test';
import { InMemoryMessageBus, type BusEvent, type MessageBus, type Middleware } from '../src';

/**
 * Adapter contract. Any `MessageBus` implementation should pass this suite.
 * Currently runs against `InMemoryMessageBus`; add another `runBusContract`
 * call when a second adapter ships.
 */
function runBusContract(name: string, factory: (mws?: readonly Middleware[]) => MessageBus): void {
  describe(`MessageBus contract: ${name}`, () => {
    it('delivers a published event to a subscribed handler', async () => {
      const bus = factory();
      const seen: BusEvent[] = [];
      bus.subscribe('demo.ping', async (event) => {
        seen.push(event);
      });

      const published = await bus.publish({ type: 'demo.ping', payload: { msg: 'hi' } });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.id).toBe(published.id);
      expect(seen[0]?.type).toBe('demo.ping');
      expect(seen[0]?.payload).toEqual({ msg: 'hi' });
      expect(typeof seen[0]?.occurredAt).toBe('string');
    });

    it('assigns id and occurredAt when the caller does not supply them', async () => {
      const bus = factory();
      const received: BusEvent[] = [];
      bus.subscribe('demo.auto', (event) => {
        received.push(event);
      });

      const a = await bus.publish({ type: 'demo.auto', payload: 1 });
      const b = await bus.publish({ type: 'demo.auto', payload: 2 });

      expect(a.id).toBeTruthy();
      expect(b.id).toBeTruthy();
      expect(a.id).not.toBe(b.id);
      expect(received).toHaveLength(2);
    });

    it('delivers to every handler registered for a type', async () => {
      const bus = factory();
      const order: string[] = [];
      bus.subscribe('demo.fan', () => {
        order.push('a');
      });
      bus.subscribe('demo.fan', () => {
        order.push('b');
      });
      bus.subscribe('demo.fan', () => {
        order.push('c');
      });

      await bus.publish({ type: 'demo.fan', payload: null });

      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('isolates events by type so unrelated subscribers do not fire', async () => {
      const bus = factory();
      let aCount = 0;
      let bCount = 0;
      bus.subscribe('demo.a', () => {
        aCount += 1;
      });
      bus.subscribe('demo.b', () => {
        bCount += 1;
      });

      await bus.publish({ type: 'demo.a', payload: null });
      await bus.publish({ type: 'demo.a', payload: null });
      await bus.publish({ type: 'demo.b', payload: null });

      expect(aCount).toBe(2);
      expect(bCount).toBe(1);
    });

    it('stops delivering after unsubscribe', async () => {
      const bus = factory();
      let calls = 0;
      const off = bus.subscribe('demo.off', () => {
        calls += 1;
      });

      await bus.publish({ type: 'demo.off', payload: null });
      off();
      await bus.publish({ type: 'demo.off', payload: null });

      expect(calls).toBe(1);
    });

    it('runs middlewares in declared order, terminating in handler dispatch', async () => {
      const trace: string[] = [];
      const mwA: Middleware = async (event, next) => {
        trace.push('a:before');
        await next(event);
        trace.push('a:after');
      };
      const mwB: Middleware = async (event, next) => {
        trace.push('b:before');
        await next(event);
        trace.push('b:after');
      };
      const bus = factory([mwA, mwB]);
      bus.subscribe('demo.chain', () => {
        trace.push('handler');
      });

      await bus.publish({ type: 'demo.chain', payload: null });

      expect(trace).toEqual(['a:before', 'b:before', 'handler', 'b:after', 'a:after']);
    });

    it('keeps the bus alive when a handler throws', async () => {
      const bus = factory();
      let goodCalls = 0;
      bus.subscribe('demo.bad', () => {
        throw new Error('boom');
      });
      bus.subscribe('demo.bad', () => {
        goodCalls += 1;
      });

      // Should not reject — per-handler isolation in the adapter.
      await bus.publish({ type: 'demo.bad', payload: null });
      await bus.publish({ type: 'demo.bad', payload: null });

      expect(goodCalls).toBe(2);
    });
  });
}

runBusContract(
  'InMemoryMessageBus',
  (mws) =>
    new InMemoryMessageBus({
      middlewares: mws ?? [],
      onHandlerError: () => {
        /* swallow noisy logs in tests */
      },
    }),
);
