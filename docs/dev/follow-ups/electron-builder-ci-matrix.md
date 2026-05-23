# Electron builder CI matrix for all three OSes

- Status: in-progress
- Owner: phase 1.7 (authored), verification owner unassigned

## What remains

The workflow is authored as `.github/workflows/release.yml`. It still
needs to be **exercised on GitHub Actions**:

1. Trigger via `workflow_dispatch` (or push a `v*` tag).
2. Confirm each matrix leg (macOS, Linux, Windows) finishes green.
3. Download an artifact per OS and run the manual checklist in
   `docs/dev/testing/phase-01-electron-manual.md`. Update its
   Results log table with `pass`/`fail` per OS.
4. Once all three OS rows are `pass`, flip tasklist row 1.6 from
   `needs-testing` to `done`.

## What was done in 1.7

- `.github/workflows/ci.yml` now runs format/lint/typecheck/test/build
  on `ubuntu-latest`, `macos-latest`, and `windows-latest`. This
  catches platform-specific source bugs even before packaging.
- `.github/workflows/release.yml` runs `bun run package` per OS on
  `workflow_dispatch` and on `v*` tag push, uploading the artifacts
  under `apps/desktop/release/`.

## Why not flipped to `done` yet

Triggering the workflow requires repo permissions on GitHub Actions
and a real run — we cannot fire it from the macOS dev host. The CI
matrix is the path to verification, not a substitute for it.

## Related files / docs

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/scripts/prepare-resources.ts`
- `docs/dev/testing/phase-01-electron-manual.md` (Results log)
- `docs/dev/plans/phase-01-system-foundation.md` §12
