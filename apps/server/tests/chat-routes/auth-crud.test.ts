/**
 * Phase 6.4 — `/l/:slug/chat/*` auth + CRUD round-trip tests.
 *
 * Pins the security invariants from plan §10:
 *  - Unauthenticated → 401.
 *  - Layer not visible to the user → 404 (`errors.layer.notVisible`).
 *  - Cross-layer conversation id → 404.
 *  - Soft-deleted conversation re-reads → 404.
 *
 * The CRUD round-trip drives the create → list → get → delete →
 * 404 cycle without exercising the SSE route (which has its own
 * suite).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { makeChatFixture, send, type ChatTestFixture } from './_helpers';

let fx: ChatTestFixture | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.app.cleanup();
    fx = null;
  }
});

describe('phase 6.4 — chat HTTP auth + CRUD', () => {
  it('rejects unauthenticated calls with 401', async () => {
    fx = await makeChatFixture('bunny2-chat-auth-');
    const res = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/conversations`, null);
    expect(res.status).toBe(401);
  });

  it('returns 404 errors.layer.notVisible for a layer the user cannot see', async () => {
    fx = await makeChatFixture('bunny2-chat-cross-layer-');
    // alice probes bob's layer
    const res = await send(fx, 'GET', `/l/${fx.otherLayerSlug}/chat/conversations`, fx.token);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('round-trips create → list → get → delete → 404 on next read', async () => {
    fx = await makeChatFixture('bunny2-chat-crud-');
    const createRes = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, fx.token, {
      title: 'CRUD demo',
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      conversation: { id: string; title: string; locale: string };
    };
    expect(created.conversation.title).toBe('CRUD demo');
    const convId = created.conversation.id;

    const listRes = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/conversations`, fx.token);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { conversations: Array<{ id: string }> };
    expect(list.conversations.map((c) => c.id)).toContain(convId);

    const getRes = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${convId}`,
      fx.token,
    );
    expect(getRes.status).toBe(200);

    const delRes = await send(
      fx,
      'DELETE',
      `/l/${fx.layerSlug}/chat/conversations/${convId}`,
      fx.token,
    );
    expect(delRes.status).toBe(200);

    const afterDelRes = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${convId}`,
      fx.token,
    );
    expect(afterDelRes.status).toBe(404);
  });

  it('returns 404 when a different user tries to fetch the conversation', async () => {
    fx = await makeChatFixture('bunny2-chat-cross-user-');
    const createRes = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, fx.token, {
      title: 'private',
    });
    expect(createRes.status).toBe(201);
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    // bob (otherToken) tries to read alice's conversation — even
    // though bob has no membership of alice's layer he should see
    // the layer 404, not a conversation-leak.
    const res = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${conversation.id}`,
      fx.otherToken,
    );
    expect(res.status).toBe(404);
  });
});
