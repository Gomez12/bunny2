import { Hono } from 'hono';
import type { AppDeps } from './types';
import { createDevCors } from './cors';
import { mountStatusRoute } from './routes/status';
import { mountChatRoute } from './routes/chat';

/**
 * Builds the HTTP app for `apps/server`.
 *
 * Returns a Hono instance so callers can either:
 *  - Pass `app.fetch` to `Bun.serve({ fetch })` (production).
 *  - Call `app.fetch(new Request(...))` in tests for in-process round-trips
 *    against a real bus, real event log, and a telemetry-wrapped client
 *    (see ADR 0006).
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', createDevCors());
  mountStatusRoute(app, deps);
  mountChatRoute(app, deps);
  return app;
}

export type { AppDeps, StatusBody } from './types';
