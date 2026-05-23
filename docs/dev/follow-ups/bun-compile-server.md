# Try `bun build --compile` for the server bundle

- Status: open
- Owner: phase 2+ packaging

## What remains

Replace `bun build --target=bun` (which produces an `index.js` plus
native `.node` assets) with `bun build --compile` (which produces a
single OS-native executable). If LanceDB's native asset cooperates
and cross-compilation is reliable, this would let us drop the
`vendor/bun/` runtime entirely on each artifact.

## Why not done now

Phase 1.6 picked the JS-bundle path because:

1. `bun build --compile` is still maturing on cross-targets.
2. LanceDB's `.node` asset still ships next to the binary, so the
   "single file" benefit is partial.
3. We want the same artifact layout on every OS to keep the manual
   smoke checklist short.

## Next step

In phase 2 (or whenever LanceDB's native-asset story matures):

1. Spike `bun build --compile --target=bun-darwin-arm64` against
   `apps/server/src/index.ts`.
2. Verify migrations + LanceDB still load (the runtime resolvers
   resolve via `import.meta.url` which behaves differently inside a
   single-file executable).
3. If it works on all five targets, drop `vendor/bun/` and the
   `fetch-bun-runtimes.ts` script; the compiled binary replaces both.

## Related files / docs

- `apps/desktop/scripts/prepare-resources.ts`
- `apps/desktop/scripts/fetch-bun-runtimes.ts`
- `docs/dev/decisions/0004-electron-as-thin-wrapper.md`
