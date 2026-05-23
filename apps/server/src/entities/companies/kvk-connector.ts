import { z } from 'zod';
import type { CompanyPayload } from '@bunny2/shared';
import type {
  ConnectorContext,
  ConnectorEntityInput,
  ConnectorPullInput,
  EntityConnector,
} from '../connectors/base';

/**
 * Phase 4a.2 — KvK Basisprofiel connector.
 *
 * Fetches a Dutch Chamber of Commerce profile (kvk.nl Basisprofiel) by
 * KvK number and projects the response onto a `CompanyPayload` partial
 * (legalName, tradeName, kvkNumber, website, industry, address). The
 * connector is READ-ONLY — `push` is a no-op success — because KvK
 * does not expose a write API.
 *
 * Wire layout:
 *  - `id = 'kvk'` — the value stored in `entity_external_links.connector`
 *    and `layer_attachments.ref_id` for connector-kind rows.
 *  - `kind = 'company'` — the only entity kind this connector accepts.
 *  - `verify(config)` runs the strict `KvkConfigSchema` (apiKey,
 *    endpoint?, pollIntervalMinutes?) at attachment time and rejects
 *    unknown fields. Returns a stable error key string on failure;
 *    null on success.
 *  - `pull(ctx, { externalId })`:
 *      1. fetch Basisprofiel via the injected `fetch` (tests stub it).
 *      2. map the response onto a `CompanyPayload` partial.
 *      3. The dispatcher (not the connector) updates
 *         `sync_state` via `markSucceeded` / `markFailed`. The
 *         connector only signals errors by throwing an Error whose
 *         message is the i18n key the dispatcher should persist.
 *
 * Secrets discipline (see `docs/dev/decisions/0012-kvk-connector.md`):
 *  - `apiKey` is consumed via `ctx.config.apiKey` set by the
 *    dispatcher from the per-layer `layer_attachments` row.
 *  - The connector NEVER copies `apiKey` into the bus event payload
 *    (it can't — events go through the dispatcher's `markSucceeded` /
 *    `markFailed` helpers, which don't take a payload arg).
 *  - The connector NEVER copies `apiKey` into
 *    `entity_external_links.payload_json` either — `pull` does not
 *    update the link payload.
 */

const DEFAULT_ENDPOINT = 'https://api.kvk.nl/api/v1/basisprofielen';
const DEFAULT_POLL_INTERVAL_MINUTES = 1440;

export const KvkConfigSchema = z
  .object({
    apiKey: z.string().min(1, 'apiKey is required'),
    endpoint: z.string().url().optional(),
    pollIntervalMinutes: z
      .number()
      .int()
      .min(60, 'pollIntervalMinutes must be >= 60')
      .default(DEFAULT_POLL_INTERVAL_MINUTES),
  })
  .strict();
export type KvkConfig = z.infer<typeof KvkConfigSchema>;

/**
 * Errors thrown by `pull(...)` are propagated to the dispatcher as
 * Error.message — the dispatcher only forwards them when they start
 * with `errors.`, so use exactly these keys.
 */
export const KVK_ERROR_KEYS = {
  Unauthorized: 'errors.connectors.kvk.kvkUnauthorized',
  NotFound: 'errors.connectors.kvk.kvkNotFound',
  Unreachable: 'errors.connectors.kvk.kvkUnreachable',
  InvalidResponse: 'errors.connectors.kvk.kvkInvalidResponse',
} as const;

export const KVK_CONNECTOR_ID = 'kvk';
export const KVK_CONNECTOR_KIND = 'company';

/**
 * Subset of the Basisprofiel response we project onto `CompanyPayload`.
 * KvK returns a deeply nested envelope; the fields below are the
 * stable ones documented at <https://developers.kvk.nl/>.
 */
interface BasisprofielResponse {
  readonly kvkNummer?: string;
  readonly handelsnaam?: string;
  readonly statutaireNaam?: string;
  readonly _embedded?: {
    readonly hoofdvestiging?: {
      readonly websites?: readonly string[];
      readonly sbiActiviteiten?: readonly {
        readonly sbiOmschrijving?: string;
      }[];
      readonly adressen?: readonly {
        readonly type?: string;
        readonly straatnaam?: string;
        readonly huisnummer?: number | string;
        readonly huisnummerToevoeging?: string;
        readonly postcode?: string;
        readonly plaats?: string;
        readonly land?: string;
      }[];
    };
  };
}

export interface CreateKvkConnectorDeps {
  /** Injected `fetch` — tests pass a stub. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /**
   * Hook invoked whenever `pull` produces a payload patch. Tests use
   * this to assert mapping; production wiring leaves it unset (the
   * connector's job in 4a.2 is to read; 4a.3 ships the AI-enrichment
   * writer that consumes these patches).
   */
  readonly onPayloadPatch?: (input: {
    readonly externalId: string;
    readonly patch: Partial<CompanyPayload>;
  }) => void;
}

