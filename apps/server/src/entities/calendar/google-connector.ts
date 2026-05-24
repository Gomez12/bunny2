import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { CalendarAttendee, CalendarEventPayload } from '@bunny2/shared';
import type {
  ConnectorContext,
  ConnectorEntityInput,
  ConnectorIngestContext,
  ConnectorIngestPayload,
  ConnectorIngestResult,
  ConnectorPullInput,
  EntityConnector,
} from '../connectors/base';
import {
  createSecretsService,
  ENC_ENVELOPE_PREFIX,
  type SecretsService,
} from '../../storage/secrets';
import { createLayerAttachmentsRepo } from '../../repos/layer-attachments-repo';

/**
 * Phase 4c.2 — Google Calendar connector.
 *
 * The first connector to implement BOTH `pull` (per-event refresh by
 * external id, hitting `events.get`) and `ingest` (bulk sync via
 * `events.list`). 4a.2 (KvK) was pull-only; 4b.2 (vCard) was ingest-only.
 * Calendar validates the foundation's claim that the slots compose
 * additively — no contract extension was needed beyond what 4a/4b
 * shipped.
 *
 * Wire layout:
 *  - `id = 'google.calendar'` — stored in
 *    `entity_external_links.connector` and in `layer_attachments.ref_id`
 *    for the per-layer connector attachment.
 *  - `kind = 'calendar_event'` — only entity kind this connector
 *    accepts.
 *  - `verify(config)` — validates the per-layer attachment config:
 *      { clientId, clientSecret (encrypted), refreshToken (encrypted),
 *        calendarId, pollIntervalMinutes, syncToken? }
 *    Encrypted-envelope strings are checked by shape (`enc:v1:...`);
 *    plaintext refresh tokens / client secrets are rejected with
 *    `errors.connectors.google.calendar.plaintextSecret`.
 *  - `pull(ctx, { externalId })` — decrypts the refresh token, exchanges
 *    it for an access token (cached in memory per connector instance),
 *    fetches `events/{externalId}`, projects onto a
 *    `Partial<CalendarEventPayload>`, and hands the patch to
 *    `ctx.onPayloadPatch`. The dispatcher's `persistConnectorPayloadPatch`
 *    runs the same scrub the KvK connector benefits from — meaning the
 *    refresh / access token never reach `entity_external_links.payload_json`.
 *  - `ingest(ctx, { contentType, bytes })` — `application/x-google-calendar-list-request`
 *    triggers a bulk sync. The connector calls `events.list`, maps each
 *    event to `Partial<CalendarEventPayload>` + a `matchKey:
 *    { kind: 'externalId', value: googleEventId }`, and includes the new
 *    `nextSyncToken` in a structured shape the dispatcher persists onto
 *    the attachment.
 *  - `push` — not implemented (v1 is read-only). The interface allows
 *    omitting it; the dispatcher only calls `push` when present.
 *
 * Secrets discipline (defense in depth):
 *  - Refresh + client secrets live in `layer_attachments.config_json`,
 *    encrypted as `enc:v1:` envelopes. The dispatcher resolves the
 *    config blob and passes it through `ctx.config`; this connector
 *    decrypts in memory only.
 *  - Access tokens are held in a per-connector-instance cache. They
 *    never enter the bus, the DB, or the link payload.
 *  - The leak-canary test asserts neither secret string appears in any
 *    captured bus event, any `entity_external_links` row, or any log
 *    capture across a full pull + ingest run.
 */

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_POLL_INTERVAL_MINUTES = 60;
const ACCESS_TOKEN_SKEW_SECONDS = 60;
/**
 * `events.list` window for the bulk-sync ingest path. ±90 days centred
 * on the time of the call captures the dashboard widget's "next 7
 * events" window comfortably. The runner re-runs ingest periodically so
 * the window slides.
 */
const INGEST_TIME_WINDOW_PAST_DAYS = 7;
const INGEST_TIME_WINDOW_FUTURE_DAYS = 90;
const INGEST_MAX_RESULTS = 2500;

