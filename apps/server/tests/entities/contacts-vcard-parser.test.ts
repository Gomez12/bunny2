/**
 * Phase 4b.2 — pure unit tests for the vCard parser.
 *
 * Cover the four robustness lines from the brief:
 *   - minimal vCard (3.0) round-trips into a payload.
 *   - rich vCard 4.0 with multi-line FN / ADR / multi-TYPE EMAIL works
 *     and the folded continuation lines unfold.
 *   - a malformed entry is dropped, the parser keeps going, and a
 *     warning is emitted.
 *   - mixed CRLF / LF line endings are handled.
 */
import { describe, expect, it } from 'bun:test';
import { parseVcards } from '../../src/entities/contacts/vcard';

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

describe('parseVcards — minimal vCard 3.0', () => {
  it('extracts FN, N, EMAIL, TEL, ORG, TITLE, BDAY', () => {
    const card = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Alice Example',
      'N:Example;Alice;;;',
      'EMAIL;TYPE=INTERNET,HOME:alice@example.com',
      'TEL;TYPE=CELL:+31 6 1234 5678',
      'ORG:Example BV',
      'TITLE:Lead Engineer',
      'BDAY:1990-04-12',
      'END:VCARD',
      '',
    ].join('\n');
    const result = parseVcards(bytes(card));
    expect(result.warnings).toEqual([]);
    expect(result.entities.length).toBe(1);
    const item = result.entities[0]!;
    expect(item.title).toBe('Alice Example');
    expect(item.payload.givenName).toBe('Alice');
    expect(item.payload.familyName).toBe('Example');
    expect(item.payload.displayName).toBe('Alice Example');
    expect(item.payload.emails?.[0]?.value).toBe('alice@example.com');
    expect(item.payload.emails?.[0]?.isPrimary).toBe(true);
    expect(item.payload.emails?.[0]?.label).toBe('Home');
    expect(item.payload.phones?.[0]?.value).toBe('+31 6 1234 5678');
    expect(item.payload.phones?.[0]?.isPrimary).toBe(true);
    expect(item.payload.jobTitle).toBe('Lead Engineer');
    expect(item.payload.birthday).toBe('1990-04-12');
    expect(item.payload.notes).toContain('ORG: Example BV');
  });
});

describe('parseVcards — rich vCard 4.0 with folded lines + multi-TYPE + ADR', () => {
  it('unfolds continuation lines and decodes structured properties', () => {
    // Use CRLF line endings as a real export would; intersperse one
    // folded continuation that joins on the previous line.
    const card = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Bob McMultipart',
      ' -Surname',
      'N:McMultipart-Surname;Bob;Middle;;Jr',
      'EMAIL;TYPE="WORK,PREF":bob@work.example',
      'EMAIL;TYPE=HOME:bob@home.example',
      'TEL;TYPE=VOICE,HOME:+15551234567',
      'ADR;TYPE=WORK:;;1 Long Road;Amsterdam;;1011AA;NL',
      'URL:https://bob.example',
      'NOTE:Met at conference.',
      'BDAY:19850101',
      'END:VCARD',
      '',
    ].join('\r\n');
    const result = parseVcards(bytes(card));
    expect(result.warnings).toEqual([]);
    const item = result.entities[0]!;
    // Folded `FN` continuation should join into one display name.
    expect(item.payload.displayName).toBe('Bob McMultipart-Surname');
    expect(item.payload.givenName).toBe('Bob');
    expect(item.payload.familyName).toBe('McMultipart-Surname');
    expect(item.payload.emails?.length).toBe(2);
    expect(item.payload.emails?.[0]?.value).toBe('bob@work.example');
    // TYPE=WORK,PREF — `WORK` wins because PREF is filtered.
    expect(item.payload.emails?.[0]?.label).toBe('Work');
    expect(item.payload.emails?.[0]?.isPrimary).toBe(true);
    expect(item.payload.emails?.[1]?.isPrimary).toBeUndefined();
    expect(item.payload.phones?.[0]?.value).toBe('+15551234567');
    // VOICE is filtered; HOME wins.
    expect(item.payload.phones?.[0]?.label).toBe('Home');
    expect(item.payload.birthday).toBe('1985-01-01');
    expect(item.payload.notes).toContain('ADR: 1 Long Road, Amsterdam, 1011AA, NL');
    expect(item.payload.notes).toContain('URL: https://bob.example');
    expect(item.payload.notes).toContain('NOTE: Met at conference.');
  });
});

describe('parseVcards — malformed entries do not crash the run', () => {
  it('drops a card with no identifying fields and continues parsing', () => {
    const card = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Cara Continue',
      'EMAIL:cara@example.com',
      'END:VCARD',
      'END:VCARD', // stray END after the chain — must emit warning, not throw
      '',
    ].join('\n');
    const result = parseVcards(bytes(card));
    expect(result.entities.length).toBe(1);
    expect(result.entities[0]!.title).toBe('Cara Continue');
    // Both the empty card (no identifying fields → dropped silently) and
    // the stray END (warning) — we only assert at least one warning.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.startsWith('errors.connectors.vcard.'))).toBe(true);
  });

  it('reports an unterminated card and still returns prior cards', () => {
    const card = [
      'BEGIN:VCARD',
      'FN:Diana Done',
      'EMAIL:diana@example.com',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:Eve Unfinished',
      'EMAIL:eve@example.com',
      '', // stream ends before END:VCARD
    ].join('\n');
    const result = parseVcards(bytes(card));
    expect(result.entities.length).toBe(1);
    expect(result.entities[0]!.title).toBe('Diana Done');
    expect(
      result.warnings.some((w) => w.startsWith('errors.connectors.vcard.unterminatedCard')),
    ).toBe(true);
  });
});

describe('parseVcards — mixed line endings', () => {
  it('parses a file with CRLF and LF interleaved', () => {
    const card = ['BEGIN:VCARD', 'FN:Felix Mixed', 'EMAIL:felix@example.com'].join('\r\n');
    const tail = ['END:VCARD', ''].join('\n');
    const result = parseVcards(bytes(`${card}\n${tail}`));
    expect(result.warnings).toEqual([]);
    expect(result.entities.length).toBe(1);
    expect(result.entities[0]!.title).toBe('Felix Mixed');
    expect(result.entities[0]!.payload.emails?.[0]?.value).toBe('felix@example.com');
  });
});

describe('parseVcards — escapes & deduplication', () => {
  it('unescapes \\n in NOTE and de-duplicates email entries case-insensitively', () => {
    const card = [
      'BEGIN:VCARD',
      'FN:Greta Escape',
      'EMAIL:dup@example.com',
      'EMAIL:DUP@example.com',
      'EMAIL:other@example.com',
      'NOTE:Line1\\nLine2',
      'END:VCARD',
    ].join('\n');
    const result = parseVcards(bytes(card));
    expect(result.warnings).toEqual([]);
    const item = result.entities[0]!;
    expect(item.payload.emails?.length).toBe(2);
    expect(item.payload.notes).toContain('NOTE: Line1\nLine2');
  });
});
