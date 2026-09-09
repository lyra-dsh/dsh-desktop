'use strict'

/**
 * 组合根（composition root）：把「壳子」和「dsh 进程」串起来。
 *
 * 职责：
 *   - 读配置、spawn dsh、等待其 web URL（config / dsh / state）。
 *   - 用 URL 创建 ElectronDesktopRuntime（来自 @omnilyra/lyra-dsh-electron）。
 *   - 定义托盘菜单（id），订阅壳子事件并做 Host 侧决策（关闭→隐藏、退出→杀 dsh）。
 *   - 会话完成/需要审批通知：dsh 里的 lyra-dsh-notifications 插件经 IPC 调壳子的
 *     `runtime.notify()`（见 child.on('message')），不经过这里。
 *
 * 这里不实现"壳子能力"（窗口/托盘），那些都在 lyra-dsh-electron 里。
 */

const { app, dialog, shell } = require('electron')
const path = require('node:path')
const config = require('./config')
const backend = require('@omnilyra/lyra-dsh-backend')
const { DshState } = require('./state')
const { ElectronDesktopRuntime } = require('@omnilyra/lyra-dsh-electron')
const { createUpdater, createFeedTarget, createElectronUpdaterTarget, createNpmPackageTarget } = require('@omnilyra/lyra-dsh-updater')
const { resolveDesktopShellEnv } = require('./shell-env')
const policy = require('./policy')

const TRAY_ICON_PATH = backend.unpackedAsarPath(path.join(__dirname, '..', 'build', 'tray.png'))

function showError(detail) {
  const trimmed = String(detail || '').slice(0, 4000)
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Lyra DSH',
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
        await backend.upgradeProvisionedDsh(version)
        state.killGracefully(1500, () => { app.relaunch(); app.exit(0) })
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
        label: 'Lyra DSH',
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
      label: 'Lyra DSH',
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
  // 单实例锁(M1):第二个实例直接退出,由已运行的实例接管焦点。
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const cfg = config.loadForApp()
  // 打包后的 Unix：source 登录 shell，把终端的 PATH/环境变量补进 process.env。
  const shellEnv = await resolveDesktopShellEnv({
    environment: process.env,
    isPackaged: app.isPackaged,
    platform: process.platform,
  })
  for (const [name, value] of Object.entries(shellEnv.updates)) process.env[name] = value
  if (shellEnv.fallbackReason) console.log(`[lyra-dsh] shell env: source=${shellEnv.source} fallback=${shellEnv.fallbackReason}`)
  const entry = await backend.resolveEntry(cfg)
  const dshVer = await backend.dshVersion(entry)
  const dshMode = resolveDshMode(cfg, entry)

  // 专属 profile bootstrap:核心层装不上=启动失败;便利层失败=警告继续。
  if (cfg.notify) {
    try {
      await backend.bootstrapProfile(entry, cfg.profile, { bridgeVersion: app.getVersion(), extras: [] })
    } catch (err) {
      showError(`profile bootstrap failed: ${err.message}`)
      return
    }
  }

  const child = backend.spawnDsh(cfg, entry, process.env, [])
  const state = new DshState(child)

  let url
  try {
    url = await backend.waitForReady(child, cfg)
  } catch (err) {
    state.signal('SIGKILL') // H4:启动失败时清理 detached 进程组,避免孤儿
    showError(err.message)
    return
  }

  const runtime = new ElectronDesktopRuntime({
    productName: 'Lyra DSH',
    windowTitle: 'Lyra DSH',
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

  // dsh 侧插件（lyra-dsh-bridge）通过 IPC 调壳子能力：invoke → runtime[method](...args)。
  // 白名单(M3):只放行 DesktopCapabilities 的能力,第三方插件不能越界操作壳子。
  child.on('message', async (msg) => {
    if (!msg || msg.type !== 'invoke') return
    if (!policy.isAllowedMethod(msg.method) || typeof runtime[msg.method] !== 'function') {
      try { child.send({ type: 'result', id: msg.id, ok: false, error: `method not allowed: ${msg.method}` }) } catch {}
      return
    }
    try {
      const value = await runtime[msg.method](...(msg.args || []))
      try { child.send({ type: 'result', id: msg.id, ok: true, value }) } catch {}
    } catch (error) {
      console.error('[lyra-dsh] invoke error:', error)
      try { child.send({ type: 'result', id: msg.id, ok: false, error: String(error && error.message ? error.message : error) }) } catch {}
    }
  })

  // 托盘菜单：只定义 id，点击由壳子回传 id，组装根在这里决策。
  const trayItems = () => [
    { id: 'show', label: 'Show dsh Window' },
    { id: 'reload', label: 'Reload Page' },
    { id: 'restart', label: 'Restart' },
    { id: 'keep-awake', label: '防止休眠', type: 'checkbox', checked: runtime.isKeepAwakeEnabled() },
    { type: 'separator', id: 'sep' },
    { id: 'quit', label: 'Quit Lyra DSH' },
  ]
  let keepAwakeToken = null
  for (const item of trayItems()) {
    const token = runtime.addTrayItem(item)
    if (item.id === 'keep-awake') keepAwakeToken = token
  }

  const killDshAndQuit = () => state.killGracefully(1500, () => runtime.prepareToQuit())
  const killDshAndRestart = () => state.killGracefully(1500, () => { app.relaunch(); app.exit(0) })

  /** 升级状态 → 弹窗 / 日志。安装前弹窗确认（策略）。 */
  const handleUpdateStatus = async (status) => {
    if (status.state === 'error') {
      console.error('[lyra-dsh] update error:', status.error)
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
    // 转发给 dsh 侧(按过滤表),让功能插件能订阅壳子事件。
    if (policy.shouldForwardEvent(event.type)) {
      try { child.send({ type: 'event', event }) } catch {}
    }
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
          if (keepAwakeToken) runtime.removeTrayItem(keepAwakeToken)
          keepAwakeToken = runtime.addTrayItem({ id: 'keep-awake', label: '防止休眠', type: 'checkbox', checked: runtime.isKeepAwakeEnabled() })
        }
        else if (event.itemId === 'quit') killDshAndQuit()
        break
      case 'update/state':
        handleUpdateStatus(event.status)
        break
      case 'quit/requested':
        if (event.restart) killDshAndRestart()
        else killDshAndQuit()
        break
    }
  })

  // dsh 运行期崩溃监管(H5):非主动退出时,覆盖层提示 + 托盘红点。
  child.once('exit', (code, signal) => {
    if (state.shuttingDown) return
    runtime.setOverlay('crashed')
    runtime.setBadge('error')
  })

  // 第二个实例启动 → 把焦点给已运行的窗口(M1)。
  app.on('second-instance', () => runtime.show())

  // 启动自动检查更新（策略：autoCheck）。
  if (updater && cfg.updater.autoCheck !== false) {
    updater.check().catch((err) => console.error('[lyra-dsh] update check error:', err))
  }

  app.on('activate', () => runtime.show())
  app.on('window-all-closed', () => { /* 托盘驻留 */ })
}

if (require.main === module) {
  app.whenReady().then(() => {
    boot().catch((err) => showError(err.message))
  })

  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}

module.exports = { boot, showError, resolveDshMode, buildDshTarget, buildUpdater }
