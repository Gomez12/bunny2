/**
 * Phase 6.4 — shared test helpers for `/l/:slug/chat/*` route tests.
 *
 * Wraps `makeTestApp` with an injected programmable LLM, seeds the
 * layers + a project layer for the test user, and exposes a small
 * `send`/`stream` helper pair so per-file tests stay focused on
 * assertions.
 */

import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedUserAndSession } from '../_helpers/auth';
import { seedLayersIfNeeded } from '../../src/layers/seed';
import { createProgrammableLlm, type ProgrammableLlmClient } from '../_helpers/programmable-llm';
import { registerCompanyModule } from '../../src/entities/companies';
import { registerContactModule } from '../../src/entities/contacts';
import {
  buildProductionCalendarEventModule,
  registerCalendarEventModule,
} from '../../src/entities/calendar';
import { buildProductionTodoModule, registerTodoModule } from '../../src/entities/todos';

export interface ChatTestFixture {
  readonly app: TestApp;
  readonly llm: ProgrammableLlmClient;
  readonly userId: string;
  readonly token: string;
  readonly otherUserId: string;
  readonly otherToken: string;
  readonly layerSlug: string;
  readonly otherLayerSlug: string;
}

/**
 * Builds a fixture with:
 *  - programmable LLM injected via `makeTestApp({ llmClient })`,
 *  - two users (alice + bob), each with a project layer (`alice-p1`,
 *    `bob-p1`) created via the real `POST /layers` route so the
 *    member rows + visibility edges are set up correctly,
 *  - the four phase-4 entity modules registered (the layer-chat
 *    route's `getEntityStore` adapter needs them at lookup time).
 */
export async function makeChatFixture(prefix = 'bunny2-chat-route-'): Promise<ChatTestFixture> {
  // Entity modules are idempotently registered; safe to call before
  // every fixture build.
  registerCompanyModule();
  registerContactModule();
  registerCalendarEventModule(buildProductionCalendarEventModule());
  registerTodoModule(buildProductionTodoModule());

  const llm = createProgrammableLlm({ defaultModel: 'mock-default' });
  const app = makeTestApp({ prefix, llmClient: llm });

  const { user: alice, token: aliceToken } = seedUserAndSession(app.db, { username: 'alice' });
  const { user: bob, token: bobToken } = seedUserAndSession(app.db, { username: 'bob' });
  await seedLayersIfNeeded({ db: app.db, bus: app.bus, transitiveGroups: app.resolver });

  const layerSlug = 'alice-p1';
  const otherLayerSlug = 'bob-p1';
  await createProjectLayer(app, aliceToken, layerSlug);
  await createProjectLayer(app, bobToken, otherLayerSlug);

  return {
    app,
    llm,
    userId: alice.id,
    token: aliceToken,
    otherUserId: bob.id,
    otherToken: bobToken,
    layerSlug,
    otherLayerSlug,
  };
}

async function createProjectLayer(app: TestApp, token: string, slug: string): Promise<void> {
  const res = await app.app.fetch(
    new Request('http://localhost/layers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type: 'project', slug, name: slug }),
    }),
  );
  if (res.status !== 201) {
    throw new Error(`createProjectLayer ${slug}: ${res.status} ${await res.text()}`);
  }
}

/** Send a JSON request to the chat fixture's app. */
export async function send(
  fx: ChatTestFixture,
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fx.app.app.fetch(
    new Request(`http://localhost${url}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * Reads the SSE response stream into a list of `{ event, data }`
 * frames. Mirrors how an `EventSource`-style consumer would parse
 * the wire format: split on `\n\n`, parse `event:` and `data:`
 * fields per frame.
 *
 * Caller may pass an `abortAfter` callback that decides — given the
 * current frame list — whether to cancel the response stream. The
 * helper returns the frames collected so far in that case.
 */
export async function consumeSse(
  res: Response,
  opts: { readonly abortAfter?: (frames: readonly SseFrame[]) => boolean } = {},
): Promise<readonly SseFrame[]> {
  if (res.body === null) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: SseFrame[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const rawFrame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of rawFrame.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data += (data.length === 0 ? '' : '\n') + line.slice(5).trim();
          }
        }
        if (data.length > 0 || event !== 'message') {
          frames.push({ event, data });
        }
        if (opts.abortAfter?.(frames) === true) {
          await reader.cancel();
          return frames;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return frames;
}
