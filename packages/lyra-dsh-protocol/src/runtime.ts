import type {
  DesktopPlatform,
  DesktopThemeSource,
  DesktopLocale,
  DesktopNotification,
  DesktopBadgeState,
  DesktopTrayItem,
  DesktopMessageBoxOptions,
  DesktopMessageBoxResult,
  DesktopDirectoryPickerOptions,
  DesktopOverlayState,
  DesktopUpdateStatus,
} from './types.js'
import type { DesktopEvent } from './events.js'

/**
 * 跨进程能力面：抽象桌面壳子能力，框架无关。
 *
 * Electron / Tauri / headless 各自实现这个接口；组装根及其插件**只依赖本协议**，
 * 从不依赖具体框架。
 *
 * 这也是跨进程的 IPC 白名单——只有列在这里的方法才会被 Bridge 序列化转发给
 * 壳子进程。
 *
 * 通信方向：
 *   - 方法（Bridge → Shell）：能力调用。
 *   - `subscribe`（Shell → Bridge）：事件推送。
 */
export interface DesktopCapabilities {
  /** 当前平台。 */
  readonly platform: DesktopPlatform

  // ---- 主窗口（id === 'main'，启动时按 DesktopShellConfig 创建）----
  show(): void
  hide(): void
  reload(): void
  setTitle(title: string): void

  // ---- 托盘 ----
  /** 增量注册一个托盘菜单项，返回 owner token（用于后续 removeTrayItem）。 */
  addTrayItem(item: DesktopTrayItem): string
  /** 按 owner token 移除之前注册的托盘菜单项。 */
  removeTrayItem(token: string): void

  // ---- 通知 ----
  notify(notification: DesktopNotification): void

  // ---- 托盘状态点 ----
  /** 设置托盘图标的红/黄/绿状态点（壳子按优先级取舍并决定何时清除）。 */
  setBadge(state: DesktopBadgeState): void

  // ---- 电源 ----
  /** 阻止系统休眠（保持网络；不阻止息屏）。active=true 开始，false 停止。 */
  setKeepAwake(active: boolean): void

  // ---- 原生对话框 ----
  pickDirectory(options?: DesktopDirectoryPickerOptions): Promise<string | null>
  showMessageBox(options: DesktopMessageBoxOptions): Promise<DesktopMessageBoxResult>

  // ---- 外部 ----
  openExternal(url: string): void

  // ---- 外观 ----
  setTheme(source: DesktopThemeSource): void
  setLocale(locale: DesktopLocale): void

  // ---- 升级 ----
  /** 检查更新；结果经 `update/state` 事件推送，并作为返回值。 */
  checkForUpdates(): Promise<DesktopUpdateStatus | null>
  /** 下载已发现的更新（manual 模式下载到本地，auto 模式走框架更新器）。 */
  downloadUpdate(): Promise<DesktopUpdateStatus | null>
  /** 安装并重启（auto 模式），或打开已下载安装包（manual 模式）。 */
  quitAndInstall(): void
  /** 当前升级状态快照。 */
  getUpdateStatus(): DesktopUpdateStatus | null

  // ---- 生命周期 ----
  /** 请求式退出（取代原 quit()）：由壳子发起，经 `quit/requested` 事件协商。 */
  requestQuit(): void
  /** 请求式重启（取代原 restart()）。 */
  requestRestart(): void

  // ---- 事件（Shell → Bridge）----
  /** 订阅壳子事件，返回取消订阅函数。 */
  subscribe(listener: (event: DesktopEvent) => void): () => void
}

/**
 * 组装根专用的壳子生命周期面。
 *
 * 这些方法属于壳子的组装/接线逻辑，**不进跨进程**：只有组装根（本进程）会调用，
 * 因此不属于 `DesktopCapabilities` 的 IPC 白名单。
 */
export interface DesktopShellLifecycle {
  /** 按 DesktopShellConfig 创建主窗口。 */
  createMainWindow(): void
  /** 设置覆盖层状态（如安装中 / 崩溃 / 启动失败等）。 */
  setOverlay(state: DesktopOverlayState): void
  /** 注入升级器实现（框架相关，跨进程不可序列化）。 */
  setUpdater(updater: unknown): void
  /** 清除托盘状态点。 */
  clearBadge(): void
  /** 查询是否处于阻止休眠状态。 */
  isKeepAwakeEnabled(): boolean
  /** 切换阻止休眠状态。 */
  toggleKeepAwake(): void
  /** 通知壳子：组装根已完成清理，可以真正退出。 */
  prepareToQuit(): void
}
