import type { ContactEmail, ContactPayload, ContactPhone } from '@bunny2/shared';

/**
 * Phase 4b.2 — vCard parser. Pure function; no I/O.
 *
 * Accepts a `Uint8Array` of raw vCard bytes (UTF-8 decoded internally),
 * parses vCard 3.0 and 4.0 line-format, and returns an array of
 * `{ payload, title }` items the connector wraps as
 * `ConnectorIngestEntity<ContactPayload>`.
 *
 * Robustness contract:
 *  - CRLF / LF / mixed line endings all work.
 *  - Folded continuation lines (RFC 6350 §3.2 — a line that starts with
 *    a space / tab continues the previous logical line) are unfolded.
 *  - `BEGIN:VCARD` / `END:VCARD` mismatches are reported as warnings;
 *    the partial card is dropped, the parser keeps going.
 *  - Quoted-printable encoded values (`ENCODING=QUOTED-PRINTABLE`) are
 *    decoded.
 *  - Unknown properties are skipped silently (most vCard exports include
 *    fields we do not model — `PHOTO`, `X-FOO`, `REV`, `UID`).
 *  - The function NEVER throws on a single bad entry. It returns
 *    whatever it could parse and emits warnings for the rest.
 *
 * Coverage (per the task brief):
 *  - `FN` — display name; populates `displayName`.
 *  - `N` — structured name; second component → `familyName`, third →
 *    `givenName` (vCard's N order is family;given;additional;prefix;suffix).
 *  - `EMAIL` (with optional `TYPE=` params); first becomes primary.
 *  - `TEL` (with optional `TYPE=` params); first becomes primary.
 *  - `ORG` — first component → not stored on payload (companies live in
 *    a separate kind); attached to `notes` so a human can re-link.
 *  - `TITLE` — `jobTitle`.
 *  - `BDAY` — `birthday` (ISO `YYYY-MM-DD` or the YYYYMMDD shape vCard
 *    4 emits; the latter is normalized).
 *  - `NOTE` — appended to `notes`.
 *  - `URL` — appended to `notes` as `URL: <value>` since `ContactPayload`
 *    has no first-class URL field yet.
 *  - `ADR` — appended to `notes` as a single line; contacts payload has
 *    no address field (companies do).
 */

export interface VcardParseItem {
  readonly title: string;
  readonly payload: Partial<ContactPayload>;
}

export interface VcardParseResult {
  readonly entities: readonly VcardParseItem[];
  readonly warnings: readonly string[];
}

const utf8 = new TextDecoder('utf-8');

export function parseVcards(bytes: Uint8Array): VcardParseResult {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { entities: [], warnings: ['errors.connectors.vcard.parseFailed'] };
  }

  // Unfold folded lines (RFC 6350 §3.2). A line that starts with SPACE
  // or TAB is a continuation of the previous physical line. Normalise
  // CRLF to LF first.
  const normalized = text.replace(/\r\n?/g, '\n');
  const physicalLines = normalized.split('\n');
  const lines: string[] = [];
  for (const raw of physicalLines) {
    if (raw.length > 0 && (raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      // Append continuation (drop the leading whitespace char per RFC).
      lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + raw.slice(1);
      continue;
    }
    lines.push(raw);
  }

  const entities: VcardParseItem[] = [];
  const warnings: string[] = [];
  let current: MutableCard | null = null;
  let cardIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const upper = trimmed.toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      if (current !== null) {
        warnings.push(`errors.connectors.vcard.unexpectedBegin@${cardIndex}`);
      }
      cardIndex += 1;
      current = newCard();
      continue;
    }
    if (upper === 'END:VCARD') {
      if (current === null) {
        warnings.push(`errors.connectors.vcard.unexpectedEnd@${cardIndex}`);
        continue;
      }
      const item = finalizeCard(current);
      if (item !== null) entities.push(item);
      current = null;
      continue;
    }
    if (current === null) {
      // Property outside a BEGIN/END pair — skip silently. Some legacy
      // exporters add a top-level VERSION line outside the card; not
      // worth warning per-line.
      continue;
    }
    try {
      applyLine(current, trimmed);
    } catch {
      warnings.push(`errors.connectors.vcard.malformedLine@${cardIndex}`);
    }
  }

  if (current !== null) {
    // Stream ended mid-card; warn but do not surface the partial card.
    warnings.push(`errors.connectors.vcard.unterminatedCard@${cardIndex}`);
  }

  return { entities, warnings };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface MutableCard {
  fn: string | null;
  givenName: string | null;
  familyName: string | null;
  emails: ContactEmail[];
  phones: ContactPhone[];
  jobTitle: string | null;
  org: string | null;
  notes: string[];
  birthday: string | null;
}