export const GOOGLE_CALENDAR_CONNECTOR_ID = 'google.calendar';
export const GOOGLE_CALENDAR_CONNECTOR_KIND = 'calendar_event';

export const GOOGLE_CALENDAR_INGEST_CONTENT_TYPE = 'application/x-google-calendar-list-request';

export const GOOGLE_CALENDAR_ERROR_KEYS = {
  AuthFailed: 'errors.connectors.google.calendar.authFailed',
  Unauthorized: 'errors.connectors.google.calendar.unauthorized',
  RateLimited: 'errors.connectors.google.calendar.rateLimited',
  InvalidConfig: 'errors.connectors.google.calendar.invalidConfig',
  PlaintextSecret: 'errors.connectors.google.calendar.plaintextSecret',
  SyncFailed: 'errors.connectors.google.calendar.syncFailed',
  InvalidContentType: 'errors.connectors.google.calendar.invalidContentType',
  CancelledIgnored: 'errors.connectors.google.calendar.cancelledIgnored',
} as const;

/**
 * Per-layer attachment config. `clientSecret` + `refreshToken` MUST be
 * `enc:v1:...` envelopes (the route handler is expected to encrypt
 * plaintext on receipt — this connector refuses anything else so a
 * misconfiguration fails fast). `syncToken` is non-secret operational
 * state — the connector writes it back after a successful list.
 */
const EnvelopeString = z.string().regex(
  // Cheap shape check: anything starting with `enc:v1:` and at least one
  // base64-shaped segment after. Full decode happens at decrypt time.
  /^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
  { message: 'must be an enc:v1: envelope' },
);

export const GoogleCalendarConfigSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: EnvelopeString,
    refreshToken: EnvelopeString,
    calendarId: z.string().min(1).default('primary'),
    pollIntervalMinutes: z.number().int().min(15).default(DEFAULT_POLL_INTERVAL_MINUTES),
    syncToken: z.string().min(1).optional(),
    /**
     * Stable id of the row in `layer_attachments` this config came from.
     * Set by the dispatcher's resolver (see `createGoogleCalendarConfigResolver`)
     * so `ingest` can write the new `syncToken` back without re-querying
     * by `(layerId, kind, refId)`. Optional because legacy tests that
     * inject `resolveConfig` directly omit it.
     */
    attachmentId: z.string().min(1).optional(),
  })
  .strict();
export type GoogleCalendarConfig = z.infer<typeof GoogleCalendarConfigSchema>;

export interface CreateGoogleCalendarConnectorDeps {
  /** Injected fetch — tests stub it. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Secrets service. Tests inject a stub-key service to drive decrypt
   * without needing `BUNNY2_ENCRYPTION_KEY` on the test env. Production
   * wiring passes the boot singleton.
   */
  readonly secrets: SecretsService;
  /**
   * Clock injection so tests can pin Date.now() for the access-token
   * cache TTL assertions. Defaults to real time.
   */
  readonly now?: () => Date;
}

/** Raw subset of Google's `events.get` / `events.list` item shape we map. */
interface GoogleEvent {
  readonly id?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
  readonly recurrence?: readonly string[];
  readonly attendees?: readonly {
    readonly email?: string;
    readonly displayName?: string;
    readonly responseStatus?: string;
  }[];
  readonly hangoutLink?: string;
  readonly conferenceData?: {
    readonly entryPoints?: readonly { readonly uri?: string }[];
  };
}

interface GoogleListResponse {
  readonly items?: readonly GoogleEvent[];
  readonly nextSyncToken?: string;
  readonly nextPageToken?: string;
}

interface AccessTokenCacheEntry {
  readonly token: string;
  readonly expiresAtMs: number;
}

