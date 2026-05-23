# Verify hashes of downloaded Bun runtime artifacts

- Status: open
- Owner: phase 1+ packaging

## What remains

`apps/desktop/scripts/fetch-bun-runtimes.ts` downloads Bun release
artifacts from GitHub but does not verify a checksum. We should:

1. Pin known-good SHA256 sums for each `(version, platform, arch)`
   tuple.
2. Verify the downloaded zip against the pinned sum before extracting.
3. Fail loud if the sum drifts.

## Why not done now

Bun's release page does not currently publish a stable checksum
manifest alongside its zip artifacts; pinning sums manually adds
friction without much trust improvement until we automate the pin
extraction from `oven-sh/bun` release notes.

## Next step

When Bun publishes signed checksums (or a SLSA attestation), wire the
verification into `downloadBinary` in `fetch-bun-runtimes.ts`.

## Related files / docs

- `apps/desktop/scripts/fetch-bun-runtimes.ts`
- `docs/dev/architecture/packaging.md`
