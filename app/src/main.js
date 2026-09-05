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

const { app, dialog, shell } = require('electron')
const path = require('node:path')
const config = require('./config')
const dsh = require('./dsh')
const plugins = require('./plugins')
const { DshState } = require('./state')
const { ElectronDesktopRuntime } = require('@omnilyra/desktop-electron')
const { createUpdater, createFeedTarget, createElectronUpdaterTarget, createNpmPackageTarget } = require('@omnilyra/desktop-updater')

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

/** 决定 dsh 运行时升级策略：显式配置优先，否则按供给方式推断。 */
function resolveDshMode(cfg, entry) {
  const rt = cfg.updater && cfg.updater.runtime
  if (rt && rt.mode) return rt.mode
  if (cfg.dshBin) return 'none' // 显式 dshBin → 产品自管
  if (entry.kind === 'bundled') return 'auto' // 兜底安装 → 自动 npm 升级
  return 'notify' // 系统 dsh → 只提示
}

/** 构建 dsh 运行时升级 target；mode 为 'none' 时返回 null。 */
function buildDshTarget(cfg, entry, dshVer, dshMode, state, runtime) {
  if (dshMode === 'none') return null
  const rt = cfg.updater && cfg.updater.runtime
  const packageName = (rt && rt.package) || '@deepseek-ai/dsh'
  const apply = dshMode === 'auto'
    ? async (version) => {
        // 重装到新版本，然后优雅杀掉 dsh、重启整个 app（重启时用新 dsh）。
        await dsh.upgradeProvisionedDsh(version)
        state.killGracefully(1500, () => runtime.restart())
      }
    : null // notify：install 不动作，只靠弹窗提示
  return createNpmPackageTarget({
    id: 'dsh',
    label: 'dsh runtime',
    packageName,
    currentVersion: () => dshVer || '0.0.0',
    apply,
  })
}

/** 按配置 + 供给方式构建升级器：shell target + dsh runtime target。 */
function buildUpdater(cfg, entry, dshVer, dshMode, state, runtime) {
  const u = cfg.updater
  if (!u || !u.enabled) return null
  const currentVersion = () => app.getVersion()
  const targets = []
  if (process.platform === 'darwin') {
    // macOS 无 Developer ID → manual：版本清单 + 下载安装包 + 打开。
    if (u.feedUrl) {
      targets.push(createFeedTarget({
        id: 'shell',
        label: 'dsh Desktop',
        feedUrl: u.feedUrl,
        currentVersion,
        downloadsDir: () => app.getPath('downloads'),
        openFile: (p) => shell.openPath(p),
      }))
    }
  } else {
    // Windows / Linux → auto：NSIS / AppImage 无需签名也能 quitAndInstall。
    targets.push(createElectronUpdaterTarget({
      id: 'shell',
      label: 'dsh Desktop',
      currentVersion,
      isPackaged: () => app.isPackaged,
    }))
  }
  const dshTarget = buildDshTarget(cfg, entry, dshVer, dshMode, state, runtime)
  if (dshTarget) targets.push(dshTarget)
  if (targets.length === 0) return null
  return createUpdater({ targets, autoDownload: u.autoDownload !== false })
}

async function boot() {
  const cfg = config.loadForApp()
  const entry = await dsh.resolveEntry(cfg)
  const dshVer = await dsh.dshVersion(entry)
  const dshMode = resolveDshMode(cfg, entry)
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
  const updater = buildUpdater(cfg, entry, dshVer, dshMode, state, runtime)
  if (updater) runtime.setUpdater(updater)

  // dsh 侧插件（desktop-host）通过 IPC 调壳子能力：invoke → runtime[method](...args)。
  child.on('message', async (msg) => {
    if (!msg || msg.type !== 'invoke') return
    console.log('[dsh-desktop] invoke:', msg.method, JSON.stringify(msg.args))
    try {
      const value = await runtime[msg.method](...(msg.args || []))
      child.send({ type: 'result', id: msg.id, ok: true, value })
    } catch (error) {
      console.error('[dsh-desktop] invoke error:', error)
      child.send({
        type: 'result',
        id: msg.id,
        ok: false,
        error: String(error && error.message ? error.message : error),
      })
    }
  })

  // 托盘菜单：只定义 id，点击由壳子回传 id，Host 在这里决策。
  const trayItems = () => [
    { id: 'show', label: 'Show dsh Window' },
    { id: 'reload', label: 'Reload Page' },
    { id: 'restart', label: 'Restart' },
    { id: 'keep-awake', label: '防止休眠', type: 'checkbox', checked: runtime.isKeepAwakeEnabled() },
    { type: 'separator', id: 'sep' },
    { id: 'quit', label: 'Quit dsh Desktop' },
  ]
  runtime.setTray(trayItems())

  const killDshAndQuit = () => state.killGracefully(1500, () => runtime.quit())
  const killDshAndRestart = () => state.killGracefully(1500, () => runtime.restart())

  /** 升级状态 → 弹窗 / 日志。安装前弹窗确认（策略）。 */
  const handleUpdateStatus = async (status) => {
    if (status.state === 'error') {
      console.error('[dsh-desktop] update error:', status.error)
      return
    }
    if (status.state !== 'downloaded') return

    // dsh 运行时升级：auto = 更新并重启；notify = 只提示手动升级。
    if (status.target === 'dsh') {
      if (dshMode === 'auto') {
        const res = await dialog.showMessageBox({
          type: 'info',
          title: 'dsh 有新版本',
          message: `检测到 dsh 新版本 ${status.version || ''}（当前 ${status.currentVersion || ''}），是否更新并重启？`,
          buttons: ['更新并重启', '稍后'],
          defaultId: 0,
          cancelId: 1,
        })
        if (res.response === 0 && updater) updater.install()
      } else {
        await dialog.showMessageBox({
          type: 'info',
          title: 'dsh 有新版本',
          message: `检测到 dsh 新版本 ${status.version || ''}（当前 ${status.currentVersion || ''}），请手动升级。`,
          buttons: ['知道了'],
          defaultId: 0,
        })
      }
      return
    }

    // 壳子升级：manual 打开安装包；auto（win/linux）quitAndInstall。
    const res = await dialog.showMessageBox({
      type: 'info',
      title: '更新已下载',
      message: `新版本 ${status.version || ''} 已下载，是否安装？`,
      buttons: ['安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (res.response === 0 && updater) updater.install()
  }

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
        else if (event.itemId === 'keep-awake') {
          runtime.toggleKeepAwake()
          runtime.setTray(trayItems()) // 重新渲染勾选状态
        }
        else if (event.itemId === 'quit') killDshAndQuit()
        break
      case 'update/state':
        handleUpdateStatus(event.status)
        break
      case 'quit/requested':
        killDshAndQuit()
        break
    }
  })

  // 启动自动检查更新（策略：autoCheck）。
  if (updater && cfg.updater.autoCheck !== false) {
    updater.check().catch((err) => console.error('[dsh-desktop] update check error:', err))
  }

  app.on('activate', () => runtime.show())
  app.on('window-all-closed', () => { /* 托盘驻留 */ })
}

app.whenReady().then(() => {
  boot().catch((err) => showError(err.message))
})

process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
