# Analytics catalogue — enum + property-value tightening

Status: open.
Filed: 2026-05-25 (close-out of `docs/dev/plans/done/admin-observability-viewer.md`).

## What remains

The analytics catalogue
(`apps/server/src/analytics/catalogue.ts`) currently validates:

- That the event name is known.
- That every property key is known for that event name.
- That property values are one of `string | number | boolean |
null`.

What it does NOT validate today:

1. **Enum values for closed-set properties.** For example,
   `chat_message_sent.lengthBucket` is documented as `'S' | 'M' |
'L'` in `docs/dev/observability/analytics.md`. The catalogue
   accepts any string at that key. A misbehaving client could
   write `lengthBucket: "this is the user's whole message"`.
2. **Tighter typing per property.** Properties whose docs say
   "number" or "stable id" accept any primitive today. Per-prop
   type info would let the catalogue reject an out-of-band value
   shape without growing a separate validator.

## Why not done now

Both items raise the same module's enforcement surface but expand
the schema (`Property = { key, type, enum?, format? }` rather than
just a key list). The change is mechanical but touches every
catalogue entry and requires the docs catalogue in
`analytics.md` to commit to per-property types as the contract,
not just per-property names. That's a separate small design call.

## Next step

1. Promote the docs catalogue rows in `analytics.md` from
   "key — description" to "key — type — enum (if any) —
   description".
2. Mirror the structure in `catalogue.ts`.
3. Extend the ingest endpoint validator to check enum membership
   and primitive-type match.
4. Add tests for each rejection path.

## Related files

- `apps/server/src/analytics/catalogue.ts`
- `apps/server/src/http/routes/analytics.ts`
- `docs/dev/observability/analytics.md`
- `apps/server/tests/http-analytics.test.ts`