export function createGoogleCalendarConnector(
  deps: CreateGoogleCalendarConnectorDeps,
): EntityConnector<CalendarEventPayload> {
  const f = deps.fetch ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

  /**
   * Exchange the encrypted refresh token for an access token. The
   * dispatcher's `ctx.config` carries the encrypted envelopes; we
   * decrypt in memory only. Tokens are cached per
   * `${clientId}:${refreshToken}` so repeated `pull` calls during the
   * same poll tick reuse one round-trip.
   */
  async function getAccessToken(cfg: GoogleCalendarConfig): Promise<string> {
    const cacheKey = `${cfg.clientId}:${cfg.refreshToken}`;
    const nowMs = clock().getTime();
    const cached = accessTokenCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAtMs - ACCESS_TOKEN_SKEW_SECONDS * 1000 > nowMs) {
      return cached.token;
    }
    let clientSecret: string;
    let refreshToken: string;
    try {
      clientSecret = deps.secrets.decryptSecret(cfg.clientSecret);
      refreshToken = deps.secrets.decryptSecret(cfg.refreshToken);
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.InvalidConfig);
    }
    const form = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    let res: Response;
    try {
      res = await f(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.AuthFailed);
    }
    if (res.status === 401 || res.status === 400) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.Unauthorized);
    }
    if (!res.ok) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.AuthFailed);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.AuthFailed);
    }
    if (body === null || typeof body !== 'object') {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.AuthFailed);
    }
    const access = (body as Record<string, unknown>)['access_token'];
    const expiresIn = (body as Record<string, unknown>)['expires_in'];
    if (typeof access !== 'string' || access.length === 0) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.AuthFailed);
    }
    const expiresInS = typeof expiresIn === 'number' ? expiresIn : 3600;
    accessTokenCache.set(cacheKey, {
      token: access,
      expiresAtMs: nowMs + expiresInS * 1000,
    });
    return access;
  }

  function mapStatus(googleStatus: string | undefined): CalendarAttendee['status'] {
    switch ((googleStatus ?? '').toLowerCase()) {
      case 'accepted':
        return 'accepted';
      case 'declined':
        return 'declined';
      case 'tentative':
        return 'tentative';
      default:
        return 'needs_action';
    }
  }

  function mapGoogleEvent(event: GoogleEvent, calendarId: string): Partial<CalendarEventPayload> {
    const out: Partial<CalendarEventPayload> = {};
    if (typeof event.summary === 'string') out.summary = event.summary;
    if (typeof event.description === 'string') out.description = event.description;
    if (typeof event.location === 'string') out.location = event.location;
    const startDateTime = event.start?.dateTime;
    const startDate = event.start?.date;
    const allDay = startDateTime === undefined && typeof startDate === 'string';
    if (typeof startDateTime === 'string') out.startsAt = startDateTime;
    else if (typeof startDate === 'string') out.startsAt = startDate;
    const endDateTime = event.end?.dateTime;
    const endDate = event.end?.date;
    if (typeof endDateTime === 'string') out.endsAt = endDateTime;
    else if (typeof endDate === 'string') out.endsAt = endDate;
    out.allDay = allDay;
    if (Array.isArray(event.recurrence) && event.recurrence.length > 0) {
      const first = event.recurrence[0];
      if (typeof first === 'string') out.rruleString = first;
    }
    if (Array.isArray(event.attendees) && event.attendees.length > 0) {
      const seen = new Set<string>();
      const mapped: CalendarAttendee[] = [];
      for (const a of event.attendees) {
        const value = typeof a.email === 'string' ? a.email : undefined;
        if (value === undefined) continue;
        const lower = value.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        const attendee: CalendarAttendee = {
          value,
          ...(typeof a.displayName === 'string' && a.displayName.length > 0
            ? { displayName: a.displayName }
            : {}),
          status: mapStatus(a.responseStatus),
        };
        mapped.push(attendee);
      }
      if (mapped.length > 0) out.attendees = mapped;
    }
    const hangout = event.hangoutLink;
    const entry = event.conferenceData?.entryPoints?.[0]?.uri;
    if (typeof hangout === 'string' && hangout.length > 0) out.conferenceUrl = hangout;
    else if (typeof entry === 'string' && entry.length > 0) out.conferenceUrl = entry;
    out.externalCalendarId = calendarId;
    return out;
  }

  async function pull(ctx: ConnectorContext, input: ConnectorPullInput): Promise<void> {
    const parsed = GoogleCalendarConfigSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.InvalidConfig);
    }
    const cfg = parsed.data;
    const access = await getAccessToken(cfg);
    const url = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(cfg.calendarId)}/events/${encodeURIComponent(input.externalId)}`;
    let res: Response;
    try {
      res = await f(url, {
        headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
      });
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.Unauthorized);
    }
    if (res.status === 429) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.RateLimited);
    }
    if (!res.ok) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    if (body === null || typeof body !== 'object') {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    const patch = mapGoogleEvent(body as GoogleEvent, cfg.calendarId);
    ctx.onPayloadPatch?.({
      externalId: input.externalId,
      patch: patch as Readonly<Record<string, unknown>>,
    });
  }

  async function ingest(
    ctx: ConnectorIngestContext,
    payload: ConnectorIngestPayload,
  ): Promise<ConnectorIngestResult<CalendarEventPayload>> {
    if (payload.contentType !== GOOGLE_CALENDAR_INGEST_CONTENT_TYPE) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.InvalidContentType);
    }
    const parsed = GoogleCalendarConfigSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.InvalidConfig);
    }
    const cfg = parsed.data;
    const access = await getAccessToken(cfg);
    const nowMs = clock().getTime();
    const timeMin = new Date(nowMs - INGEST_TIME_WINDOW_PAST_DAYS * 24 * 3600 * 1000).toISOString();
    const timeMax = new Date(
      nowMs + INGEST_TIME_WINDOW_FUTURE_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const params = new URLSearchParams();
    if (cfg.syncToken !== undefined) {
      // syncToken-mode: timeMin/timeMax/singleEvents/showDeleted CANNOT
      // be set when using syncToken — Google's API rejects them.
      params.set('syncToken', cfg.syncToken);
    } else {
      params.set('singleEvents', 'false');
      params.set('showDeleted', 'true');
      params.set('timeMin', timeMin);
      params.set('timeMax', timeMax);
    }
    params.set('maxResults', String(INGEST_MAX_RESULTS));
    const url = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(cfg.calendarId)}/events?${params.toString()}`;
    let res: Response;
    try {
      res = await f(url, {
        headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
      });
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.Unauthorized);
    }
    if (res.status === 429) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.RateLimited);
    }
    if (res.status === 410) {
      // syncToken expired — Google asks us to re-do a full sync. The
      // connector reports a warning and persists `syncToken: undefined`
      // via the dispatcher.
      const warningsArr = [GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed];
      return { entities: [], warnings: warningsArr };
    }
    if (!res.ok) {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    if (body === null || typeof body !== 'object') {
      throw new Error(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
    }
    const list = body as GoogleListResponse;
    const items = list.items ?? [];
    type EntityItem = ConnectorIngestResult<CalendarEventPayload>['entities'][number];
    const entities: EntityItem[] = [];
    const warnings: string[] = [];
    for (const item of items) {
      if (typeof item.id !== 'string' || item.id.length === 0) continue;
      if ((item.status ?? '').toLowerCase() === 'cancelled') {
        // The ingest path (4b.2) has create + update only — no delete
        // semantics. Surface cancelled events as a warning so an operator
        // sees them; the follow-up
        // `docs/dev/follow-ups/ingest-delete-semantics.md` tracks the
        // proper soft-delete path.
        warnings.push(`${GOOGLE_CALENDAR_ERROR_KEYS.CancelledIgnored}:${item.id}`);
        continue;
      }
      const patch = mapGoogleEvent(item, cfg.calendarId);
      if (patch.startsAt === undefined) {
        // Skip rows that lack a start time — `startsAt` is the only
        // required field in `CalendarEventPayloadSchema`.
        continue;
      }
      const title = item.summary ?? item.id;
      entities.push({
        title,
        payload: patch,
        externalId: item.id,
        matchKey: { kind: 'externalId', value: item.id },
      });
    }
    // Persist the new sync token onto the attachment for the next call.
    // Done as a best-effort write — failures here surface as a warning
    // but DO NOT fail the ingest call.
    if (typeof list.nextSyncToken === 'string' && cfg.attachmentId !== undefined) {
      try {
        const repo = createLayerAttachmentsRepo(ctx.db);
        // Re-load the attachment to avoid clobbering parallel edits
        // (the dispatcher's `resolveConfig` already gave us a snapshot,
        // but a sibling write could have changed `pollIntervalMinutes`).
        const rows = repo.listAttachments(ctx.layerId, 'connector');
        const current = rows.find((r) => r.id === cfg.attachmentId);
        if (current !== undefined) {
          repo.updateAttachmentConfig({
            id: cfg.attachmentId,
            config: { ...current.config, syncToken: list.nextSyncToken },
          });
        }
      } catch {
        warnings.push(GOOGLE_CALENDAR_ERROR_KEYS.SyncFailed);
      }
    }
    return { entities, warnings };
  }

  async function push(
    _ctx: ConnectorContext,
    _entity: ConnectorEntityInput<CalendarEventPayload>,
  ): Promise<void> {
    // v1 is read-only — push is intentionally absent. The interface
    // accepts the omission; the dispatcher checks for presence before
    // invoking. Kept here only for forward symmetry.
  }

  async function verify(config: Readonly<Record<string, unknown>>): Promise<string | null> {
    // Reject plaintext secrets BEFORE zod runs so the operator gets a
    // clear "plaintextSecret" error instead of the generic
    // "invalidConfig". This is the single most security-relevant check
    // the connector makes.
    const cs = (config as Record<string, unknown>)['clientSecret'];
    const rt = (config as Record<string, unknown>)['refreshToken'];
    if (
      (typeof cs === 'string' && cs.length > 0 && !cs.startsWith(ENC_ENVELOPE_PREFIX)) ||
      (typeof rt === 'string' && rt.length > 0 && !rt.startsWith(ENC_ENVELOPE_PREFIX))
    ) {
      return GOOGLE_CALENDAR_ERROR_KEYS.PlaintextSecret;
    }
    const parsed = GoogleCalendarConfigSchema.safeParse(config);
    if (parsed.success) return null;
    return GOOGLE_CALENDAR_ERROR_KEYS.InvalidConfig;
  }

  // `push` is omitted from the returned interface per the `EntityConnector`
  // contract (its `push?` slot is optional). Keeping it as an internal
  // const for forward symmetry only.
  void push;

  return {
    id: GOOGLE_CALENDAR_CONNECTOR_ID,
    kind: GOOGLE_CALENDAR_CONNECTOR_KIND,
    pull,
    ingest,
    verify,
  };
}

/**
 * Helper used by tests + boot wiring to compose a `ConnectorConfigResolver`
 * that injects the row's `attachmentId` into the resolved config blob
 * (so `ingest` knows which row to write `syncToken` back to).
 */
export function createGoogleCalendarConfigResolver(db: Database) {
  const repo = createLayerAttachmentsRepo(db);
  return (input: { readonly layerId: string; readonly connectorId: string }) => {
    if (input.connectorId !== GOOGLE_CALENDAR_CONNECTOR_ID) return null;
    const rows = repo.listAttachments(input.layerId, 'connector');
    const match = rows.find((r) => r.refId === GOOGLE_CALENDAR_CONNECTOR_ID);
    if (match === undefined) return null;
    return { ...match.config, attachmentId: match.id } as Readonly<Record<string, unknown>>;
  };
}

/**
 * Build the production singleton with a lazily-loaded secrets service.
 * Tests use `createGoogleCalendarConnector({ fetch, secrets })` directly.
 */
export function buildProductionGoogleCalendarConnector(): EntityConnector<CalendarEventPayload> {
  return createGoogleCalendarConnector({ secrets: createSecretsService() });
}