function newCard(): MutableCard {
  return {
    fn: null,
    givenName: null,
    familyName: null,
    emails: [],
    phones: [],
    jobTitle: null,
    org: null,
    notes: [],
    birthday: null,
  };
}

function finalizeCard(card: MutableCard): VcardParseItem | null {
  const payload: Partial<ContactPayload> = {};
  if (card.givenName !== null) payload.givenName = clamp(card.givenName, 160);
  if (card.familyName !== null) payload.familyName = clamp(card.familyName, 160);
  if (card.fn !== null) payload.displayName = clamp(card.fn, 320);
  if (card.emails.length > 0) {
    // Deduplicate by lowercased value — the zod payload schema enforces
    // the same rule, and feeding it duplicates would fail validation.
    const seen = new Set<string>();
    const dedup: ContactEmail[] = [];
    for (const e of card.emails) {
      const key = e.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(e);
    }
    payload.emails = dedup.slice(0, 16);
  }
  if (card.phones.length > 0) {
    payload.phones = card.phones.slice(0, 16);
  }
  if (card.jobTitle !== null) payload.jobTitle = clamp(card.jobTitle, 160);
  if (card.birthday !== null) payload.birthday = card.birthday;
  // ORG / URL / ADR get folded into notes as a fallback because the
  // payload schema has no first-class slot for them. Keep the notes
  // compact — the translator re-emits the payload per locale.
  const noteParts: string[] = [];
  if (card.org !== null) noteParts.push(`ORG: ${card.org}`);
  for (const n of card.notes) noteParts.push(n);
  if (noteParts.length > 0) {
    payload.notes = clamp(noteParts.join('\n'), 4000);
  }

  const title =
    payload.displayName ??
    joinName(payload.givenName, payload.familyName) ??
    payload.emails?.[0]?.value ??
    payload.phones?.[0]?.value ??
    null;
  if (title === null) {
    // No identifying field — drop the card silently. The connector adds
    // a warning at the call site if it cares; the parser does not.
    return null;
  }
  return { title: clamp(title, 320), payload };
}

function joinName(given: string | undefined, family: string | undefined): string | null {
  const parts: string[] = [];
  if (given !== undefined && given.length > 0) parts.push(given);
  if (family !== undefined && family.length > 0) parts.push(family);
  if (parts.length === 0) return null;
  return parts.join(' ');
}

function applyLine(card: MutableCard, line: string): void {
  // A vCard line is `PROPNAME[;PARAM=VAL[;PARAM=VAL...]]:VALUE`.
  const colon = line.indexOf(':');
  if (colon === -1) return;
  const head = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);
  const parts = head.split(';');
  const propRaw = parts[0];
  if (propRaw === undefined || propRaw === '') return;
  // Strip RFC 6350 group prefix ("item1.EMAIL" → "EMAIL").
  const dot = propRaw.indexOf('.');
  const prop = (dot === -1 ? propRaw : propRaw.slice(dot + 1)).toUpperCase();
  const params = parseParams(parts.slice(1));
  const value = decodeValue(rawValue, params);

  switch (prop) {
    case 'FN':
      card.fn = value;
      break;
    case 'N': {
      // Structured: family;given;additional;prefix;suffix
      const components = value.split(';');
      card.familyName = nullIfEmpty(components[0]?.trim() ?? '');
      card.givenName = nullIfEmpty(components[1]?.trim() ?? '');
      break;
    }
    case 'EMAIL': {
      const trimmed = value.trim();
      if (trimmed === '') break;
      // Cap at 256 chars — payload schema enforces the same rule.
      if (trimmed.length > 256) break;
      // Reject obviously malformed strings; the payload schema's
      // `z.string().email()` would otherwise throw at insert time.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) break;
      const label = inferLabel(params);
      card.emails.push({
        value: trimmed,
        ...(label === null ? {} : { label }),
        ...(card.emails.length === 0 ? { isPrimary: true } : {}),
      });
      break;
    }
    case 'TEL': {
      const trimmed = value.trim();
      if (trimmed === '' || trimmed.length > 64) break;
      const label = inferLabel(params);
      card.phones.push({
        value: trimmed,
        ...(label === null ? {} : { label }),
        ...(card.phones.length === 0 ? { isPrimary: true } : {}),
      });
      break;
    }
    case 'TITLE':
      card.jobTitle = value.trim();
      break;
    case 'ORG': {
      // ORG is structured: org-name;org-unit;...
      const first = value.split(';')[0]?.trim() ?? '';
      if (first !== '') card.org = first;
      break;
    }
    case 'BDAY':
      card.birthday = normaliseBirthday(value);
      break;
    case 'NOTE':
      if (value.trim() !== '') card.notes.push(`NOTE: ${value.trim()}`);
      break;
    case 'URL':
      if (value.trim() !== '') card.notes.push(`URL: ${value.trim()}`);
      break;
    case 'ADR': {
      // ADR is structured: po-box;extended;street;locality;region;postal;country
      const cleaned = value
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join(', ');
      if (cleaned !== '') card.notes.push(`ADR: ${cleaned}`);
      break;
    }
    default:
      // Unknown property — ignore. vCard exports are noisy.
      break;
  }
}

