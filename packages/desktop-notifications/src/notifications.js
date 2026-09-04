'use strict'

/**
 * desktop-notifications：在 dsh 内订阅会话/审批事件，弹系统通知。
 *
 * 只注入 `desktopRuntime`（由 desktop-host 提供）；事件本身走 cordis 的
 * `ctx.on`（`session/event` 与 `approval/request`），不注入对应服务——
 * 监听器会在服务 emit 时收到事件，与加载顺序无关。
 */

function notify(ctx, title, body) {
  try {
    ctx.desktopRuntime.notify({ title, body })
  } catch (cause) {
    console.error('[desktop-notifications] notify failed:', cause)
  }
}

module.exports = {
  name: 'desktop-notifications',
  inject: ['desktopRuntime'],
  apply(ctx) {
    // 会话完成：一轮（turn）以 completed 结束。
    ctx.on('session/event', (session, event) => {
      if (
        event
        && event.type === 'turn/end'
        && event.data
        && event.data.reason
        && event.data.reason.kind === 'completed'
      ) {
        notify(ctx, 'dsh 已完成', `会话 ${session.id} 第 ${event.data.turn} 轮已完成`)
      }
    })

    // 需要审批：审批问答链被触发（waterfall）。只通知、不消费，委托给真正的 answerer。
    ctx.on('approval/request', (req, next) => {
      const body = req.toolName
        ? `${req.toolName}${req.reason ? '：' + req.reason : ''}`
        : (req.reason || '')
      notify(ctx, '需要审批', body)
      return next()
    })
  },
}
