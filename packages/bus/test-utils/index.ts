/**
 * Test fixtures for the bus package.
 *
 * The in-memory bus is no longer the production adapter (phase 5.1
 * ships `DurableSqliteMessageBus` from the package main entry as the
 * single production implementation). It still ships here as a
 * lightweight unit-test fixture so suites that don't care about
 * durability can avoid wiring a SQLite DB.
 *
 * Production code MUST NOT import from this entry point — the bus
 * package's main entry deliberately omits the in-memory adapter so
 * `apps/server` cannot accidentally regress to the in-memory bus.
 */

export {
  InMemoryMessageBus,
  type InMemoryMessageBusOptions,
  type HandlerErrorLogger as InMemoryHandlerErrorLogger,
} from '../src/adapters/in-memory';
