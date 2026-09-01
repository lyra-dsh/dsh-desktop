'use strict'

// dsh desktop (Electron): run the bundled dsh CLI under Electron's Node and load
// its web UI in a native window (port of lib.rs + main.rs).
//
// On launch we read the JSON config, spawn dsh's `lib/bin.js` with
// `ELECTRON_RUN_AS_NODE=1` (so the Electron binary acts as Node, and dsh's own
// `process.execPath`-spawned subagents keep working), wait until the web server
// answers, then load that URL in a BrowserWindow. Closing the window hides it
// while the app keeps running behind a tray icon. Quitting kills the whole dsh
// process group.

const { app, BrowserWindow, dialog, shell } = require('electron')
const path = require('node:path')
const config = require('./src/config')
const dsh = require('./src/dsh')
const { DshState } = require('./src/state')
const tray = require('./src/tray')

// Resolve the tray icon to its unpacked physical path (nativeImage cannot read
// from inside app.asar), matching how the bundled dsh bin.js is resolved.
const TRAY_ICON_PATH = dsh.unpackedAsarPath(path.join(__dirname, 'build', 'tray.png'))

let mainWindow = null
let loadedOrigin = null
let isQuitting = false
let trayIcon = null

function openExternal(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(parsed.href)
    }
  } catch {
    // Invalid URL: ignore.
  }
}

function createWindow(url) {
  try {
    loadedOrigin = new URL(url).origin
  } catch {
    loadedOrigin = null
  }

  const win = new BrowserWindow({
    title: 'dsh',
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  mainWindow = win

  // target="_blank" / window.open (incl. inside iframes): open in the system
  // browser instead of spawning a new window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  // Top-level navigation to an external origin: hand off to the browser.
  // Same-origin (SPA) navigation and the initial token URL load are left alone.
  win.webContents.on('will-navigate', (event, url) => {
    let origin = null
    try {
      origin = new URL(url).origin
    } catch {
      return
    }
    if (loadedOrigin !== null && origin !== loadedOrigin) {
      event.preventDefault()
      openExternal(url)
    }
  })

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.once('ready-to-show', () => win.show())
  // Fallback in case ready-to-show never fires.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 5000)

  win.loadURL(url)
  return win
}

function getWindow() {
  return mainWindow
}

function showMain() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
}

function showError(detail) {
  const trimmed = String(detail || '').slice(0, 4000)
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'dsh Desktop',
    message: 'dsh failed to start.',
    detail: trimmed,
  })
  app.exit(1)
}

async function boot() {
  const cfg = config.loadForApp()
  const entry = dsh.resolveEntry(cfg)
  const child = dsh.spawnDsh(cfg, entry)
  const state = new DshState(child.pid)

  trayIcon = tray.setup(app, { getWindow }, TRAY_ICON_PATH)

  app.on('activate', showMain)
  app.on('window-all-closed', () => {
    // Keep running behind the tray on macOS.
  })
  app.on('before-quit', (event) => {
    if (isQuitting) return
    isQuitting = true
    event.preventDefault()
    state.killGracefully(1500, () => app.exit(0))
  })

  try {
    const url = await dsh.waitForReady(child, cfg)
    createWindow(url)
  } catch (err) {
    showError(err.message)
  }
}

app.whenReady().then(() => {
  boot().catch((err) => showError(err.message))
})

// Route external signals through the normal quit path so the dsh process group
// is torn down (SIGKILL is uncatchable and will orphan the child, as before).
process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
