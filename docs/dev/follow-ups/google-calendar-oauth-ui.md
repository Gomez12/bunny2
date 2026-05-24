# Follow-up — Google Calendar OAuth dance UI

- Status: open
- Created: 2026-05-24 (phase 4c.2 close-out)
- Phases referencing it: 4c.2 (gap acknowledged at sub-phase close-out)

## What remains

Phase 4c.2 shipped the Google Calendar connector backend (encryption
helper, connector pull + ingest, dispatcher routing, sync-token
persistence, leak-canary tests). It did NOT ship the layer-attachment
configuration UI.

Today, an operator that wants to wire Google Calendar must:

1. Generate `BUNNY2_ENCRYPTION_KEY` via `openssl rand -base64 32` and
   export it before booting the server.
2. Obtain a refresh token + client id + client secret out-of-band (e.g.
   via Google's OAuth playground).
3. Encrypt the client secret + refresh token using the server's
   `SecretsService` (currently no HTTP wrapper exposed).
4. POST the encrypted envelopes into `layer_attachments` directly via
   the underlying repo or a future settings UI.

## Why not done now

OAuth UX is non-trivial:

- An "Open Google sign-in" button that returns to a callback URL on
  the local server.
- Encrypting the freshly received refresh token before persistence —
  needs an HTTP endpoint that takes plaintext over HTTPS and runs
  `encryptSecret` server-side.
- A "Sync now" button next to the configured attachment that POSTs to
  the ingest endpoint and surfaces the result count.
- Re-auth UX when the refresh token expires.

Bundling this into the 4c.2 commit would have ~doubled its size and
mixed connector backend work with a wholly different UX surface.

## Next step

A 4c.5 (calendar web UI) sub-task picks up:

1. A `LayerSettingsPage` tab section for "Connectors" that lists the
   attached connectors and presents per-connector forms.
2. The Google Calendar form: OAuth start button, callback handler, "Sync
   now" button, status / last-sync display.
3. Server route: `POST /l/:slug/connectors/google.calendar` that takes
   `{ clientId, clientSecret, refreshToken, calendarId,
pollIntervalMinutes }` over TLS, runs `encryptSecret` on the secrets,
   and writes a `layer_attachments` row.

## Related files / docs

- `apps/server/src/entities/calendar/google-connector.ts`
- `apps/server/src/storage/secrets.ts`
- `docs/dev/decisions/0016-google-calendar-connector.md` (§MVP scope)
