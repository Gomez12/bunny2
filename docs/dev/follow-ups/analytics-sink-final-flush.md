# Analytics web sink — final-flush on tab close

Status: open.
Filed: 2026-05-25 (close-out of `docs/dev/plans/done/admin-observability-viewer.md`).

## What remains

The web analytics sink
(`apps/web/src/lib/analytics-http-sink.ts`) batches up to 20
events or 5 seconds. When the user closes the tab, the buffered
events are lost — there is no `pagehide` / `beforeunload`
final-flush path that calls `navigator.sendBeacon` (or an
equivalent kept-alive fetch) before the runtime is torn down.

The Phase 6 advisor review flagged this as a small gap. The plan
shipped without it because:

- Most product events emit before the user navigates away (e.g.
  `chat_message_sent` fires the moment the send button is
  clicked, not on tab close).
- Losing the final ~5 seconds of buffered events is acceptable
  for product-flow analytics. It is NOT acceptable for billing
  or audit logs, but this surface is neither.
- The fix needs a paired test that exercises the
  `pagehide` / `beforeunload` event in a DOM-runtime test harness.
  The web app has no component-test runner today (see the open
  `web-component-tests.md` follow-up), so the test would have to
  land elsewhere.

## Why not done now

The implementation is small (~10 lines) but the test path is
disproportionate. The `web-component-tests.md` follow-up gates a
clean fix. Filing the work explicitly so it isn't lost when that
gate clears.

## Next step

When the web component-test runner lands:

1. Add a `pagehide` listener that calls `flush({ beacon: true })`.
2. Implement `beacon: true` by routing through
   `navigator.sendBeacon` with a `Blob` of JSON.
3. Test: simulate `pagehide`, assert the queued events were
   handed to `sendBeacon`, assert nothing was thrown.

## Related files

- `apps/web/src/lib/analytics-http-sink.ts`
- `apps/web/tests/analytics-http-sink.test.ts`
- `docs/dev/follow-ups/web-component-tests.md` (gate)
