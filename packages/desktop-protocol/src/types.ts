/**
 * 基础数据类型（值对象 + 小接口）。
 *
 * 协议约定：这些类型都必须是「纯数据」——能被 JSON 序列化，或在本进程内是
 * 可调用的对象（如 DesktopWindowHandle）。绝不携带具体框架（Electron/Tauri）
 * 的类型。
 */

/** 平台标识。 */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

/** 外观来源。 */
export type DesktopThemeSource = 'system' | 'light' | 'dark'

/** 语言标记（如 "en"、"zh-CN"）。用 string 保持框架中立。 */
export type DesktopLocale = string

/** 原生通知请求（Host → Shell）。 */
export interface DesktopNotification {
  title: string
  body: string
  /** macOS 系统提示音名（如 "Ping" / "Basso"）；省略用系统默认音。 */
  sound?: string
}

/** 托盘图标上的状态点。优先级：error > approval > unread。 */
export type DesktopBadgeState = 'error' | 'approval' | 'unread'

/** 原生托盘菜单的一项；`submenu` 递归。 */
export interface DesktopTrayItem {
  /** 稳定 id。点击时壳子只回传 id，由 Host 决定行为。 */
  id: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox' | 'radio'
  enabled?: boolean
  checked?: boolean
  submenu?: DesktopTrayItem[]
}

/** 原生消息框选项（Host → Shell）。 */
export interface DesktopMessageBoxOptions {
  type: 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/** 原生消息框结果。 */
export interface DesktopMessageBoxResult {
  response: number
}

/** 原生目录选择器选项。 */
export interface DesktopDirectoryPickerOptions {
  title?: string
  defaultPath?: string
}

/** `openWindow` 的参数：打开一个（非主）窗口。 */
export interface DesktopWindowSpec {
  /**
   * 稳定窗口 id。不传则由壳子分配；`'main'` 保留给启动窗口。
   */
  id?: string
  title: string
  /** 该窗口加载什么（决定"代码窗口"还是"会话窗口"，由 Host 决定）。 */
  url: string
  width: number
  height: number
  modal?: boolean
}

/**
 * 一个存活窗口的句柄。
 *
 * 同进程实现里是真实对象；跨进程实现里是代理 stub（方法调用序列化走 IPC）。
 */
export interface DesktopWindowHandle {
  readonly id: string
  /** 显示并聚焦。 */
  show(): void
  /** 隐藏但保活（关到托盘）。 */
  hide(): void
  /** 真正销毁窗口。 */
  close(): void
  reload(): void
  setTitle(title: string): void
}

/** 启动契约：Host 启动壳子时一次性传入。 */
export interface DesktopShellConfig {
  productName: string
  windowTitle: string
  /** 主窗口要加载的 URL（含 token）。 */
  url: string
  /** 应用/Dock 图标。 */
  iconPath?: string
  /** 托盘图标。 */
  trayIconPath?: string
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  theme: DesktopThemeSource
  locale: DesktopLocale
}
