'use strict'

/**
 * Electron 实现：ElectronDesktopRuntime，implements DesktopRuntime（协议）。
 *
 * 只依赖 electron + 协议类型；不依赖 dsh，也不依赖 Cordis。
 * 它把窗口/托盘/通知/对话框/外部链接/外观/生命周期这些"壳子能力"用 Electron API 实现，
 * 并把"壳子侧发生的事"（托盘点击、关闭请求、退出请求、渲染结果、主题变化）通过
 * `subscribe` 事件上报给 Host。决策权在 Host，壳子不自作主张。
 */

const {
  app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage, Notification, nativeTheme, powerSaveBlocker,
} = require('electron')
const fs = require('node:fs')

const WEB_PREFERENCES = { nodeIntegration: false, contextIsolation: true, sandbox: true }

/** 把一份 DesktopTrayItem[] 转成 Electron Menu 模板；点击时回传 itemId。 */
function buildTrayTemplate(items, onActivate) {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' }
    const entry = {
      label: item.label,
      type: item.type || 'normal',
      enabled: item.enabled !== false,
      click: () => onActivate(item.id),
    }
    if (item.checked !== undefined) entry.checked = item.checked
    if (item.submenu) entry.submenu = buildTrayTemplate(item.submenu, onActivate)
    return entry
  })
}

/** 包一个 BrowserWindow 成 DesktopWindowHandle 形状。 */
function makeHandle(id, win) {
  return {
    id,
    show: () => win.show(),
    hide: () => win.hide(),
    close: () => win.close(),
    reload: () => win.webContents.reload(),
    setTitle: (title) => win.setTitle(title),
  }
}

class ElectronDesktopRuntime {
  constructor(config) {
    this.config = config
    this.platform = process.platform === 'darwin' ? 'darwin'
      : process.platform === 'win32' ? 'win32'
        : 'linux'

    this.mainWindow = null
    this.tray = null
    this.windows = new Map()
    this.listeners = new Set()
    this.notifications = new Set()
    this.badgeState = 'none'
    this.keepAwakeId = null
    this.keepAwakeEnabled = true
    this.keepAwakeActive = false
    this.isQuitting = false

    // 用户触发退出（Cmd+Q / 系统退出）→ 上报，由 Host 清理后回 quit()。
    app.on('before-quit', (event) => {
      if (this.isQuitting) return
      this.isQuitting = true
      event.preventDefault()
      this.emit({ type: 'quit/requested' })
    })
  }

