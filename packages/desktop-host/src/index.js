'use strict'

/**
 * desktop-host：dsh 侧的 Host 适配插件。
 *
 * 在 dsh 进程内提供 `desktopRuntime` —— 一个把方法调用序列化到父进程（壳子）的代理。
 * 传输用 Node 子进程 IPC：壳子以 `stdio: [..., 'ipc']` 启动 dsh，于是这里能
 * `process.send(...)` 出去、`process.on('message', ...)` 收回来。
 *
 * 零运行时依赖：cordis 由 dsh 注入（`ctx`），协议只是类型文档；本文件只碰
 * `process` 和 `ctx`。
 */

const DESKTOP_RUNTIME_KEY = 'desktopRuntime'

/** 基于子进程 IPC 的 DesktopTransport：invoke 走 process.send，onEvent 收壳子事件。 */
function createIpcTransport() {
  const send = typeof process.send === 'function' ? process.send.bind(process) : null
  const pending = new Map()
  const listeners = new Set()
  let nextId = 1

  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'result') {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.value)
        else p.reject(new Error(msg.error || 'invoke failed'))
      }
    } else if (msg.type === 'event') {
      for (const fn of [...listeners]) {
        try { fn(msg.event) } catch (cause) { console.error('[desktop-host] event listener error:', cause) }
      }
    }
  })

  return {
    invoke(method, args) {
      return new Promise((resolve, reject) => {
        // 无 ipc 通道（例如用户在终端直接跑 dsh）：优雅降级为 no-op。
        if (!send) { resolve(undefined); return }
        const id = nextId++
        pending.set(id, { resolve, reject })
        send({ type: 'invoke', id, method, args })
      })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** 把 DesktopTransport 包成 DesktopRuntime 代理：每个方法调用 → transport.invoke。 */
function createTransportRuntime(transport) {
  const call = (method, args) => transport.invoke(method, args)
  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'win32' ? 'win32'
      : 'linux'

  return {
    platform,

    // 主窗口
    show: () => call('show', []),
    hide: () => call('hide', []),
    reload: () => call('reload', []),
    setTitle: (title) => call('setTitle', [title]),

    // 多窗口
    openWindow: (spec) => call('openWindow', [spec]),
    getWindow: () => null, // 句柄代理暂未实现（本任务只用到 notify）

    // 托盘
    setTray: (items) => call('setTray', [items]),

    // 通知
    notify: (notification) => call('notify', [notification]),

    // 对话框
    pickDirectory: (options) => call('pickDirectory', [options]),
    showMessageBox: (options) => call('showMessageBox', [options]),

    // 外部
    openExternal: (url) => call('openExternal', [url]),

    // 外观
    setTheme: (source) => call('setTheme', [source]),
    setLocale: (locale) => call('setLocale', [locale]),

    // 生命周期
    quit: () => call('quit', []),
    restart: () => call('restart', []),
    prepareToQuit: () => call('prepareToQuit', []),

    // 事件（壳子 → Host）
    subscribe: (listener) => transport.onEvent(listener),
  }
}

/** 把一个 DesktopRuntime 注册进 Cordis Context（进程内 B1 路线复用）。 */
function registerDesktopRuntime(ctx, runtime) {
  ctx.provide(DESKTOP_RUNTIME_KEY, runtime)
}

/** dsh 侧插件：提供 desktopRuntime（IPC 代理）。 */
const plugin = {
  name: 'desktop-host',
  apply(ctx) {
    registerDesktopRuntime(ctx, createTransportRuntime(createIpcTransport()))
  },
}

module.exports = plugin
module.exports.DESKTOP_RUNTIME_KEY = DESKTOP_RUNTIME_KEY
module.exports.createIpcTransport = createIpcTransport
module.exports.createTransportRuntime = createTransportRuntime
module.exports.registerDesktopRuntime = registerDesktopRuntime
