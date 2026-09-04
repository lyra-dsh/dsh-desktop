'use strict'

/**
 * 组合根（composition root）：把「壳子」和「dsh 进程」串起来。
 *
 * 职责：
 *   - 读配置、spawn dsh、等待其 web URL（config / dsh / state）。
 *   - 用 URL 创建 ElectronDesktopRuntime（来自 @omnilyra/desktop-electron）。
 *   - 定义托盘菜单（id），订阅壳子事件并做 Host 侧决策（关闭→隐藏、退出→杀 dsh）。
 *   - 会话完成/需要审批通知：dsh 里的 desktop-notifications 插件经 IPC 调壳子的
 *     `runtime.notify()`（见 child.on('message')），不经过这里。
 *
 * 这里不实现"壳子能力"（窗口/托盘），那些都在 desktop-electron 里。
 */

const { app, dialog } = require('electron')
const path = require('node:path')
const config = require('./config')
const dsh = require('./dsh')
const plugins = require('./plugins')
const { DshState } = require('./state')
const { ElectronDesktopRuntime } = require('@omnilyra/desktop-electron')

const TRAY_ICON_PATH = dsh.unpackedAsarPath(path.join(__dirname, '..', 'build', 'tray.png'))

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
  const entry = await dsh.resolveEntry(cfg)
  const notifyArgs = cfg.notify ? plugins.ensureDesktopPlugins(cfg.profile) : []
  const child = dsh.spawnDsh(cfg, entry, process.env, notifyArgs)
  const state = new DshState(child.pid)

  let url
  try {
    url = await dsh.waitForReady(child, cfg)
  } catch (err) {
    showError(err.message)
    return
  }

  const runtime = new ElectronDesktopRuntime({
    productName: 'dsh Desktop',
    windowTitle: 'dsh',
    url,
    trayIconPath: TRAY_ICON_PATH,
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    theme: 'system',
    locale: 'en',
  })
  runtime.createMainWindow()

  // dsh 侧插件（desktop-host）通过 IPC 调壳子能力：invoke → runtime[method](...args)。
  child.on('message', async (msg) => {
    if (!msg || msg.type !== 'invoke') return
    try {
      const value = await runtime[msg.method](...(msg.args || []))
      child.send({ type: 'result', id: msg.id, ok: true, value })
    } catch (error) {
      child.send({
        type: 'result',
        id: msg.id,
        ok: false,
        error: String(error && error.message ? error.message : error),
      })
    }
  })

  // 托盘菜单：只定义 id，点击由壳子回传 id，Host 在这里决策。
  runtime.setTray([
    { id: 'show', label: 'Show dsh Window' },
    { id: 'reload', label: 'Reload Page' },
    { id: 'restart', label: 'Restart' },
    { type: 'separator', id: 'sep' },
    { id: 'quit', label: 'Quit dsh Desktop' },
  ])

  const killDshAndQuit = () => state.killGracefully(1500, () => runtime.quit())
  const killDshAndRestart = () => state.killGracefully(1500, () => runtime.restart())

  runtime.subscribe((event) => {
    switch (event.type) {
      case 'window/close-requested':
        if (event.windowId === 'main') runtime.hide() // 关到托盘
        break
      case 'tray/activated':
        runtime.show()
        break
      case 'tray/item-activated':
        if (event.itemId === 'show') runtime.show()
        else if (event.itemId === 'reload') runtime.reload()
        else if (event.itemId === 'restart') killDshAndRestart()
        else if (event.itemId === 'quit') killDshAndQuit()
        break
      case 'quit/requested':
        killDshAndQuit()
        break
    }
  })

  app.on('activate', () => runtime.show())
  app.on('window-all-closed', () => { /* 托盘驻留 */ })
}

app.whenReady().then(() => {
  boot().catch((err) => showError(err.message))
})

process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
