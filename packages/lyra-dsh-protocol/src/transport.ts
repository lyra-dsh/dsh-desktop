import type { DesktopEvent } from './events.js'

/**
 * 跨进程传输接口。
 *
 * 它把 Bridge → Shell 的方法调用序列化过去、把 Shell → Bridge 的事件序列化回来。
 * 同进程时不需要传输层（直接对象引用）；只有壳子拆成独立进程时才需要实现。
 *
 * 这是"进程模型"维度的 seam：接口现在定义（很便宜），实现（Electron IPC / stdio /
 * WebSocket）等到确定走跨进程时再写。
 */
export interface DesktopTransport {
  /** Bridge → Shell：调用一个方法（方法名 + 参数），返回结果。 */
  invoke(method: string, args: unknown[]): Promise<unknown>
  /** Shell → Bridge：订阅事件，返回取消订阅函数。 */
  onEvent(listener: (event: DesktopEvent) => void): () => void
}

/** 一次方法调用消息（Bridge → Shell）。 */
export interface DesktopInvokeMessage {
  /** 自增 id，用于匹配结果。 */
  id: number
  method: string
  args: unknown[]
}

/** 一次方法调用结果（Shell → Bridge）。 */
export interface DesktopInvokeResult {
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

/** 一个事件消息（Shell → Bridge）。 */
export interface DesktopEventMessage {
  event: DesktopEvent
}
