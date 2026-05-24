import { z } from 'zod';
import type { ContactPayload } from '@bunny2/shared';
import type {
  ConnectorIngestContext,
  ConnectorIngestPayload,
  ConnectorIngestResult,
  EntityConnector,
} from '../connectors/base';
import { parseVcards } from './vcard';

/**
 * Phase 4b.2 — vCard import connector.
 *
 * `ingest`-only connector: the user uploads a `.vcf` file, the parser
 * produces N contact payloads, and the dispatcher creates / updates
 * them in the layer. No `pull`, no `push`, no `entity_external_links`
 * rows — the .vcf file is a one-shot import, not an upstream system.
 *
 * Secrets discipline: vCard import has no secrets. The connector still
 * obeys the dispatcher's event invariants — the dispatcher publishes
 * `entity.connector.ingest.{requested,completed}` with NO byte / file
 * data in the payload. Per-entity refs surface via the generic store's
 * `entity.contact.{created,updated}` events. The connector itself
 * never writes to the bus.
 */

export const VCARD_CONNECTOR_ID = 'vcard';
export const VCARD_CONNECTOR_KIND = 'contact';

/**
 * vCard import takes no per-attachment config. The `verify` schema is
 * intentionally empty (and strict, so an operator who passes a stray
 * field sees the same kind of failure they get with the KvK connector).
 */
export const VcardConfigSchema = z.object({}).strict();

export const VCARD_ERROR_KEYS = {
  InvalidContentType: 'errors.connectors.vcard.invalidContentType',
  ParseFailed: 'errors.connectors.vcard.parseFailed',
  InvalidConfig: 'errors.connectors.vcard.invalidConfig',
} as const;

const ACCEPTED_MIME_PREFIXES = ['text/vcard', 'text/x-vcard', 'text/directory'];

function isAcceptedContentType(input: ConnectorIngestPayload): boolean {
  const mime = input.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (ACCEPTED_MIME_PREFIXES.includes(mime)) return true;
  // Some browsers send `application/octet-stream` for `.vcf` uploads
  // because the OS does not register the MIME type. Accept based on
  // filename extension in that case — the connector still validates
  // the payload (the parser will refuse anything that isn't a card).
  if (input.filename !== undefined && /\.vcf$/i.test(input.filename)) return true;
  return false;
}

export function createVcardConnector(): EntityConnector<ContactPayload> {
  async function ingest(
    _ctx: ConnectorIngestContext,
    payload: ConnectorIngestPayload,
  ): Promise<ConnectorIngestResult<ContactPayload>> {
    if (!isAcceptedContentType(payload)) {
      throw new Error(VCARD_ERROR_KEYS.InvalidContentType);
    }
    const parsed = parseVcards(payload.bytes);
    const entities = parsed.entities.map((item) => {
      const email = primaryEmail(item.payload);
      return {
        title: item.title,
        payload: item.payload,
        ...(email === null
          ? {}
          : { matchKey: { kind: 'email' as const, value: email.toLowerCase() } }),
      };
    });
    return { entities, warnings: parsed.warnings };
  }

  async function verify(config: Readonly<Record<string, unknown>>): Promise<string | null> {
    const result = VcardConfigSchema.safeParse(config);
    return result.success ? null : VCARD_ERROR_KEYS.InvalidConfig;
  }

  return {
    id: VCARD_CONNECTOR_ID,
    kind: VCARD_CONNECTOR_KIND,
    verify,
    ingest,
    // No `pull` — vCard import is push-driven.
    // No `push` — vCard files are one-shot imports.
  };
}

function primaryEmail(payload: Partial<ContactPayload>): string | null {
  if (payload.emails === undefined || payload.emails.length === 0) return null;
  const primary = payload.emails.find((e) => e.isPrimary === true);
  return primary?.value ?? payload.emails[0]?.value ?? null;
}
