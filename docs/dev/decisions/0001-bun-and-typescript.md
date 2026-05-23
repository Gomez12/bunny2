# ADR 0001 — Bun runtime + TypeScript strict end-to-end

- Status: accepted
- Date: 2026-05-23
- Phase: 1.1 (recap, authored during 1.7 close-out)
- Related: `AGENTS.md` §Bun / §Code; `docs/dev/plans/overall.md` §4;
  `docs/dev/plans/done/phase-01-system-foundation.md` §4.2 row "1.1";
  ADR 0004 (Electron + Bun sidecar), ADR 0006 (Hono on Bun).

---

## Context

`AGENTS.md` §Bun states "Use Bun unless project says otherwise" and
explicitly tells contributors to avoid npm, yarn, pnpm, and Node-only
tooling. The overall plan (§4) commits to "Runtime / package: Bun" and
"Language: TypeScript end-to-end". Phase 1.1 stood up the monorepo on
that basis but did not record the decision as an ADR. This ADR
captures the rationale so later phases (and later contributors) have a
single citeable source.

We needed to commit to one runtime and one type discipline before any
code landed because:

1. The chosen runtime shapes every package boundary: workspace layout,
   script orchestration, test runner, file APIs (`Bun.serve`,
   `bun:sqlite`, `Bun.env`), the bundler used to package the server
   sidecar (ADR 0004 §2), and the HTTP router shape (ADR 0006).
2. The chosen type discipline shapes the public-API contracts between
   `apps/*` and `packages/*` (zod schemas in `packages/shared`,
   adapter-shaped `MessageBus` in `packages/bus`, telemetry-wrapped
   `LlmClient`).
3. Switching runtimes or relaxing strictness late is expensive — every
   downstream decision (sqlite driver, HTTP router, packager, IPC
   shape) depends on this floor.

---

## Decision

### 1. Bun is the only supported runtime

- `package.json` `engines.bun: ">=1.3.0"`. CI pins a concrete version
  (`.github/workflows/ci.yml`).
- The server entrypoint uses `Bun.serve` (ADR 0006) and `bun:sqlite`
  (ADR 0002). The Electron sidecar runs the bundled server under a
  bundled Bun binary (ADR 0004 §2).
- Scripts in `scripts/`, `apps/desktop/scripts/`, and the per-workspace
  `package.json` are Bun TypeScript files (`bun run ...`), never Bash
  or Node-only tooling. Cross-platform portability follows from
  `AGENTS.md` §Platforms (no bash-only scripts, no OS-specific paths).
- npm / yarn / pnpm are not used. The lockfile is `bun.lock`.

### 2. TypeScript everywhere, strict, no `any`

- `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, and the rest of
  TS's strict family. Each workspace extends it.
- Per-workspace `tsconfig.json` adds `noEmit: true` for the `typecheck`
  script (`bun run --filter '*' typecheck`).
- `AGENTS.md` §Code forbids `any`, unsafe casts, hidden side effects,
  global mutable state, and magic values. This is enforced by ESLint
  (`typescript-eslint` recommended + a few project rules) and reviewed
  during PR.
- Zod is the runtime boundary for untrusted input (config files, HTTP
  bodies, env overrides). The schema is authoritative; TypeScript
  types are inferred from it (`z.infer<...>`).

### 3. One toolchain per concern

- Format: Prettier (single config at the repo root).
- Lint: ESLint + `typescript-eslint` + `eslint-config-prettier`.
- Tests: `bun test` (the built-in runner — fast on Bun, no Jest /
  Vitest split).
- Typecheck: `tsc --noEmit` per workspace.
- Build: `bun build` for the server bundle (ADR 0004), `vite build`
  for the renderer.

`bun install && bun run format:check && bun run lint && bun run
typecheck && bun test && bun run i18n:check && bun run docs:check &&
bun run build` is the canonical pre-PR check sequence.

---

## Consequences

**Positive**

- One runtime, one package manager, one lockfile. No "which `node`?"
  ambiguity, no Node ↔ Bun ↔ npm-script split.
- `bun:sqlite` ships in-runtime — no native module compilation
  matrix. (LanceDB is still a native module; see ADR 0003.)
- TypeScript strict + zod at the edge means runtime data conforms to
  its compile-time type, and the build fails before a regression lands
  rather than crashing in production.
- The portable build story (ADR 0004) only works because the runtime
  is small enough to ship next to the executable.

**Negative / accepted**

- Bun's ecosystem is younger than Node's; an occasional library only
  ships Node-flavoured bindings (we hit this with LanceDB — see
  follow-up `docs/dev/follow-ups/lancedb-windows.md`).
- Some tools (electron, electron-builder) are Node-native and we drive
  them via Bun. This works but is a known seam.
- Strict TypeScript adds friction during early exploration. Accepted —
  the code is the product spec, not a sketch.

---

## Alternatives considered

1. **Node.js + npm/pnpm.** Mature, ubiquitous. Rejected: forces a
   separate bundle/runtime/sqlite story, and `AGENTS.md` explicitly
   names Bun as the project runtime. The "we already wrote `AGENTS.md`
   that way" is itself an output of an earlier decision; ADR 0001
   records the engineering reasons (single binary, in-runtime sqlite,
   `Bun.serve`, fast test runner) that made that choice load-bearing.
2. **Deno.** Excellent TS-first runtime, but its package and Node-compat
   stories during phase-1 planning were churning, and its native-asset
   story (Electron sidecar shipping a runtime + LanceDB native) was
   less proven than Bun's. Revisit only if Bun blocks us.
3. **TypeScript without strict.** Rejected: `AGENTS.md` §Code requires
   typed/explicit code; downstream code review effort balloons
   without `strict`.
4. **JavaScript at the package boundaries, TS only in `apps/*`.**
   Rejected: shared types in `packages/shared` are the value of the
   monorepo; losing them at the boundary defeats the point.

---

## Status

Accepted. Reaffirmed at phase 1.7 close-out (no signal in 1.1–1.6 that
the choice needs revisiting). Revisit if and only if Bun blocks a
phase deliverable that has no Bun-side workaround.

## Follow-ups

- None tracked specifically against this ADR; the LanceDB and
  electron-signing follow-ups are downstream consequences and live in
  `docs/dev/follow-ups/`.
