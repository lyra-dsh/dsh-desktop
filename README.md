# dsh-desktop

Wrap the [`dsh`](https://github.com/deepseek-ai/deepseek-harness) web UI in an
[Electron](https://www.electronjs.org/) macOS window, so the DeepSeek Harness web
UI runs as a native desktop app instead of a browser tab.

The app **bundles `@deepseek-ai/dsh`** and runs it with **Electron's own Node
runtime** (via the `runAsNode` fuse + `ELECTRON_RUN_AS_NODE=1`), so you do **not**
need to install a system `dsh` or a separate Node. On launch it spawns dsh's
`lib/bin.js` as a child process, waits until its web server is listening on
`127.0.0.1`, then loads that URL in a `BrowserWindow`. Closing the window (X)
**hides** it and the app keeps running behind a menu-bar (tray) icon. The tray
menu offers **Show**, **Reload Page**, **Restart**, and **Quit**; a single
left-click on the tray icon brings the window back. dsh is only terminated when
the app actually quits or restarts. External links open in your default browser:
`target="_blank"` / `window.open` requests are redirected to the browser, and
top-level navigations to a non-loopback `http(s)` origin are handed off too. The
default profile is `web`.

## Prerequisites

- macOS (build/test target for now; the code is portable but Windows/Linux are
  not first-class yet).
- [Node.js](https://nodejs.org/) + npm (for development and packaging only — end
  users do not need them).

## Quick start

```bash
npm install        # installs Electron, electron-builder, and the bundled dsh runtime
npm run dev        # run the app in dev mode (electron .)
npm run build      # produce the .app / .dmg under release/
npm test           # unit tests (node --test)
```

> The Electron binary is downloaded lazily on the first `npm run dev`/`build`
> (Electron no longer ships a postinstall script). It needs network access once.

Without any config the app runs: `dsh --profile web --host 127.0.0.1 --no-open`.

## Configuration

The app reads a config file at `~/.config/lyra-dsh/config.json` (honoring
`$XDG_CONFIG_HOME` when set). On the **first run** the app creates that file with
defaults if it's missing. Set the `DSH_DESKTOP_CONFIG` env var to point somewhere
else entirely (handy for testing). Missing keys fall back to the same defaults.

```jsonc
{
  "profile": "web",        // dsh profile to boot (expects a web-serving profile)
  "dshBin": null,          // null = use the bundled dsh; a path/command = spawn that external dsh instead
  "host": "127.0.0.1",     // --host for the web surface
  "port": null,            // null=default(3080); a number pins it; 0=OS assigns a free port
  "openBrowser": false,    // false → append --no-open (keeps the UI in-window)
  "extraArgs": [],         // extra dsh args, appended verbatim (e.g. ["--trusted-host","app.internal"])
  "editor": null           // reserved; not consumed yet
}
```

Resulting argv (defaults shown):

```text
dsh --profile web --host 127.0.0.1 --no-open [extraArgs...]
```

## How dsh runs

The `@deepseek-ai/dsh` runtime (CLI, web app, and web frontend) is installed as a
production dependency and packed into the app. At startup the main process:

1. Resolves the bundled `@deepseek-ai/dsh/lib/bin.js` (mapped from `app.asar` to
   the unpacked `app.asar.unpacked` tree).
2. Spawns it as a child process using Electron's executable with
   `ELECTRON_RUN_AS_NODE=1` and `--expose-internals`. The `runAsNode` Electron
   fuse is kept enabled (`electronFuses.runAsNode: true`), so the Electron binary
   behaves as plain Node — including when dsh itself re-spawns `process.execPath`
   for subagents, sandboxes, and tools. `--expose-internals` is required because
   dsh's loader/HMR service relies on Node internals that `node-addon-require-builtin`
   can only expose under a real Node, not Electron's patched builtin registry.
3. Waits for dsh's stdout URL, then loads it in the window.

`dshBin` (or `DSH_DESKTOP_DSH_BIN`) is an escape hatch for development: when set,
the app spawns that external `dsh` command through its shebang instead of the
bundled runtime.

The `@deepseek-ai/dsh` runtime composes itself through `peerDependencies`, which
electron-builder's production collection does not bundle. `package.json`
therefore lists every `@deepseek-ai/*` package as an explicit `dependency` (with
exact versions) so the packaged app contains the full runtime tree.

## Development notes

- The window is created **after** readiness, pointed at the resolved
  `http://127.0.0.1:<port>`.
- Readiness is detected from dsh's stdout (`dsh web: http://127.0.0.1:<port>/?token=…`).
  dsh web ≥ v0.1.2 authenticates the browser UI with a per-process launch token
  carried in the URL query, so the app captures the full URL (token included) and
  loads it once — the server then mints a persistent cookie and redirects to `/`.
  A fallback probes `127.0.0.1:<port>` for the default/configured port (used when
  `port: 0` cannot be known in advance); note that fallback URL has no token and
  therefore cannot authenticate.
- `--no-open` is appended unless `openBrowser` is true.
- External links are opened in the OS default browser via `shell.openExternal`:
  `setWindowOpenHandler` denies all new-window requests (`target="_blank"`,
  `window.open`, incl. iframes) and opens them externally, and `will-navigate`
  intercepts top-level navigations to a different origin. Same-origin (in-app)
  navigation and iframe loads are left untouched.
- Native modules in the dsh tree (`node-pty`, `sharp`, `koffi`,
  `node-addon-require-builtin`) are N-API, so they are ABI-stable across Node and
  Electron and need no rebuild (`npmRebuild: false` skips electron-builder's
  native rebuild, which would otherwise try to compile them against Electron's
  ABI and require Xcode CLT). `asarUnpack: ["node_modules/**"]` keeps them (and
  the whole dsh tree) on disk where they can be spawned/`dlopen`ed.
- The canonical app icon is `build/icon.icns` (used by the macOS bundle). The tray
  uses `build/trayTemplate.png` (+`@2x`), marked as a macOS template image.

## Troubleshooting

- **The bundled dsh runtime is missing or incomplete** — reinstall with
  `npm install` (the `@deepseek-ai/dsh` tree must be present under `node_modules`).
- **App opens nothing / shows an error dialog** — the web profile printed no URL
  and the fallback port probe failed. Check the profile actually serves a web UI,
  and that `dsh --profile <name>` works from your terminal first.
- **A native module failed to load** — the runtime may have been packaged without
  unpacking; make sure `asarUnpack` covers `node_modules/**`.

## Not in scope (yet)

Settings UI, native file/directory pickers, download interception, auto-update,
multi-window, and hosting OAuth popups. Multiple concurrent instances are not
coordinated — run one at a time, or set `port` to a distinct value / `0`.
Universal (arm64 + x64) macOS builds and code signing/notarization are follow-ups.
