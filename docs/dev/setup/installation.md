# Installation (developers)

This document covers everything a new developer needs to clone, install,
and run bunny2 from source. For end-user installation (running a
released portable build), see `docs/user/guides/getting-started.md`.

---

## Prerequisites

| Tool | Required version | Notes                                                                                                                       |
| ---- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bun  | `>= 1.3.0`       | `package.json::engines.bun`. CI pins `1.3.13` (`.github/workflows/ci.yml`). Install per `https://bun.sh/docs/installation`. |
| Git  | any              | For cloning.                                                                                                                |

That is the complete list for `bun install` + `bun test` + `bun run
build`. No Node.js, no npm, no yarn, no pnpm — see
[ADR 0001](../decisions/0001-bun-and-typescript.md).

### Optional, per workflow

- **Electron packaging** (only for `bun run package` /
  `bun run dev:desktop`): nothing extra on macOS / Linux. On Windows,
  Visual C++ Build Tools may be needed for native module rebuilds
  during `electron-builder`. See `docs/dev/architecture/packaging.md`.
- **Cross-OS packaging on a single host**: limited. We rely on the CI
  matrix in `.github/workflows/release.yml` to build the per-OS
  artifacts. Locally you can package for the host OS only.

---

## Supported operating systems

- macOS 12+ (Intel and Apple Silicon)
- Linux x64 (glibc 2.31+); aarch64 best-effort
- Windows 10/11 x64

Cross-platform requirements are normative for code and scripts —
`AGENTS.md` §Platforms. If a script breaks on Windows or a path is
Unix-only, that is a bug.

---

## Clone and install

```bash
git clone <repo-url>
cd bunny2
bun install --frozen-lockfile
```

`bun install` populates `node_modules` for the root and every
workspace (`apps/*`, `packages/*`). The lockfile is `bun.lock` — keep
it committed.

If your `bun install` produces a different `bun.lock`, your Bun
version is probably newer than the project pins. Match the version in
`engines.bun` or in the CI workflow before committing the lockfile.

---

## Verify the install

Run the recommended pre-PR check sequence (`AGENTS.md` §Pull Requests):

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run i18n:check
bun run docs:check
bun run build
```

If all eight succeed on a fresh clone, your environment is good.

---

## Environment variables

bunny2 reads these at startup. None is required for a default dev run;
they exist so the Electron sidecar and tests can inject values without
editing `config.json`.

| Variable              | Purpose                                                                                                             | Default                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `BUNNY2_CONFIG`       | Absolute path to a `config.json`. If unset, the loader looks for `./config.json` next to `cwd`.                     | Unset (schema defaults are used).      |
| `BUNNY2_DATA_DIR`     | Absolute or relative path to the data-dir. Wins over the config value. Used by the smoke test and Electron sidecar. | Value from `config.json` or `./.data`. |
| `BUNNY2_HTTP_HOST`    | Override the HTTP bind host.                                                                                        | `127.0.0.1`                            |
| `BUNNY2_HTTP_PORT`    | Override the HTTP port. Electron probes a free port and injects it here (ADR 0004 §4).                              | `4317`                                 |
| `BUNNY2_DEV`          | Set by the desktop dev orchestrator. Used by Electron to load the Vite dev URL instead of the bundled `file://`.    | Unset.                                 |
| `BUNNY2_SKIP_SIDECAR` | Set by the dev orchestrator so Electron does not spawn its own sidecar — the orchestrator already started one.      | Unset.                                 |
| `BUNNY2_API_BASE`     | Injected into the renderer in dev mode so it talks to the orchestrator's server, not a bundled sidecar.             | Unset.                                 |

For tests, the only one worth knowing is `BUNNY2_DATA_DIR` — the smoke
test uses it to point `loadConfig()` at a temp directory.

---

## Where bunny2 puts your files

When you run the server (dev or packaged), it creates:

| Path                      | Contents                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `<dataDir>/bunny2.sqlite` | Primary DB: `events`, `llm_calls`, `schema_migrations`, `kv_meta` (ADR 0002).    |
| `<dataDir>/lancedb/`      | Empty LanceDB directory (ADR 0003). Populated in phase 4+.                       |
| `<dataDir>/config.json`   | Only in packaged mode — copied from `resources/config.sample.json` on first run. |

In dev, `<dataDir>` defaults to `./.data` (gitignored). In packaged
mode it is the per-user Electron `userData` directory; see
`docs/dev/architecture/packaging.md` for the per-OS path.

---

## Troubleshooting

- **`bun install` fails with a lockfile conflict.** Make sure your
  Bun version matches `engines.bun`. Re-run with `--frozen-lockfile`
  and inspect the error.
- **`bun test` hangs on Windows.** Ensure no antivirus is locking the
  temp dir; the smoke test creates and tears down temp dirs.
- **`bun run build` fails inside `apps/desktop`.** That workspace's
  `build` only compiles main + preload (`tsc -p .`). It does **not**
  fetch the Bun runtime. For a full packaged build, use
  `bun run package`, which chains `package:prepare` first.
- **LanceDB native module fails to load.** See
  `docs/dev/follow-ups/lancedb-windows.md`.
