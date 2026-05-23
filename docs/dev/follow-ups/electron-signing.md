# Electron code signing + notarization

- Status: open
- Owner: phase 1+ desktop pipeline

## What remains

- macOS: configure `electron-builder` with a Developer ID
  certificate, enable hardened runtime, run `notarytool` against the
  built `.app` / `.dmg`, and staple the result.
- Windows: configure a code-signing certificate (EV preferred) and
  sign the `portable.exe` so SmartScreen does not warn first-time users.

## Why not done now

Phase 1.6 prioritised packaging mechanics over signing identities. The
Apple Developer ID and a Windows signing cert require admin action
that is out of scope for the agent.

## Next step

When the certificates are available, set the relevant
electron-builder fields:

- macOS: `mac.identity`, `mac.hardenedRuntime: true`,
  `afterSign` hook for notarization.
- Windows: `win.certificateFile` + `win.certificatePassword` or a
  signing service.

Update `docs/dev/testing/phase-01-electron-manual.md` to drop the
Gatekeeper / SmartScreen workaround steps once signing is in place.

## Related files / docs

- `apps/desktop/electron-builder.yml`
- `docs/dev/decisions/0004-electron-as-thin-wrapper.md`
- `docs/dev/testing/phase-01-electron-manual.md`
