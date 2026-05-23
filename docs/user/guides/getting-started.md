# Getting started with bunny2

bunny2 is a portable, self-hosted personal assistant that runs on your
own machine. This guide takes you from a downloaded portable build to
sending your first chat message.

> Developers: see `docs/dev/setup/installation.md` for the from-source
> workflow.

---

## 1. Download

Grab the portable artifact for your operating system from your team's
release channel:

| OS      | File                                            |
| ------- | ----------------------------------------------- |
| macOS   | `bunny2-<version>-<arch>.dmg` or `.zip`         |
| Linux   | `bunny2-<version>-<arch>.AppImage` or `.tar.gz` |
| Windows | `bunny2-<version>-portable.exe` or `.zip`       |

No installer is needed. The artifact is self-contained: the Bun
runtime, the bundled server, the renderer, and a sample config are all
inside.

---

## 2. Launch

### macOS

1. Open the `.dmg` and drag `bunny2.app` to `/Applications` (or any
   folder).
2. The first time you launch, macOS shows a Gatekeeper warning
   because phase 1 of bunny2 is not yet signed or notarized.
   Right-click the app and choose **Open** to bypass it. (We are
   tracking a fix in the project follow-ups.)
3. The bunny2 window opens at 1280×800.

### Linux

1. Make the AppImage executable: `chmod +x bunny2-<version>.AppImage`.
2. Double-click the AppImage, or run it from a terminal.

### Windows

1. Double-click `bunny2-<version>-portable.exe`.
2. SmartScreen may show a warning the first time. Click **More info →
   Run anyway**. (Signing is tracked in the project follow-ups.)

---

## 3. First-run

On the first launch bunny2 creates a per-user data directory and
copies a sample config into it:

| OS      | Data directory                          |
| ------- | --------------------------------------- |
| macOS   | `~/Library/Application Support/bunny2/` |
| Linux   | `~/.config/bunny2/`                     |
| Windows | `%APPDATA%\bunny2\`                     |

Inside, you will find:

- `config.json` — copied from the bundled sample. Edit it to change
  the HTTP port, point the LLM at a real OpenAI-compatible endpoint,
  or change retention windows.
- `bunny2.sqlite` — your primary database. Created on the first chat;
  contains your event log and LLM telemetry.
- `lancedb/` — reserved for the vector store. Empty until later
  product versions populate it.

---

## 4. First login and password change

The very first time you launch bunny2, the server prints a one-time
**initial admin password** to its console window. The message looks
like:

```
   username: admin
   password: <24-char random string>
```

This is printed **once** — copy it before launching the UI.

1. In the bunny2 window, click **Sign in**.
2. Enter `admin` as the username and paste the printed password.
3. bunny2 sends you straight to the **Change password** screen. You
   cannot reach any other screen until you rotate.
4. Pick a password that is at least 12 characters long and contains
   at least one non-letter character. Submit.

After that you land on the main app.

If you administer bunny2 for others — creating extra users, managing
groups, resetting forgotten passwords — see the admin guide:
[`admin-managing-users.md`](./admin-managing-users.md).

---

## 5. Status screen

After launch, the **Status** view shows:

- Whether the server is running (`ok: true`).
- Where your data directory lives.
- The SQLite schema version.
- The LLM endpoint configured (default: `mock://echo`, a built-in
  deterministic mock).
- How many LLM calls bunny2 has made so far.

If `ok` is not `true`, the bottom of the screen shows the error key.
The most common cause is the server sidecar failing to start — see
the troubleshooting section below.

---

## 6. Send your first chat message

1. Switch to the **Chat** view.
2. Type `hello` and submit.
3. bunny2 responds with `echo: hello`. The default config points the
   LLM at the built-in mock provider, so responses are deterministic
   and free.

Behind the scenes, every chat round-trip:

1. Records a `chat.requested` event in `bunny2.sqlite`.
2. Calls the LLM provider configured in `config.json`.
3. Writes a full row to `llm_calls` (request, response, tokens,
   latency).
4. Records a `chat.responded` (or `chat.failed`) event.

So your full conversation history is in one file you own.

---

## 7. Connecting a real LLM

Edit `config.json` and change:

```json
{
  "llm": {
    "endpoint": "https://api.openai.com/v1",
    "apiKey": "sk-…",
    "defaultModel": "gpt-4o-mini"
  }
}
```

Any OpenAI-compatible endpoint works — OpenAI itself, a local Ollama,
LM Studio, vLLM, or another server that speaks the same Chat
Completions shape. Restart bunny2 for the change to take effect.

Your API key is stored locally in `config.json`; it never leaves your
machine except to the endpoint you configured.

---

## 8. Resetting / removing bunny2

bunny2 keeps **everything** under the data directory listed above. To
reset, close the app and delete that directory. To uninstall, also
delete the app artifact you downloaded.

---

## 9. Troubleshooting

- **"Network error" or the Status view shows the server is down.**
  Close bunny2 and re-launch. On macOS, check that the bundled Bun
  binary is still executable (the OS occasionally strips the flag on
  zip round-trips). On Windows, ensure another process is not bound
  to the same port; bunny2 picks a free one automatically, but
  aggressive firewalls can still block loopback traffic.
- **Chat replies look canned (`echo: …`).** That is the default mock
  provider. Edit `config.json` to point at a real LLM (section 6).
- **Where do I see what bunny2 did?** Open `bunny2.sqlite` with any
  SQLite viewer. The `events` table is your audit log; `llm_calls`
  has the full prompt/response for every LLM round-trip.

For deeper issues, see the developer troubleshooting notes in
`docs/dev/setup/installation.md` or open an issue with the team.
