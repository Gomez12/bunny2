# Desktop dev orchestrator: watch + restart on source changes

- Status: done
- Owner: phase 1.6+ DX

## Resolution

`apps/desktop/scripts/dev.ts` now installs a recursive `fs.watch` over
`apps/server/src` and each `packages/*/src`, filters to
`.ts`/`.tsx`/`.json` edits, debounces bursts at 250ms, and restarts the
server child with a single-flight guard (SIGTERM, 3s fallback to SIGKILL,
then re-spawn via `startServer()`). Vite continues to handle renderer
changes itself.

## What remains

`apps/desktop/scripts/dev.ts` spawns the server once and lets Vite
own its own watch loop. Server-side TypeScript changes require Ctrl+C

- restart of the dev session.

Add a watch on `apps/server/src/**` (and `packages/**` once those have
content) that restarts the server child process.

## Why not done now

Phase 1.6 prioritised packaging correctness. Watch-restart logic is
quality-of-life and ships better with a real DX iteration after
phase 1 closes.

## Next step

Use `Bun.watch` or `fs.watch` with a debounce, send SIGTERM to the
server child, and `start('server', …)` again. The orchestrator
already cleanly stops children on signal — extending that to a
controlled restart is straightforward.

## Related files / docs

- `apps/desktop/scripts/dev.ts`
- `docs/dev/architecture/packaging.md`
