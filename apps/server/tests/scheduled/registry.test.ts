import { afterEach, describe, expect, it } from 'bun:test';
import {
  __resetScheduledTaskRegistryForTests,
  getScheduledTaskHandler,
  listRegisteredScheduledTaskHandlers,
  registerScheduledTaskHandler,
  type ScheduledTaskHandler,
} from '../../src/scheduled/registry';

function noopHandler(
  kind: string,
  defaultSchedule?: ScheduledTaskHandler['defaultSchedule'],
): ScheduledTaskHandler {
  const handler: ScheduledTaskHandler = {
    kind,
    async run() {
      // intentionally empty
    },
  };
  if (defaultSchedule !== undefined) {
    (handler as { defaultSchedule?: ScheduledTaskHandler['defaultSchedule'] }).defaultSchedule =
      defaultSchedule;
  }
  return handler;
}

describe('scheduled-task registry', () => {
  afterEach(() => {
    __resetScheduledTaskRegistryForTests();
  });

  it('returns null for unknown kinds', () => {
    expect(getScheduledTaskHandler('does.not.exist')).toBeNull();
  });

  it('round-trips a handler with kind and optional defaultSchedule', () => {
    const handler = noopHandler('test.handler', { kind: 'interval', intervalMinutes: 10 });
    registerScheduledTaskHandler(handler);
    expect(getScheduledTaskHandler('test.handler')).toBe(handler);
    const list = listRegisteredScheduledTaskHandlers();
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('test.handler');
    expect(list[0]?.defaultSchedule).toEqual({ kind: 'interval', intervalMinutes: 10 });
  });

  it('throws on kind collision (registration is meant to be idempotent across boots, not within one)', () => {
    registerScheduledTaskHandler(noopHandler('dup'));
    expect(() => registerScheduledTaskHandler(noopHandler('dup'))).toThrow(/dup/);
  });

  it('list returns every registered handler in registration order', () => {
    registerScheduledTaskHandler(noopHandler('a'));
    registerScheduledTaskHandler(noopHandler('b'));
    registerScheduledTaskHandler(noopHandler('c'));
    expect(listRegisteredScheduledTaskHandlers().map((h) => h.kind)).toEqual(['a', 'b', 'c']);
  });

  it('omits defaultSchedule on handlers that did not declare one', () => {
    registerScheduledTaskHandler(noopHandler('no-default'));
    const [info] = listRegisteredScheduledTaskHandlers();
    expect(info?.kind).toBe('no-default');
    expect(info?.defaultSchedule).toBeUndefined();
  });
});
