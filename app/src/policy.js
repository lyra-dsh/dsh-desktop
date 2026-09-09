'use strict'

// 纯策略逻辑:IPC 能力白名单 + 壳子事件转发过滤表。不依赖 electron,可单测。

/**
 * IPC 能力白名单 = DesktopCapabilities 的方法集(不含 platform 属性与 subscribe)。
 * dsh 侧插件只能调用这里列出的方法;其余一律回 "method not allowed"。
 * 这是「能力面底线」的咽喉:第三方 dsh 插件不能越界操作壳子(如 createMainWindow/setUpdater)。
 */
const IPC_ALLOWLIST = new Set([
  // 主窗口
  'show', 'hide', 'reload', 'setTitle',
  // 托盘(增量注册)
  'addTrayItem', 'removeTrayItem',
  // 通知 / 状态点 / 电源
  'notify', 'setBadge', 'setKeepAwake',
  // 对话框 / 外部 / 外观
  'pickDirectory', 'showMessageBox', 'openExternal', 'setTheme', 'setLocale',
  // 升级
  'checkForUpdates', 'downloadUpdate', 'quitAndInstall', 'getUpdateStatus',
  // 生命周期(请求式)
  'requestQuit', 'requestRestart',
])

/**
 * 壳子事件里哪些要转发给 dsh 侧(Bridge)。
 * quit/requested 不转发——dsh 收到它也只能反向 requestQuit,会成环;
 * 其余事件都是纯通知,转发让功能插件(如 badge 的「未读仅在未聚焦时标」)能把策略留在插件层。
 */
const FORWARDED_EVENTS = new Set([
  'tray/activated',
  'tray/item-activated',
  'window/visibility',
  'window/close-requested',
  'renderer/boot',
  'update/state',
])

function isAllowedMethod(method) {
  return IPC_ALLOWLIST.has(method)
}

function shouldForwardEvent(type) {
  return FORWARDED_EVENTS.has(type)
}

module.exports = { IPC_ALLOWLIST, FORWARDED_EVENTS, isAllowedMethod, shouldForwardEvent }
