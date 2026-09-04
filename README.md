# dsh-desktop

A **generic desktop shell** for the [dsh](https://github.com/deepseek-ai/deepseek-harness)
web UI: wrap any dsh in a native [Electron](https://www.electronjs.org/) window
instead of a browser tab. The shell itself has **zero dsh runtime dependency** —
it detects a dsh already on your machine, and only if none is found installs a
**private copy** into the app's data directory on first launch.

On launch the app spawns dsh's `lib/bin.js` as a child process, waits until its
web server is listening on `127.0.0.1`, then loads that URL in a `BrowserWindow`.
Closing the window (X) **hides** it and the app keeps running behind a menu-bar
(tray) icon. The tray menu offers **Show**, **Reload Page**, **Restart**, and
**Quit**; a single left-click on the tray icon brings the window back. dsh is only
terminated when the app actually quits or restarts. External links open in your
default browser: `target="_blank"` / `window.open` requests are redirected to the
browser, and top-level navigations to a non-loopback `http(s)` origin are handed
off too. The default profile is `web`.

## Prerequisites

- macOS (build/test target for now; the code is portable but Windows/Linux are
  not first-class yet).
- [Node.js](https://nodejs.org/) + npm (for development and packaging only — end
  users do not need them).

## Quick start

```bash
npm install        # installs Electron, electron-builder, and the shell workspace packages
npm run dev        # run the app in dev mode (electron .)
npm run build      # produce the .app / .dmg under release/
npm test           # unit tests (node --test)
```

> The Electron binary is downloaded lazily on the first `npm run dev`/`build`
> (Electron no longer ships a postinstall script). It needs network access once.

Without any config the app runs: `dsh --profile web --host 127.0.0.1 --no-open`.

## How dsh is found and run

The shell does **not** bundle `@deepseek-ai/dsh`. At startup the main process
resolves dsh in this order:

1. **Explicit** — `dshBin` in the config file, or the `DSH_DESKTOP_DSH_BIN`
   environment variable. A path/command here always wins.
2. **System dsh** — a `dsh` on `PATH`.
3. **Private fallback** — if no `dsh` is on `PATH`, the app installs
   `@deepseek-ai/dsh@<pinned>` into `<userData>/dsh` using a bundled `pnpm`
   (run via Electron's Node, `ELECTRON_RUN_AS_NODE=1`). This is cached: once
   installed (a `.installed` marker is written), subsequent launches reuse it.

The resolved dsh is then spawned as a child process:

- A system/explicit dsh runs through its shebang as a normal child process.
- A private (provisioned) dsh is run with Electron's executable under
  `ELECTRON_RUN_AS_NODE=1` plus `--expose-internals`. The `runAsNode` Electron
  fuse is kept enabled (`electronFuses.runAsNode: true`) so the Electron binary
  behaves as plain Node — including when dsh re-spawns `process.execPath` for
  subagents, sandboxes, and tools. `--expose-internals` is required because dsh's
  loader/HMR service relies on Node internals that `node-addon-require-builtin`
  can only expose under a real Node, not Electron's patched builtin registry.

The app then waits for dsh's stdout URL and loads it in the window.

> The private-fallback install needs network access once, and must compile/build
> dsh's native modules (`node-pty`, `sharp`, `koffi`) on the user's machine. It is
> deliberately a *fallback* for users who don't already have dsh; prefer
> installing dsh yourself if you want full control over its version.

## Configuration

The app reads a config file at `~/.config/lyra-dsh/config.json` (honoring
`$XDG_CONFIG_HOME` when set). On the **first run** the app creates that file with
defaults if it's missing. Set the `DSH_DESKTOP_CONFIG` env var to point somewhere
else entirely (handy for testing). Missing keys fall back to the same defaults.

```jsonc
{
  "profile": "web",        // dsh profile to boot (expects a web-serving profile)
  "dshBin": null,          // null = auto (system first, then private install); a path/command = spawn that external dsh instead
  "host": "127.0.0.1",     // --host for the web surface
  "port": 0,               // 0=OS auto-assign (default, avoids port conflicts); a number pins it; null=dsh's own default
  "openBrowser": false,    // false → append --no-open (keeps the UI in-window)
  "notify": true,          // true → OS notification when the agent finishes a turn or needs approval
  "extraArgs": [],         // extra dsh args, appended verbatim (e.g. ["--trusted-host","app.internal"])
  "editor": null           // reserved; not consumed yet
}
```

Resulting argv (defaults shown):

```text
dsh --profile web --patch <userData>/dsh-desktop.patch.yml --host 127.0.0.1 --port 0 --no-open [extraArgs...]
```

## Notifications

When `notify` is true (the default), the app shows an OS notification when the
agent **finishes a turn** or when it **needs your approval**. It does this by
loading two of the shell's own cordis plugins into dsh and talking over the
parent–child IPC channel (dsh is the shell's child process):

1. On startup the shell copies `@omnilyra/desktop-host` + `@omnilyra/desktop-notifications`
   into dsh's profile `node_modules` and writes `dsh-desktop.patch.yml` — a `--patch`
   overlay that inserts both plugins. The shell then launches dsh with that patch
   and an extra `ipc` stdio channel.
2. Inside dsh:
   - `desktop-host` provides `ctx.desktopRuntime` as a proxy whose method calls are
     serialized over `process.send` (the IPC channel).
   - `desktop-notifications` subscribes to dsh's `session/event` (`turn/end` with
     `completed`) and `approval/request` events, calling `ctx.desktopRuntime.notify(...)`.
3. The shell's main process receives the `invoke` message and runs
   `ElectronDesktopRuntime.notify(...)` — a real, shell-owned notification (app
   identity, click-to-focus, cross-platform).

The plugins live outside dsh's profile bundles, so dsh stays a black-box wrapper —
system or private. Set `notify: false` to disable.

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
- The canonical app icon is `build/icon.icns` (used by the macOS bundle). The tray
  uses `build/tray.png` (+`@2x`).

## Architecture

The shell is layered so it can wrap *any* dsh (or a custom dsh you build on it)
without depending on dsh itself. See [`DESIGN.md`](DESIGN.md) for the full
design, the `DesktopRuntime` protocol, multi-window, and the plugin roadmap.

```
packages/
  desktop-protocol/      zero-dependency interfaces (DesktopRuntime, DesktopEvent, DesktopTransport)
  desktop-host/          cordis plugin: provides ctx.desktopRuntime over the child-process IPC channel
  desktop-electron/      Electron implementation of DesktopRuntime
  desktop-notifications/ cordis plugin: session-complete + approval → ctx.desktopRuntime.notify
app/                     composition root: resolve dsh → spawn (with ipc) → window/tray + IPC dispatch
```

## Troubleshooting

- **dsh is not found and the private install failed** — the fallback needs network
  access and a working native toolchain. Install dsh yourself, or set `dshBin` /
  `DSH_DESKTOP_DSH_BIN` to an explicit dsh path.
- **App opens nothing / shows an error dialog** — the web profile printed no URL
  and the fallback port probe failed. Check the profile actually serves a web UI,
  and that `dsh --profile <name>` works from your terminal first.
- **`npm install` fails with `EPERM` in `~/.npm`** — your npm cache contains
  root-owned files (a historical npm bug). Run `sudo chown -R $(id -u):$(id -g) ~/.npm`,
  or use a fresh cache with `npm install --cache /tmp/npm-cache`.

## Not in scope (yet)

Settings UI, native file/directory pickers, download interception, auto-update,
and hosting OAuth popups. Multiple concurrent instances are not coordinated —
run one at a time, or set `port` to a distinct value / `0`. Universal
(arm64 + x64) macOS builds and code signing/notarization are follow-ups.
