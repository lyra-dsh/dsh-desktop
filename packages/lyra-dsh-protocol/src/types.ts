/**
 * 基础数据类型（值对象 + 小接口）。
 *
 * 协议约定：这些类型都必须是「纯数据」——能被 JSON 序列化。绝不携带具体框架
 * （Electron/Tauri）的类型。
 */

/** 平台标识。 */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

/** 外观来源。 */
export type DesktopThemeSource = 'system' | 'light' | 'dark'

/** 语言标记（如 "en"、"zh-CN"）。用 string 保持框架中立。 */
export type DesktopLocale = string

/** 原生通知请求（Bridge → Shell）。 */
export interface DesktopNotification {
  title: string
  body: string
  /** macOS 系统提示音名（如 "Ping" / "Basso"）；省略用系统默认音。 */
  sound?: string
}

/**
 * 托盘图标上的状态点。优先级：error > attention > info；`none` 表示清除（无状态点）。
 */
export type DesktopBadgeState = 'none' | 'info' | 'attention' | 'error'

/** 覆盖层状态枚举（壳子启动/运行时的覆盖 UI 状态）。 */
export type DesktopOverlayState =
  | 'installing'
  | 'waiting'
  | 'startup-failed'
  | 'crashed'
  | 'hidden'

/** 原生托盘菜单的一项；`submenu` 递归。 */
export interface DesktopTrayItem {
  /** 稳定 id。点击时壳子只回传 id，由组装根决定行为。 */
  id: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox' | 'radio'
  enabled?: boolean
  checked?: boolean
  submenu?: DesktopTrayItem[]
}

/** 原生消息框选项（Bridge → Shell）。 */
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

/** 升级状态机的一个状态（纯数据，可序列化）。 */
export interface DesktopUpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  /** 升级目标 id（如 'shell'、'dsh'）。 */
  target?: string
  /** 可用新版本号。 */
  version?: string
  /** 当前版本号。 */
  currentVersion?: string
  /** 下载进度 0–100（仅 downloading 时有效）。 */
  percent?: number
  /** 错误信息（仅 error 时有效）。 */
  error?: string
  /** 可打开的下载/发布页 URL（manual 模式或 available 时）。 */
  releaseUrl?: string
}

/** 启动契约：组装根启动壳子时一次性传入。 */
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
