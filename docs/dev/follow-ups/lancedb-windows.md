# LanceDB on Windows

- Status: open
- Owner: phase 1.7 (verify) / phase 2 (workaround if needed)

## What remains

Verify that the LanceDB native module loads cleanly inside the
packaged Windows artifact. If it does not, ship a
`BUNNY2_DISABLE_LANCEDB=1` escape hatch and document it.

`apps/server/src/index.ts` currently initializes LanceDB
unconditionally on startup. Phase 1.6 deliberately did **not**
pre-emptively guard it (per the task brief). The mac/Linux paths
exercise LanceDB fine after `bun build`; Windows is unverified because
phase 1.6 was developed on macOS.

## Why not done now

No Windows host was available during phase 1.6 implementation. Phase
1.7's CI matrix is the right place to discover the answer.

## Next step

1. In phase 1.7 CI, run the Windows build's `apps/desktop/resources/server/index.js`
   from the Bun runtime under `vendor/bun/windows-x64/`.
2. If LanceDB fails, add the escape hatch:
   ```ts
   if (process.env.BUNNY2_DISABLE_LANCEDB !== '1') {
     // existing init
   }
   ```
3. Document it in `docs/dev/architecture/packaging.md`.

## Related files / docs

- `apps/server/src/index.ts`
- `apps/server/src/storage/lancedb.ts`
- `docs/dev/plans/phase-01-system-foundation.md` §10 row 2 (LanceDB risk)
- `docs/dev/decisions/0003-lancedb.md`