  // ---- 事件（Shell → Host）----
  emit(event) {
    for (const fn of [...this.listeners]) {
      try { fn(event) } catch (cause) { console.error('[desktop-electron] listener error:', cause) }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ---- 主窗口（id 'main'）----
  createMainWindow() {
    const cfg = this.config
    let origin = null
    try { origin = new URL(cfg.url).origin } catch {}

    const win = new BrowserWindow({
      title: cfg.windowTitle,
      width: cfg.width,
      height: cfg.height,
      minWidth: cfg.minWidth,
      minHeight: cfg.minHeight,
      show: false,
      webPreferences: WEB_PREFERENCES,
    })

    // 外部链接：target="_blank" / window.open（含 iframe）→ 系统浏览器。
    win.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternal(url)
      return { action: 'deny' }
    })
    // 顶层导航到外部源 → 系统浏览器；同源 SPA 导航放行。
    win.webContents.on('will-navigate', (event, url) => {
      let o = null
      try { o = new URL(url).origin } catch { return }
      if (origin !== null && o !== origin) {
        event.preventDefault()
        this.openExternal(url)
      }
    })

    // 关闭（X）→ 上报，Host 决定隐藏还是退出。
    win.on('close', (event) => {
      if (this.isQuitting) return
      event.preventDefault()
      this.emit({ type: 'window/close-requested', windowId: 'main' })
    })
    win.on('show', () => this.emit({ type: 'window/visibility', windowId: 'main', visible: true }))
    win.on('hide', () => this.emit({ type: 'window/visibility', windowId: 'main', visible: false }))
    // 用户看到窗口（聚焦）→ 清除托盘状态点。
    win.on('focus', () => this.clearBadge())

    // 渲染结果上报。
    win.webContents.once('did-finish-load', () => {
      this.emit({ type: 'renderer/boot', windowId: 'main', status: 'ok' })
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      this.emit({ type: 'renderer/boot', windowId: 'main', status: 'failed', error: desc || String(code) })
    })

    win.once('ready-to-show', () => win.show())
    // ready-to-show 可能不触发，兜底显示。
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show() }, 5000)

    this.mainWindow = win
    this.windows.set('main', win)
    win.loadURL(cfg.url)
    return win
  }

  // ---- 主窗口操作 ----
  show() { this._ifAlive(this.mainWindow, (w) => { w.show(); w.focus() }) }
  hide() { this._ifAlive(this.mainWindow, (w) => w.hide()) }
  reload() { this._ifAlive(this.mainWindow, (w) => w.webContents.reload()) }
  setTitle(title) { this._ifAlive(this.mainWindow, (w) => w.setTitle(title)) }

  // ---- 多窗口 ----
  async openWindow(spec) {
    const id = spec.id || `window-${this.windows.size + 1}`
    const win = new BrowserWindow({
      title: spec.title,
      width: spec.width,
      height: spec.height,
      show: true,
      webPreferences: WEB_PREFERENCES,
    })
    this.windows.set(id, win)
    win.webContents.setWindowOpenHandler(({ url }) => { this.openExternal(url); return { action: 'deny' } })
    win.on('closed', () => { this.windows.delete(id) })
    win.webContents.once('did-finish-load', () => {
      this.emit({ type: 'renderer/boot', windowId: id, status: 'ok' })
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      this.emit({ type: 'renderer/boot', windowId: id, status: 'failed', error: desc || String(code) })
    })
    win.loadURL(spec.url)
    return makeHandle(id, win)
  }

  getWindow(id) {
    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) return null
    return makeHandle(id, win)
  }

  // ---- 托盘 ----
  setTray(items) {
    const menu = Menu.buildFromTemplate(buildTrayTemplate(items, (id) => {
      this.emit({ type: 'tray/item-activated', itemId: id })
    }))
    if (!this.tray) {
      let image
      const p = this.config.trayIconPath
      if (p && fs.existsSync(p)) image = nativeImage.createFromPath(p)
      this.tray = new Tray(image)
      this.tray.setToolTip(this.config.productName)
      this.tray.on('click', () => this.emit({ type: 'tray/activated' }))
    }
    this.tray.setContextMenu(menu)
  }

  // ---- 托盘状态点（红/黄/绿）----
  setBadge(state) {
    const priority = { none: 0, unread: 1, approval: 2, error: 3 }
    // 未读（绿点）只在用户没在看窗口时才标；正在看就不标。
    if (state === 'unread' && this._isWindowFocused()) return
    if ((priority[state] || 0) > (priority[this.badgeState] || 0)) {
      this.badgeState = state
      this._updateTrayIcon()
    }
  }

  clearBadge() {
    if (this.badgeState === 'none') return
    this.badgeState = 'none'
    this._updateTrayIcon()
  }

  _isWindowFocused() {
    const w = this.mainWindow
    return !!(w && !w.isDestroyed() && w.isFocused())
  }

  _badgeIconPath(state) {
    const base = this.config.trayIconPath || ''
    if (state === 'none') return base
    const color = { error: 'red', approval: 'yellow', unread: 'green' }[state]
    return base.replace(/tray\.png$/, `tray-${color}.png`)
  }

  _updateTrayIcon() {
    if (!this.tray) return
    const p = this._badgeIconPath(this.badgeState)
    if (p && fs.existsSync(p)) {
      this.tray.setImage(nativeImage.createFromPath(p))
    }
  }

  // ---- 电源 ----
  setKeepAwake(active) {
    this.keepAwakeActive = active
    this._applyKeepAwake()
  }

  /** 托盘 checkbox「防止休眠」点击时切换功能开关（默认开启）。 */
  toggleKeepAwake() {
    this.keepAwakeEnabled = !this.keepAwakeEnabled
    this._applyKeepAwake()
  }

  isKeepAwakeEnabled() {
    return this.keepAwakeEnabled
  }

  _applyKeepAwake() {
    const shouldBlock = this.keepAwakeEnabled && this.keepAwakeActive
    if (shouldBlock && this.keepAwakeId == null) {
      // prevent-app-suspension：阻止系统休眠（保持网络），但不阻止息屏。
      this.keepAwakeId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!shouldBlock && this.keepAwakeId != null) {
      powerSaveBlocker.stop(this.keepAwakeId)
      this.keepAwakeId = null
    }
    if (this.tray) {
      this.tray.setToolTip(shouldBlock ? `${this.config.productName} — 运行中（防止休眠）` : this.config.productName)
    }
  }

  // ---- 通知 ----
  notify(notification) {
    console.log('[desktop-electron] notify:', notification.title, '| supported:', Notification.isSupported(), '| sound:', notification.sound)
    if (!Notification.isSupported()) return
    const n = new Notification({ title: notification.title, body: notification.body, sound: notification.sound })
    n.once('click', () => this.show())
    // 保留引用，防止 Notification 对象被 GC 回收导致通知不显示（Electron 经典坑）。
    this.notifications.add(n)
    n.once('close', () => this.notifications.delete(n))
    n.show()
  }

  // ---- 对话框 ----
  async pickDirectory(options) {
    const result = await dialog.showOpenDialog(this._dialogParent(), {
      properties: ['openDirectory', 'createDirectory'],
      title: options?.title,
      defaultPath: options?.defaultPath,
    })
    return result.canceled ? null : (result.filePaths[0] || null)
  }

  async showMessageBox(options) {
    const result = await dialog.showMessageBox(this._dialogParent(), {
      type: options.type,
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons,
      defaultId: options.defaultId,
      cancelId: options.cancelId,
    })
    return { response: result.response }
  }

  // ---- 外部 ----
  openExternal(url) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') shell.openExternal(parsed.href)
    } catch { /* 非法 URL，忽略 */ }
  }

  // ---- 外观 ----
  setTheme(source) { nativeTheme.themeSource = source }
  setLocale(locale) { this._locale = locale }

  // ---- 生命周期 ----
  quit() { this.isQuitting = true; app.quit() }
  restart() { app.relaunch(); app.exit(0) }
  prepareToQuit() { this.isQuitting = true }

  // ---- 内部工具 ----
  _ifAlive(win, fn) { if (win && !win.isDestroyed()) fn(win) }
  _dialogParent() { return (this.mainWindow && !this.mainWindow.isDestroyed()) ? this.mainWindow : undefined }
}

module.exports = { ElectronDesktopRuntime }
