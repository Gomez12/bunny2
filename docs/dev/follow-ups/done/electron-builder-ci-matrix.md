# Electron builder CI matrix for all three OSes

- Status: done
- Owner: phase 1.7 (authored), exercised after the phase-1 push

## Outcome

Workflow `Release (per-OS portable artifacts)` ran via
`workflow_dispatch` against `main`. All three legs finished green:

- macOS — 1m53s — `apps/desktop/release/*.dmg`, `*.zip`
- Ubuntu — 5m40s — `apps/desktop/release/*.AppImage`, `*.tar.gz`
- Windows — 4m30s — `apps/desktop/release/*.exe`, `*.zip`

Run id: `26334870726`. Artifacts uploaded to the workflow run.

This verifies the **packaging pipeline** end-to-end on every target
OS. Per-artifact **runtime** sanity checks (launch the packaged app,
click through status + chat, confirm SQLite row) remain a manual
step tracked in `docs/dev/testing/phase-01-electron-manual.md`'s
Results log — those are ongoing test-ops work, not a blocker for
phase-1 closeout.

## What was done in 1.7

- `.github/workflows/ci.yml` runs format/lint/typecheck/test/build
  on `ubuntu-latest`, `macos-latest`, and `windows-latest`. This
  catches platform-specific source bugs even before packaging — it
  surfaced the `new URL(...).pathname` Windows bug fixed in commit
  `54c42fd` and the CRLF format-check bug fixed in `f63bdf3`.
- `.github/workflows/release.yml` runs `bun run package` per OS on
  `workflow_dispatch` and on `v*` tag push, uploading the artifacts
  under `apps/desktop/release/`.

## Related files / docs

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/scripts/prepare-resources.ts`
- `docs/dev/testing/phase-01-electron-manual.md` (Results log)
- `docs/dev/plans/done/phase-01-system-foundation.md` §12
