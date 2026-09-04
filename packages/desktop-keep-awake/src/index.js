'use strict'

/**
 * desktop-keep-awake：任何会话（含子 agent 会话）在运行时，阻止系统休眠（断网），
 * 但允许息屏。
 *
 * 只负责「电源」这一件事；系统通知见 desktop-notifications，托盘状态点见
 * desktop-badge。只注入 `desktopRuntime`，事件走 cordis 的 `ctx.on`。
 */

function keepAwake(ctx, enabled) {
  try {
    ctx.desktopRuntime.setKeepAwake(enabled)
  } catch (cause) {
    console.error('[desktop-keep-awake] setKeepAwake failed:', cause)
  }
}

module.exports = {
  name: 'desktop-keep-awake',
  inject: ['desktopRuntime'],
  apply(ctx) {
    // 当前在跑的 turn 数（跨所有会话，含子 agent 的会话）。
    let runningTurns = 0
    const runningChanged = (delta) => {
      const prev = runningTurns
      runningTurns = Math.max(0, runningTurns + delta)
      if (prev === 0 && runningTurns > 0) keepAwake(ctx, true)
      else if (prev > 0 && runningTurns === 0) keepAwake(ctx, false)
    }

    // turn/start 开始跑，turn/end 结束。
    ctx.on('session/event', (session, event) => {
      if (!event || !event.data) return
      if (event.type === 'turn/start') {
        runningChanged(+1)
        return
      }
      if (event.type === 'turn/end') runningChanged(-1)
    })
  },
}