function parseParams(rawParams: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of rawParams) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).toUpperCase();
    const val = raw.slice(eq + 1);
    // TYPE params can be comma-separated and unquoted: `TYPE=HOME,VOICE`.
    // vCard 4.0 also allows the whole comma-separated list wrapped in
    // quotes: `TYPE="HOME,VOICE"`. Strip the outer quotes BEFORE
    // splitting on commas so the pieces don't keep stray quote chars.
    // We also accept the legacy `TYPE=HOME;TYPE=VOICE` form via the
    // outer split.
    const unquoted = unquote(val);
    const pieces = unquoted.split(',').map((s) => unquote(s.trim()).toUpperCase());
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, pieces);
    } else {
      prev.push(...pieces);
    }
  }
  return map;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function decodeValue(raw: string, params: Map<string, string[]>): string {
  const encoding = params.get('ENCODING')?.[0]?.toUpperCase();
  const charset = params.get('CHARSET')?.[0]?.toUpperCase();
  let working = raw;
  if (encoding === 'QUOTED-PRINTABLE') {
    working = decodeQuotedPrintable(working);
    if (charset === 'UTF-8' || charset === undefined) {
      // already UTF-8.
    }
  }
  // Unescape vCard 3.0 / 4.0 character escapes in the VALUE part.
  return working.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n' || ch === 'N') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

function decodeQuotedPrintable(s: string): string {
  // `=XX` byte escapes plus `=\n` soft line-break joining.
  const noSoftBreaks = s.replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < noSoftBreaks.length; i += 1) {
    const ch = noSoftBreaks.charAt(i);
    if (ch === '=' && i + 2 < noSoftBreaks.length) {
      const hex = noSoftBreaks.slice(i + 1, i + 3);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code)) {
        bytes.push(code);
        i += 2;
        continue;
      }
    }
    // Encode the JS char as UTF-8 bytes so the decoder below sees a
    // valid byte stream. ASCII fast-path keeps the common case cheap.
    const cp = noSoftBreaks.codePointAt(i);
    if (cp === undefined) continue;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
      i += 1; // surrogate pair
    }
  }
  return utf8.decode(Uint8Array.from(bytes));
}

function inferLabel(params: Map<string, string[]>): string | null {
  const types = params.get('TYPE');
  if (types === undefined || types.length === 0) return null;
  // Pick a human label. We don't try to round-trip the full vCard
  // taxonomy; one descriptive token is what the UI shows next to the
  // value.
  const interesting = types.find((t) => t !== 'INTERNET' && t !== 'PREF' && t !== 'VOICE');
  const pick = interesting ?? types[0];
  if (pick === undefined || pick === '') return null;
  // Title-case the label so the UI doesn't show `HOME` in shouting.
  return pick.charAt(0) + pick.slice(1).toLowerCase();
}

function normaliseBirthday(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // vCard 4 uses `YYYYMMDD` without separators.
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (m !== null) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function nullIfEmpty(s: string): string | null {
  return s.length === 0 ? null : s;
}
