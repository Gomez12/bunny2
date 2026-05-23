# Windows `bun:sqlite` tempdir cleanup hits EBUSY

- Status: deferred
- Owner: unassigned

## Symptom

On `windows-latest`, ~30 tests fail with:

```
error: EBUSY: resource busy or locked, rm 'C:\Users\RUNNER~1\AppData\Local\Temp\bunny2-…'
```

Reproduced in CI runs `26338038222`, `26338133407`, `26338226439`,
`26338379610`. macOS and Linux pass the same tests cleanly.

## Why not fixed now

After phase 2.7 we attempted four fixes in sequence:

1. `fs.rmSync({ maxRetries, retryDelay })` — Bun ignores those Node
   options (commit `88b23b3`).
2. Manual EBUSY retry loop in `tests/_helpers/temp-dir.ts` — handle
   stays locked indefinitely (commit `ec58b62`).
3. `journal_mode = DELETE` via `bunfig.toml` preload + an
   `openDatabase` option — still EBUSY (commit `ef000b8`).
4. Best-effort swallow-and-warn — keeps tests green but leaks the
   temp directory; not landed because we'd rather understand the
   root cause first.

The root cause appears to be a `bun:sqlite` file-handle release bug
on Windows. Issue not yet filed upstream.

Per the user's call (2026-05-23), we're parking Windows for now and
finishing on Mac. `.github/workflows/ci.yml` marks `windows-latest`
as `continue-on-error: true` so the matrix still runs and we get
visibility without blocking the green check.

## Next step

Options to evaluate when picking this back up:

1. File an upstream issue against `bun:sqlite` with the exact
   reproduction (we have it on hand — point at any of the failing
   CI runs above).
2. Switch tests to `:memory:` SQLite so no real file exists. Largest
   refactor; some tests open the file via a second connection so
   that work would need to land first.
3. Accept the leak and ship the swallow-and-warn version of
   `safeRmSync`. Temp dirs live under `os.tmpdir()` and CI runners
   are ephemeral, so the cost is purely cosmetic.
4. Switch the Windows test job to WSL — sidesteps the bug entirely
   but loses native Windows verification.

Once a fix lands, flip `continue-on-error` back to `false` in
`.github/workflows/ci.yml` and remove this follow-up.

## Related files

- `.github/workflows/ci.yml` (matrix `continue_on_error` flag)
- `apps/server/tests/_helpers/temp-dir.ts` (`safeRmSync`)
- `apps/server/src/storage/sqlite.ts` (`journalMode` option +
  `BUNNY2_SQLITE_JOURNAL_MODE` env)
- `tests-setup.ts` + `bunfig.toml` (test preload that defaults
  journal mode to `DELETE`)
