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
  DesktopWindowSpec,
  DesktopWindowHandle,
  DesktopUpdateStatus,
} from './types'
import type { DesktopEvent } from './events'

/**
 * 抽象桌面壳子能力，框架无关。
 *
 * Electron / Tauri / headless 各自实现这个接口；Host 及其插件**只依赖本协议**，
 * 从不依赖具体框架。
 *
 * 通信方向：
 *   - 方法（Host → Shell）：能力调用。
 *   - `subscribe`（Shell → Host）：事件推送。
 */
export interface DesktopRuntime {
  /** 当前平台。 */
  readonly platform: DesktopPlatform

  // ---- 主窗口（id === 'main'，启动时按 DesktopShellConfig 创建）----
  show(): void
  hide(): void
  reload(): void
  setTitle(title: string): void

  // ---- 多窗口 ----
  /** 打开一个窗口，返回句柄；所有窗口操作都挂在句柄上。 */
  openWindow(spec: DesktopWindowSpec): Promise<DesktopWindowHandle>
  /** 按 id 取窗口句柄；`getWindow('main')` 拿主窗口。 */
  getWindow(id: string): DesktopWindowHandle | null

  // ---- 托盘 ----
  /** 整体替换托盘菜单。 */
  setTray(items: DesktopTrayItem[]): void

  // ---- 通知 ----
  notify(notification: DesktopNotification): void

  // ---- 托盘状态点 ----
  /** 设置托盘图标的红/黄/绿状态点（壳子按优先级取舍并决定何时清除）。 */
  setBadge(state: DesktopBadgeState): void

  // ---- 电源 ----
  /** 阻止系统休眠（保持网络；不阻止息屏）。enabled=true 开始，false 停止。 */
  setKeepAwake(enabled: boolean): void

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
  quit(): void
  restart(): void
  /** 通知壳子：Host 已完成清理，可以真正退出。 */
  prepareToQuit(): void

  // ---- 事件（Shell → Host）----
  /** 订阅壳子事件，返回取消订阅函数。 */
  subscribe(listener: (event: DesktopEvent) => void): () => void
}