export function createKvkConnector(
  deps: CreateKvkConnectorDeps = {},
): EntityConnector<CompanyPayload> {
  const f = deps.fetch ?? fetch;

  async function pull(ctx: ConnectorContext, input: ConnectorPullInput): Promise<void> {
    const parsed = KvkConfigSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(KVK_ERROR_KEYS.Unauthorized);
    }
    const cfg = parsed.data;
    const url = `${cfg.endpoint ?? DEFAULT_ENDPOINT}/${encodeURIComponent(input.externalId)}`;
    let res: Response;
    try {
      res = await f(url, {
        headers: { apikey: cfg.apiKey, accept: 'application/json' },
      });
    } catch {
      // Network / DNS / TLS — bucketed as "unreachable" so the UI
      // shows a retry hint instead of an auth-failed message.
      throw new Error(KVK_ERROR_KEYS.Unreachable);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(KVK_ERROR_KEYS.Unauthorized);
    }
    if (res.status === 404) {
      throw new Error(KVK_ERROR_KEYS.NotFound);
    }
    if (!res.ok) {
      throw new Error(KVK_ERROR_KEYS.Unreachable);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(KVK_ERROR_KEYS.InvalidResponse);
    }
    if (body === null || typeof body !== 'object') {
      throw new Error(KVK_ERROR_KEYS.InvalidResponse);
    }
    const patch = mapBasisprofielToCompanyPayload(body as BasisprofielResponse);
    // Two consumers see the patch:
    //  - `deps.onPayloadPatch` (set by unit tests via
    //    `createKvkConnector({ onPayloadPatch })`) — preserves the
    //    deterministic-mapping assertion in
    //    `companies-kvk-connector.test.ts`.
    //  - `ctx.onPayloadPatch` (set by the dispatcher in 4a.3) — runs
    //    `persistConnectorPayloadPatch` which scrubs known-secret keys
    //    and stores the result on `entity_external_links.payload_json`
    //    as `{ lastPatch, lastPatchedAt }`. The 4a.3 enrichment runner
    //    reads that field as KvK ground-truth for `fillFields`.
    deps.onPayloadPatch?.({ externalId: input.externalId, patch });
    ctx.onPayloadPatch?.({
      externalId: input.externalId,
      patch: patch as Readonly<Record<string, unknown>>,
    });
  }

  async function push(
    _ctx: ConnectorContext,
    _entity: ConnectorEntityInput<CompanyPayload>,
  ): Promise<void> {
    // KvK is read-only — `push` is a no-op success. The dispatcher
    // never calls `push` in 4a.2 (only `pull` runs through the
    // request-event subscriber), but we implement the interface for
    // future phases / unit tests.
  }

  async function verify(config: Readonly<Record<string, unknown>>): Promise<string | null> {
    const parsed = KvkConfigSchema.safeParse(config);
    if (parsed.success) return null;
    // The route-level error key — i18n catalogue covers it under
    // `errors.connectors.kvk.invalidConfig`. The specific zod issue
    // is dropped on purpose; the UI surfaces a generic message and
    // the user retries.
    return 'errors.connectors.kvk.invalidConfig';
  }

  return {
    id: KVK_CONNECTOR_ID,
    kind: KVK_CONNECTOR_KIND,
    pull,
    push,
    verify,
  };
}

/**
 * Projects a Basisprofiel response onto the subset of `CompanyPayload`
 * the connector can populate. Public so 4a.3's AI-enrichment can map
 * its inputs the same way.
 */
export function mapBasisprofielToCompanyPayload(
  res: BasisprofielResponse,
): Partial<CompanyPayload> {
  const patch: Partial<CompanyPayload> = {};
  if (typeof res.kvkNummer === 'string' && /^\d{8}$/.test(res.kvkNummer)) {
    patch.kvkNumber = res.kvkNummer;
  }
  if (typeof res.statutaireNaam === 'string' && res.statutaireNaam.length > 0) {
    patch.legalName = res.statutaireNaam;
  }
  if (typeof res.handelsnaam === 'string' && res.handelsnaam.length > 0) {
    patch.tradeName = res.handelsnaam;
  }
  const hoofd = res._embedded?.hoofdvestiging;
  if (hoofd !== undefined) {
    const website = hoofd.websites?.find((w) => typeof w === 'string' && w.length > 0);
    if (website !== undefined) {
      patch.website = website.startsWith('http') ? website : `https://${website}`;
    }
    const industry = hoofd.sbiActiviteiten?.find(
      (a) => typeof a.sbiOmschrijving === 'string' && a.sbiOmschrijving.length > 0,
    );
    if (industry?.sbiOmschrijving !== undefined) {
      patch.industry = industry.sbiOmschrijving;
    }
    const visiting = hoofd.adressen?.find((a) => a.type === undefined || a.type === 'bezoekadres');
    if (visiting !== undefined) {
      const address: NonNullable<CompanyPayload['address']> = {};
      if (typeof visiting.straatnaam === 'string') address.street = visiting.straatnaam;
      if (visiting.huisnummer !== undefined) {
        const base = String(visiting.huisnummer);
        const suffix = visiting.huisnummerToevoeging ?? '';
        address.houseNumber = suffix === '' ? base : `${base}${suffix}`;
      }
      if (typeof visiting.postcode === 'string') address.postalCode = visiting.postcode;
      if (typeof visiting.plaats === 'string') address.city = visiting.plaats;
      if (typeof visiting.land === 'string') address.country = visiting.land;
      if (Object.keys(address).length > 0) patch.address = address;
    }
  }
  return patch;
}
