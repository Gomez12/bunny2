# ADR 0006 — HTTP router: Hono on Bun

- Status: accepted
- Date: 2026-05-23
- Phase: 1.5
- Related: `docs/dev/plans/phase-01-system-foundation.md` §4.2 row "1.5", §11.1; `docs/dev/architecture/event-bus.md`.

---

## Context

Phase 1.5 introduces a real HTTP API (`GET /status`, `POST /chat`). The
phase-1 plan §11.1 left the router choice open: Hono on Bun, or a
hand-rolled switch on top of `Bun.serve`. We need:

1. Per-route handlers with method matching, parameter binding, and
   typed JSON responses.
2. Composable middleware (CORS, error handling, request id).
3. **In-process testability** — the chat round-trip test needs to drive
   the full pipeline (parsing, validation, bus publish, LLM call, event
   log persistence) without binding a network port.
4. A small dependency footprint that survives the portable per-OS bundle
   we ship in 1.6.

Two viable options:

- **Hono on Bun.** Tiny TS-first router (~12 kB minified), Bun-native,
  exposes `app.fetch(req)` that runs the pipeline in-process against a
  `Request` and returns a `Response`.
- **Hand-rolled `Bun.serve` switch.** No deps; a `switch (url.pathname)`
  - `if (req.method === ...)` dispatch. Phase 1.4 already had a
    one-route version of this in `apps/server/src/index.ts`.

---

## Decision

**Adopt Hono.** Wire it behind a `createApp(deps)` factory in
`apps/server/src/http/router.ts` that returns the Hono app. `index.ts`
calls `createApp(...)` and passes `app.fetch` to `Bun.serve`.

### Why Hono wins

The load-bearing reason is **test shape**, not middleware ergonomics.
`app.fetch(new Request('http://x/chat', { method: 'POST', body }))` runs
the entire router + validation + handler pipeline in-process. Our chat
round-trip test can therefore:

- Construct a real `InMemoryMessageBus` wired to a real
  `createSqliteEventLog(db)`.
- Construct a real `withTelemetry(mockClient, { log })` against a real
  `createSqliteLlmCallLog(db)`.
- Hit `/chat` with `app.fetch(...)`.
- Assert that one `chat.requested` and one `chat.responded` row land in
  the `events` table, that one row lands in `llm_calls`, and that the
  HTTP response body has the right shape.

That is a far stronger assertion than mocking the bus or the LLM client
would be. A hand-rolled switch can be tested the same way — but we'd
end up reinventing Hono's router to do it (URL parsing, method match,
JSON helpers, error mapping). Hono is small enough that adopting it is
cheaper than reinventing it.

Secondary reasons:

- **Bun-native.** No Node-compat shims, no polyfills. Works against
  `Bun.serve({ fetch: app.fetch })` without translation.
- **TypeScript-first.** Path params and JSON helpers are typed; we can
  combine with zod for body validation without an adapter.
- **Middleware ergonomics.** CORS (see below), request logging, and
  future auth slot in via `app.use(...)` without touching handler code.
- **Bundle size.** Hono is one of the smallest router libs in the
  ecosystem — the portable-build footprint is not a concern.

### Why not hand-rolled

- We'd re-implement URL parsing, method matching, JSON helpers, and
  error-to-Response mapping by hand. Each is small individually, but
  the total cost exceeds Hono and we'd own the maintenance.
- The in-process test pattern still works, but the seam is less clean:
  the hand-rolled `fetch(req)` lives inside `Bun.serve` so we have to
  factor it out to expose it to tests anyway. That refactor is most
  of the way to having a Hono-shaped factory already.

---

## CORS (dev only)

The Vite dev server runs on `:5173` and the Bun server runs on `:4317`.
That is a cross-origin request in dev. In production (phase 1.6) the
Electron renderer loads from `file://` and the server is on
`http://127.0.0.1:<port>`, which is also cross-origin.

**Policy:**

- Allow `Origin: http(s)://localhost(:*)` and `http(s)://127.0.0.1(:*)`.
  Allow `Origin: null` (Electron `file://` becomes `null`).
- Allow methods `GET, POST, OPTIONS`.
- Allow `Content-Type` request header.
- Reject everything else: do not set `Access-Control-Allow-Origin`.

Implemented as a small middleware in `apps/server/src/http/cors.ts` and
mounted on every route in `createApp(deps)`. We do **not** use a
generic `cors: *` because phase 1 is local-only and we want the
explicit allowlist documented; phase 2 (users/auth) will revisit when
remote origins enter the picture.

The CORS rationale belongs in this ADR rather than `i18n.md` (the spec
hint to put it in i18n was wrong); it is a router decision, not a
translation decision.

---

## Consequences

**Positive**

- One small dep (`hono`), Bun-native, TS-first.
- In-process `app.fetch(req)` makes the chat round-trip test exercise
  the **real** bus, event log, telemetry wrapper, and call log — not
  mocks of those.
- Middleware seam is ready for phase 2 (auth) and later (rate-limit,
  request-id propagation across the bus).

**Negative / accepted**

- We adopt a runtime dep before phase 2. Acceptable: it pays for itself
  in test fidelity, and it has no transitive baggage.
- Hono's `c.json()` returns its own typed response builder, so handlers
  are mildly framework-shaped. Acceptable: the framework shape is
  contained to `apps/server/src/http/`; nothing else imports Hono.

---

## Alternatives considered

1. **Hand-rolled `Bun.serve` switch.** Rejected: re-implements Hono's
   router and JSON helpers; the test seam still requires a factory.
2. **Express on Bun.** Rejected: Node-shaped, larger, weaker types,
   not Bun-native.
3. **Elysia.** Considered. Comparable to Hono on size and Bun fit, but
   Hono has a more mature middleware ecosystem and is less opinionated
   about plugin shape. Either would work; we picked Hono on familiarity
   and the in-process `app.fetch(req)` story.

---

## Follow-ups

- Phase 2 introduces auth middleware. Mount it in the same chain.
- Phase 5+ may need rate-limiting and per-route request logging — both
  are pure middleware additions and do not require revisiting this ADR.
