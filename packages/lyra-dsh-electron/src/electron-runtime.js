'use strict'

/**
 * Electron 实现：ElectronDesktopRuntime，implements DesktopCapabilities + DesktopShellLifecycle（协议）。
 *
 * 只依赖 electron + 协议类型；不依赖 dsh，也不依赖 Cordis。
 * 它把窗口/托盘/通知/对话框/外部链接/外观/生命周期这些"壳子能力"用 Electron API 实现，
 * 并把"壳子侧发生的事"（托盘点击、关闭请求、退出请求、渲染结果）通过
 * `subscribe` 事件上报给组装根。决策权在组装根，壳子不自作主张。
 */

const {
  app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage, Notification, nativeTheme, powerSaveBlocker, WebContentsView, ipcMain,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')

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
    this.keepAwakeRefs = new Map()
    this.isQuitting = false
    this.updater = null
    this._updaterUnsubscribe = null
    this.overlayView = null
    this.overlayState = 'hidden'
    this._mainOrigin = null
    this._trayItems = new Map()
    this._traySeq = 0
    if (config.updater) this.setUpdater(config.updater)

    // 覆盖层「重启」按钮 → preload → ipcRenderer → 主进程 → 发 restart 请求。
    ipcMain.removeAllListeners('lyra-dsh:overlay-restart')
    ipcMain.on('lyra-dsh:overlay-restart', () => this.emit({ type: 'quit/requested', restart: true }))

    // 用户触发退出（Cmd+Q / 系统退出）→ 上报，由组装根清理后回 prepareToQuit()。
    app.on('before-quit', (event) => {
      if (this.isQuitting) return
      this.isQuitting = true
      event.preventDefault()
      this.emit({ type: 'quit/requested' })
    })
  }

  // ---- 事件（Shell → 组装根）----
  emit(event) {
    for (const fn of [...this.listeners]) {
      try { fn(event) } catch (cause) { console.error('[lyra-dsh-electron] listener error:', cause) }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ---- 主窗口（id 'main'）----
  createMainWindow() {
    const cfg = this.config

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
      const origin = this._mainOrigin
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

    // 只对「从未显示过」兜底显示，避免用户 5 秒内关窗到托盘后又被弹出来。
    let shown = false
    const showOnce = () => { if (!shown && !win.isDestroyed()) { shown = true; win.show() } }
    win.once('ready-to-show', showOnce)
    const showTimer = setTimeout(showOnce, 5000)
    win.once('show', () => { shown = true; clearTimeout(showTimer) })

    this.mainWindow = win
    this.windows.set('main', win)
    try { this._mainOrigin = new URL(cfg.url).origin } catch { this._mainOrigin = null }
    win.loadURL(cfg.url)
    return win
  }

  // ---- 主窗口操作 ----
  show() { this._ifAlive(this.mainWindow, (w) => { w.show(); w.focus() }) }
  hide() { this._ifAlive(this.mainWindow, (w) => w.hide()) }
  reload() { this._ifAlive(this.mainWindow, (w) => w.webContents.reload()) }
  setTitle(title) { this._ifAlive(this.mainWindow, (w) => w.setTitle(title)) }

  // ---- 托盘 ----
  addTrayItem(item) {
    const token = `tray-${++this._traySeq}`
    this._trayItems.set(token, item)
    this._rebuildTrayMenu()
    return token
  }

  removeTrayItem(token) {
    this._trayItems.delete(token)
    this._rebuildTrayMenu()
  }

  _rebuildTrayMenu() {
    if (!this.tray) {
      let image
      const p = this.config.trayIconPath
      if (p && fs.existsSync(p)) image = nativeImage.createFromPath(p)
      this.tray = new Tray(image)
      this.tray.setToolTip(this.config.productName)
      this.tray.on('click', () => this.emit({ type: 'tray/activated' }))
    }
    const items = [...this._trayItems.values()]
    const menu = Menu.buildFromTemplate(buildTrayTemplate(items, (id) => {
      this.emit({ type: 'tray/item-activated', itemId: id })
    }))
    this.tray.setContextMenu(menu)
  }

  // ---- 托盘状态点（红/黄/绿）----
  setBadge(state) {
    const priority = { none: 0, info: 1, attention: 2, error: 3 }
    // info(未读) 与 attention(待审批) 都只在用户没在看窗口时标;error 始终标。
    if ((state === 'info' || state === 'attention') && this._isWindowFocused()) return
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
    const color = { error: 'red', attention: 'yellow', info: 'green' }[state]
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
  setKeepAwake(active, refId = 'default') {
    // 引用计数仲裁:多个驱动方各自持有一格,全释放才真正停止,避免 last-writer-wins 互相覆盖。
    if (active) this.keepAwakeRefs.set(refId, true)
    else this.keepAwakeRefs.delete(refId)
    this.keepAwakeActive = this.keepAwakeRefs.size > 0
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
    console.log('[lyra-dsh-electron] notify:', notification.title, '| supported:', Notification.isSupported(), '| sound:', notification.sound)
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

  // ---- 升级 ----
  /** 注入（或替换）升级器，并把它的状态转成 Shell → 组装根 事件。 */
  setUpdater(updater) {
    if (this._updaterUnsubscribe) { this._updaterUnsubscribe(); this._updaterUnsubscribe = null }
    this.updater = updater || null
    if (this.updater && typeof this.updater.subscribe === 'function') {
      this._updaterUnsubscribe = this.updater.subscribe((status) => this.emit({ type: 'update/state', status }))
    }
  }
  async checkForUpdates() { return this.updater ? this.updater.check() : null }
  async downloadUpdate() { return this.updater ? this.updater.download() : null }
  quitAndInstall() { if (this.updater) this.updater.install() }
  getUpdateStatus() { return this.updater ? this.updater.getStatus() : null }

  // ---- 覆盖层（状态面：装机中 / 等待启动 / 启动失败 / 崩溃）----
  setOverlay(state) {
    this.overlayState = state
    if (state === 'hidden') {
      this._hideOverlay()
      return
    }
    this._showOverlay(state)
  }

  _ensureOverlay() {
    if (this.overlayView) return this.overlayView
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'overlay-preload.js'),
      },
    })
    this.overlayView = view
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.contentView.addChildView(view)
      this._syncOverlayBounds()
    }
    view.webContents.loadFile(path.join(__dirname, 'overlay.html'))
    return view
  }

  _overlayCopy(state) {
    const productName = this.config.productName || 'lyra-dsh'
    const map = {
      installing: { title: '正在准备环境', detail: `${productName} is installing its environment…` },
      waiting: { title: '正在启动', detail: `${productName} is starting…` },
      'startup-failed': { title: '启动失败', detail: `${productName} failed to start.` },
      crashed: { title: '已停止', detail: `${productName} has stopped.`, restart: true },
    }
    return map[state] || { title: String(state), detail: '' }
  }

  _showOverlay(state) {
    const view = this._ensureOverlay()
    const copy = this._overlayCopy(state)
    const js = `window.overlayBridge && window.overlayBridge.render(${JSON.stringify(copy.title)}, ${JSON.stringify(copy.detail)}, ${copy.restart ? 'true' : 'false'})`
    const wc = view.webContents
    if (wc.isLoading()) {
      wc.once('did-finish-load', () => wc.executeJavaScript(js).catch(() => {}))
    } else {
      wc.executeJavaScript(js).catch(() => {})
    }
  }

  _hideOverlay() {
    if (this.overlayView && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try { this.mainWindow.contentView.removeChildView(this.overlayView) } catch { /* 已移除 */ }
      this.overlayView = null
      this.mainWindow.focus()
    }
  }

  _syncOverlayBounds() {
    const view = this.overlayView
    if (!view || !this.mainWindow || this.mainWindow.isDestroyed()) return
    const cb = this.mainWindow.getContentBounds()
    view.setBounds({ x: 0, y: 0, width: cb.width, height: cb.height })
  }

  // ---- 生命周期 ----
  requestQuit() { this.emit({ type: 'quit/requested' }) }
  requestRestart() { this.emit({ type: 'quit/requested', restart: true }) }
  prepareToQuit() { this.isQuitting = true; app.quit() }

  // ---- 内部工具 ----
  _ifAlive(win, fn) { if (win && !win.isDestroyed()) fn(win) }
  _dialogParent() { return (this.mainWindow && !this.mainWindow.isDestroyed()) ? this.mainWindow : undefined }
}

module.exports = { ElectronDesktopRuntime }
