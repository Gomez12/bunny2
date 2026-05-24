# Follow-up — Packaged Electron renderer cannot use cookie auth

- Status: open
- Created: 2026-05-24 (uncovered while fixing the "Could not reach the
  server" login regression — see
  `docs/dev/troubleshooting/login-could-not-reach-server.md`)
- Phases referencing it: 1.6 (Electron wrapper), 2.6 (web login),
  2.7 (auth close-out)

## What remains

In packaged Electron the renderer loads from `file://`, which Chromium
turns into the request header `Origin: null`. The dev-mode fix landed
on 2026-05-24:

- `apps/server/src/http/cors.ts` now emits
  `Access-Control-Allow-Credentials: true` for allowed non-null origins.
- `apps/desktop/scripts/dev.ts` points the renderer at
  `http://localhost:4317` so the renderer (`http://localhost:5173`) and
  the API share a SameSite-eligible site.

Neither helps the packaged build. Per the Fetch spec and Chromium's
enforcement, an `Access-Control-Allow-Origin: null` response combined
with `Allow-Credentials: true` is rejected — and even if accepted,
`Origin: null` is unsafe to ever credential (any sandboxed iframe can
present it). The CORS middleware therefore deliberately withholds the
credentials header for the `null` origin (covered by
`apps/server/tests/http-cors.test.ts`).

Consequence: a packaged build cannot rely on the `bunny2_session`
cookie. Today the web client only sends `credentials: 'include'`; it
does not present `Authorization: Bearer <token>`, even though the
server already accepts that transport (see ADR 0008 and
`apps/server/src/http/middleware/auth.ts`).

## Why not done now

The fix today targets the immediate dev-mode failure on `bun run
dev:desktop`. Packaged Electron has not regressed — it was already
broken on the same root cause but no user has hit it because daily
work runs against `dev:desktop`. Bundling the Bearer-transport rework
into the same change would expand scope past a single bugfix.

## Next step

Pick one of:

1. **Bearer in the renderer.** On `POST /auth/login` capture the
   token from the JSON body (the server already returns it for
   exactly this case — see `apps/server/src/http/routes/auth.ts`
   §"Token transport"). Stash it in memory in
   `apps/web/src/lib/api.ts` (NOT localStorage — XSS). Send it as
   `Authorization: Bearer <token>` on every subsequent fetch; stop
   using `credentials: 'include'` in packaged mode (toggle by
   reading `window.bunny2.apiBase`-style hint from the preload, e.g.
   `window.bunny2.transport === 'bearer'`).
2. **Custom scheme.** Register `bunny2://` in `app.whenReady()`, load
   the renderer from there, and have CORS accept that origin. Keeps
   the cookie path symmetric with dev. More moving pieces — preload
   path resolution, packaged asset serving, Windows protocol quirks.

Option 1 is smaller and reuses the existing Bearer code path. Option
2 produces a cleaner long-term story but is a real workstream.

## Related files / docs

- `apps/server/src/http/cors.ts` — the comment block points here.
- `apps/server/tests/http-cors.test.ts` — Origin: null + credentials
  is exercised so a future "just make it work" patch can't quietly
  reintroduce the unsafe combo.
- `apps/server/src/http/routes/auth.ts` — login response already
  emits the token in JSON for non-browser clients; that's the seam
  to consume.
- `apps/web/src/lib/api.ts` — single chokepoint that would need the
  `credentials: 'include'` → Bearer switch.
- `apps/desktop/src/preload.ts` — would expose the transport hint.
- `docs/dev/decisions/0006-http-router-choice.md` §CORS — the
  current note about credentials needs an addendum once this lands.
- `docs/dev/decisions/0008-session-strategy.md` — the cookie/Bearer
  symmetry it promises is true on the server; this follow-up makes
  the client honour it in packaged mode.
