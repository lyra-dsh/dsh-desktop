'use strict'

// System-tray (menu bar) icon and its menu (Electron port of tray.rs).

const { Tray, Menu, nativeImage } = require('electron')
const fs = require('node:fs')

/** Show and focus the main window (created lazily by the boot flow). */
function showMain(app, getWindow) {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
  }
}

/** Reload the dsh web UI without restarting dsh. */
function reloadMain(getWindow) {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.reload()
}

/**
 * Build the tray icon + menu.
 * @param {import('electron').App} app
 * @param {{ getWindow: () => Electron.BrowserWindow | undefined }} ctx
 * @param {string} trayIconPath - path to the 16x16 tray PNG (with `@2x` sibling).
 */
function setup(app, ctx, trayIconPath) {
  const template = [
    { label: 'Show dsh Window', click: () => showMain(app, ctx.getWindow) },
    { label: 'Reload Page', click: () => reloadMain(ctx.getWindow) },
    { label: 'Restart', click: () => { app.relaunch(); app.quit() } },
    { type: 'separator' },
    { label: 'Quit dsh Desktop', click: () => app.quit() },
  ]
  const menu = Menu.buildFromTemplate(template)

  let image
  if (trayIconPath && fs.existsSync(trayIconPath)) {
    // Show the app icon as-is (colored), matching the Tauri tray behavior.
    image = nativeImage.createFromPath(trayIconPath)
  }

  const tray = new Tray(image)
  tray.setToolTip('dsh Desktop')
  tray.setContextMenu(menu)
  // Left-click brings the window back.
  tray.on('click', () => showMain(app, ctx.getWindow))
  return tray
}

module.exports = { setup, showMain }
