import type { DesktopThemeSource, DesktopUpdateStatus } from './types'

/**
 * 壳子推回给 Host 的事件。
 *
 * 所有 payload 都是纯数据（可序列化），因此同进程、跨进程都成立。
 * 决策权在 Host：壳子只上报，不自作主张（例如点了关闭、请求了退出）。
 */
export type DesktopEvent =
  /** 托盘图标被左键点击。 */
  | { type: 'tray/activated' }
  /** 托盘菜单项被点击。 */
  | { type: 'tray/item-activated'; itemId: string }
  /** 某窗口显示/隐藏状态变化。 */
  | { type: 'window/visibility'; windowId: string; visible: boolean }
  /** 用户点了某窗口的关闭（X）——由 Host 决定隐藏还是退出。 */
  | { type: 'window/close-requested'; windowId: string }
  /** Cmd+Q / 托盘"退出"被触发——Host 清理后回 quit()。 */
  | { type: 'quit/requested' }
  /** 某窗口的 web UI 渲染结果。 */
  | { type: 'renderer/boot'; windowId: string; status: 'ok' | 'failed'; error?: string }
  /** 系统深浅色切换。 */
  | { type: 'theme/changed'; source: DesktopThemeSource }
  /** 升级状态变化。 */
  | { type: 'update/state'; status: DesktopUpdateStatus }
