# Electron builder CI matrix for all three OSes

- Status: open
- Owner: phase 1.7

## What remains

Build the per-OS portable artifacts in CI on:

- macOS (x64 + arm64)
- Linux (x64 + arm64 if a runner is available; x64 minimum)
- Windows (x64)

The CI job should:

1. `bun install`
2. `bun run package:prepare`
3. `bun run --filter '@bunny2/desktop' package`
4. Upload the artifacts from `apps/desktop/release/`.

## Why not done now

Phase 1.6 produces the bundle + electron-builder config locally; the
"all three OSes build" guarantee is a phase 1.7 deliverable per
`phase-01-system-foundation.md` §12.

## Next step

Add a `.github/workflows/package.yml` (or equivalent) with three jobs.

## Related files / docs

- `apps/desktop/electron-builder.yml`
- `apps/desktop/scripts/prepare-resources.ts`
- `docs/dev/plans/phase-01-system-foundation.md` §12
