# Troubleshooting — Login screen shows "Could not reach the server"

## Symptom

`bun run dev:desktop` boots, the Electron window opens on the sign-in
screen, you enter credentials, click **Sign in**, and the form shows:

> Could not sign in
> Error: Could not reach the server. Please try again.

A `curl http://127.0.0.1:4317/status` from a terminal succeeds, so the
server is up.

## Cause

The renderer is loaded from `http://localhost:5173` (Vite dev). The
API is on `http://127.0.0.1:4317` — different origin. Every fetch in
`apps/web/src/lib/api.ts` is sent with `credentials: 'include'` so the
`bunny2_session` HttpOnly cookie can flow. A cross-origin credentialed
response MUST carry both:

- `Access-Control-Allow-Origin: <reflected>` — was already present.
- `Access-Control-Allow-Credentials: true` — was missing until
  2026-05-24.

Without the credentials header Chromium drops the entire response.
`fetch()` rejects with a `TypeError`, which the client maps to
`errors.network` → the "Could not reach the server" string.

Even after the CORS fix there is a second pitfall: the session cookie
is `SameSite=Lax`, and Chromium treats `localhost` and `127.0.0.1` as
different sites. A Lax cookie set by the server on the `127.0.0.1`
site would not be sent back on subsequent fetches from a renderer on
the `localhost` site, so login would appear to work but `/auth/me`
would return 401 → guest screen.

## Fix (already applied)

1. `apps/server/src/http/cors.ts` emits
   `Access-Control-Allow-Credentials: true` for every allowed non-null
   origin. `Origin: null` (packaged Electron `file://`) is excluded
   on purpose; see
   `docs/dev/follow-ups/packaged-electron-cookie-transport.md`.
2. `apps/desktop/scripts/dev.ts` passes
   `BUNNY2_API_BASE=http://localhost:4317` to Electron so the
   renderer and the API share the `localhost` site (different port
   only — SameSite is computed on scheme + registrable domain, not
   port).
3. `apps/server/tests/http-cors.test.ts` pins the policy.

## Verifying after the fix

From a terminal, with `bun run dev:desktop` running:

```bash
curl -i http://localhost:4317/status -H "Origin: http://localhost:5173" | head
```

You should see both `Access-Control-Allow-Origin: http://localhost:5173`
and `Access-Control-Allow-Credentials: true` in the response headers.
Then sign in through the UI; the dashboard should load and a refresh
should keep you signed in (the cookie now flows on follow-up
requests).

## If you still see the error

- Restart `bun run dev:desktop` after pulling the fix — `bun --watch`
  hot-reloads the server but the Electron renderer caches the
  `apiBase` from preload argv at window creation. A fresh window
  picks up the new value.
- Open DevTools in the Electron window (Cmd+Option+I on macOS) and
  check the Console for a CORS message. If the message mentions
  `Access-Control-Allow-Origin` rather than credentials, the server
  did not pick up the fix — confirm `apps/server/src/http/cors.ts`
  on disk matches `main`.
- If `lsof -i :4317` shows nothing, the sidecar crashed at boot.
  Scroll the terminal that ran `dev:desktop` for the server
  stack trace.
