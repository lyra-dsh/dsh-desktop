# dsh-desktop

Wrap the [`dsh`](https://github.com/deepseek-ai/deepseek-harness) CLI in a
[Tauri v2](https://v2.tauri.app/) macOS window, so the DeepSeek Harness web UI
runs as a native desktop app instead of a browser tab.

On launch the app spawns `dsh` as a child process, waits until its web server
is listening on `127.0.0.1`, then loads that URL in a WebView window. Closing the
window (X) **hides** it and the app keeps running behind a menu-bar (tray) icon.
The tray menu offers **Show**, **Reload Page** (reload the web UI without
restarting dsh), **Restart** (relaunch the app, restarting dsh too), and **Quit**;
a single left-click on the tray icon also brings the window back. dsh is only
terminated when the app actually quits or restarts. The default profile is `web`.

## Prerequisites

- macOS (build/test target for now; the code is portable but Windows/Linux are
  not first-class yet).
- [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/) for the Tauri CLI.
- [Rust toolchain](https://rustup.rs/) (stable) for the `src-tauri` crate.
- [Xcode Command Line Tools](https://developer.apple.com/xcode/) for macOS builds.
- The `dsh` command on the machine (or point `dshBin` at it), and the profile you
  want to run installed under `$DSH_HOME/profiles`.

> The `dsh` binary is **not** bundled. It is resolved at runtime from the
> explicit config, an env var, or well-known locations (see below).

## Quick start

```bash
npm install        # or: pnpm install
pnpm tauri dev     # build + run in dev mode
pnpm tauri build   # produce the .app / .dmg under src-tauri/target/release/bundle
```

Without any config the app runs: `dsh --profile web --host 127.0.0.1 --no-open`.

## Configuration

The app reads a config file at
`~/.config/lyra-dsh/config.json` (honoring `$XDG_CONFIG_HOME` when set). On the
**first run** the app creates that file with defaults if it's missing, so you can
open it and edit directly. Set the `DSH_DESKTOP_CONFIG` env var to point
somewhere else entirely (handy for testing). Missing keys fall back to the same
defaults.

```jsonc
{
  "profile": "web",        // dsh profile to boot (expects a web-serving profile)
  "dshBin": null,          // path or command name of the dsh binary; null = auto-detect
  "host": "127.0.0.1",     // --host for the web surface
  "port": null,            // null=default(3080); a number pins it; 0=OS assigns a free port
  "openBrowser": false,    // false → append --no-open (keeps the UI in-window)
  "extraArgs": []          // extra dsh args, appended verbatim (e.g. ["--trusted-host","app.internal"])
}
```

Resulting argv (defaults shown):

```text
dsh --profile web --host 127.0.0.1 --no-open [extraArgs...]
```

Because the app does not get a shell PATH when launched from the dock, it
resolves `dsh` in this order:

1. `config.json` → `dshBin`
2. env `DSH_DESKTOP_DSH_BIN`
3. `~/.nvm/versions/node/*/bin/dsh` (newest), `~/.local/bin/dsh`, `~/.bun/bin/dsh`,
   `/opt/homebrew/bin/dsh`, `/usr/local/bin/dsh`
4. `PATH` lookup

The child also gets a PATH containing `dsh`'s directory, the nvm node `bin`,
homebrew, and the system dirs, so `node` and friends are reachable.

## Development notes

- The `build.frontendDist` is a placeholder only: the actual UI is the dsh web
  server. The window is created **after** readiness, pointed at the resolved
  `http://127.0.0.1:<port>`.
- Readiness is detected from dsh's stdout (`dsh web: http://127.0.0.1:<port>`),
  with a fallback that probes `127.0.0.1:<port>` for the default/configured port
  (used when `port: 0` cannot be known in advance).
- `--no-open` is appended unless `openBrowser` is true.
- macOS ATS local networking is enabled via `src-tauri/Info.plist`
  (`NSAllowsLocalNetworking`) so `http://127.0.0.1` loads in the WebView.
- The canonical app icon is `src-tauri/icon.icns`. All other formats (PNG sizes,
  ICO) are derived from it and live in `src-tauri/icons/`; regenerate them with
  `pnpm icons`. The macOS bundle uses `src-tauri/icon.icns` directly.

## Troubleshooting

- **`dsh` not found on launch** — set `dshBin` in `config.json` (or `DSH_DESKTOP_DSH_BIN`)
  to the absolute path of the dsh binary, e.g.
  `~/.nvm/versions/node/v24.15.0/bin/dsh`.
- **App opens nothing / shows an error dialog** — the web profile printed no URL and
  the fallback port probe failed. Check the profile actually serves a web UI, and
  that `dsh --profile <name>` works from your terminal first.
- **A package-manager CLI quirk (dev only)** — in some shells `pnpm tauri …` may
  resolve `process.execPath` incorrectly and error with a stray path as a
  subcommand. This is environment-specific, not a project bug; work around it by
  invoking the CLI directly:
  `node node_modules/@tauri-apps/cli/tauri.js dev` (or `build` / `icon`).

## Not in scope (yet)

Settings UI, system tray, native file/directory pickers, download interception,
auto-update, multi-window, and hosting OAuth popups. External links currently
stay inside the WebView. Multiple concurrent instances are not coordinated — run
one at a time, or set `port` to a distinct value / `0`.
