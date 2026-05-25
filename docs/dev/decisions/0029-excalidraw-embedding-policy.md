# ADR 0029 — Excalidraw embedding policy (upstream OSS only)

- Status: accepted
- Date: 2026-05-25
- Phase: 11 (sub-phases 11.0, 11.5, 11.7)
- Related: [`docs/dev/plans/phase-11-whiteboards-excalidraw.md`](../plans/phase-11-whiteboards-excalidraw.md)
  §1, §3 non-goals, §4.1 (11.5), §10 dependencies;
  [`overall.md` §10 decision 5](../plans/overall.md#10-decisions-answered-open-questions)
  ("Excalidraw + Kanban → use existing OSS components");
  ADR [`0011`](./0011-entity-contract.md) (wrapper-owned
  persistence pattern this ADR aligns with);
  ADR [`0028`](./0028-whiteboard-contract.md) (payload contract
  that depends on staying upstream-compatible);
  Source code (lands in 11.5):
  `apps/web/src/pages/whiteboards/`,
  `apps/web/package.json` (the dependency entry).

---

## Context

[`overall.md` §10.5](../plans/overall.md#10-decisions-answered-open-questions)
already settled "Excalidraw + Kanban → use existing OSS
components, do not build bespoke." Phase 11 needs that decision
tightened from "use OSS" to **how** the OSS gets embedded, so
later phases (live collab, mobile, automation) do not have to
re-litigate.

Three questions need an answer before 11.5 (web UI) ships:

1. **Fork or upstream?** Patching upstream temporarily is cheap,
   but vendor-locks the project to a fork.
2. **What runs in the wrapper vs the canvas?** Persistence,
   auth, i18n, telemetry, lock-banner — each could live either
   inside an Excalidraw extension or outside the canvas
   component. The choice determines blast radius of upstream
   upgrades.
3. **Which Excalidraw features are intentionally disabled in v1?**
   Library import, public-share, room-collab, and embedded
   image-from-URL each carry security / trust implications.

---

## Decisions

### 1. Upstream `@excalidraw/excalidraw` only — no fork, no patches

The web build depends on `@excalidraw/excalidraw` directly from
npm. No fork lives in this repository, no patch-package overlay,
no monkey-patched export. If upstream lacks a feature, the
options in order of preference are:

1. **Move the feature outside the canvas** into the wrapper.
2. **Defer the feature** (file as
   `docs/dev/follow-ups/whiteboards-<name>.md`).
3. **File the gap upstream** and wait.

A fork is explicitly out of scope and would require its own ADR
to introduce.

**Why no fork**: forks accumulate drift, gate upstream upgrades
on manual reconciliation, and turn a self-maintaining dependency
into project-owned code. The project's invariant from
`overall.md` §10.5 is "use existing OSS"; a fork is custom code
wearing OSS clothes.

**Why no patch-package**: same drift problem at smaller scale,
plus opaque to anyone reading the dependency graph. Patches
silently break on upstream upgrades.

Version range: `^<current-major>` pinned in `apps/web/package.json`.
Major-version bumps require an explicit follow-up
(`docs/dev/follow-ups/excalidraw-upgrade.md`) so the upgrade gets
a deliberate review pass.

### 2. Wrapper owns persistence + auth + i18n + telemetry + lock UI; canvas owns drawing

The split is sharp:

| Concern                    | Lives in                       | Why                                                                                                                          |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Drawing primitives         | Excalidraw                     | The whole point of using the package                                                                                         |
| Undo / redo / multi-select | Excalidraw                     | Upstream is better at this than any wrapper would be                                                                         |
| Keyboard map               | Excalidraw                     | Wrapper must not duplicate keys; `react-big-calendar` precedent (phase 4c)                                                   |
| Element-level state        | Excalidraw                     | Per ADR 0028 the server treats element bodies as opaque                                                                      |
| Save (debounced PATCH)     | Wrapper                        | Auth + flow-id + telemetry headers + retry policy belong to the app, not the canvas                                          |
| Checkpoint trigger         | Wrapper                        | Per ADR 0028 §1 — both manual button and idle-window                                                                         |
| Auth check                 | Wrapper                        | `effectiveLayers` happens before the canvas mounts                                                                           |
| i18n (wrapper strings)     | Wrapper                        | `entity.whiteboards.*` keys land in the project's locale bundles                                                             |
| i18n (canvas strings)      | Excalidraw                     | Wrapper passes `langCode` through; upstream ships locales                                                                    |
| Telemetry                  | Wrapper                        | Save latency, checkpoint bytes, error count — emitted around the PATCH, not from inside the canvas                           |
| Lock banner                | Wrapper                        | "Another session edited this whiteboard a moment ago" UI lives outside the canvas; canvas does not know about other sessions |
| Export menu                | Wrapper invokes Excalidraw API | UI chrome is wrapper; `exportToBlob` / `exportToSvg` are upstream APIs called from the wrapper                               |

The wrapper communicates with Excalidraw only via documented
props (`initialData`, `onChange`, `langCode`, `theme`, the
`UIOptions` to disable features per decision 3) and the imperative
`excalidrawAPI` ref it exposes for export.

**Why this split**: it minimises the surface area on which an
upstream upgrade can break us. The wrapper depends only on
upstream's public API; nothing reaches into Excalidraw internals.

### 3. Disabled-in-v1 feature list

The wrapper passes `UIOptions` (and equivalent props where
needed) that disable:

- **Library import / browse** (`UIOptions.tools.image` library
  panel, library-import button). Trust boundary: importing a
  library means executing arbitrary scene content from outside
  the layer; ADR 0028 §3 trusts upstream's own self-consistency
  but does not extend that trust to third-party `.excalidrawlib`
  files.
- **Public share** (any "share link" affordance). Public sharing
  bypasses `effectiveLayers`; auth is non-negotiable per
  `overall.md` §5.
- **Room collaboration** (`UIOptions.welcomeScreen` collab
  button, plus the `isCollaborating` prop is never true). Live
  collab is a deferred follow-up per plan §3.
- **Embedded image-from-URL** (image elements with `dataURL =
http(s)://…`). Server-side validation in 11.1 rejects any
  `files` entry whose `dataURL` is not a `data:` URI, plus a
  per-file size cap (see ADR 0030). Url-sourced images would
  fetch from arbitrary hosts inside the user's session and emit
  request signals to those hosts — out of scope for v1.

If a future phase wants any of these, it requires an explicit
follow-up + a security review against the same trust boundary.

---

## Consequences

- Upstream-major bumps require a deliberate pass, not a routine
  dependency update. The pin policy in decision 1 is the
  enforcement.
- The wrapper carries the i18n key `entity.whiteboards.*` set
  end-to-end; Excalidraw's own locales handle in-canvas strings.
  Drift between the two is acceptable — they describe different
  layers (canvas UI vs app UI).
- The lock banner in 11.5 is a wrapper-only feature; if/when live
  collab arrives, the wrapper's banner becomes redundant and is
  removed by the live-collab follow-up.
- Disabling library import means the v1 user cannot insert
  pre-built shape packs. The product reads as "blank canvas
  only"; a user reaching for that affordance is the signal that
  a follow-up should be filed.
- Bundle weight (~hundreds of KiB minified+gz) is mitigated by
  `React.lazy` route-split on the detail page (plan §10). Widget
  - list page do not import the canvas.

---

## Alternatives considered

1. **Fork Excalidraw to add missing features.** Rejected per
   `overall.md` §10.5 and decision 1; vendor lock + drift outweigh
   any feature gain.
2. **Embed via `iframe` to fully isolate.** Rejected: kills the
   thin-wrapper persistence model (postMessage round-trips +
   auth-token passing) and offers no benefit the React embed
   plus disabled-features policy doesn't already provide.
3. **Build a custom canvas.** Rejected per `overall.md` §10.5
   ("do not build bespoke"); would consume the bulk of the
   phase budget.
4. **Enable library import behind a per-layer toggle.** Rejected
   for v1: the toggle expands the trust boundary without a
   review process to evaluate library content. Filed as a
   candidate follow-up only if a real user asks.
5. **Render Excalidraw lazily via dynamic `import()` instead of
   `React.lazy`.** Rejected as redundant; `React.lazy` is a thin
   wrapper around dynamic `import()` and integrates with Suspense
   for the loading state we already need.
