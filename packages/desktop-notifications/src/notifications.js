'use strict'

/**
 * desktop-notifications：在 dsh 内订阅会话/审批/提问/出错事件，弹系统通知。
 *
 * 只负责「系统通知」这一件事；托盘状态点见 desktop-badge，防休眠见
 * desktop-keep-awake。只注入 `desktopRuntime`，事件走 cordis 的 `ctx.on`。
 */

function notify(ctx, title, body, sound) {
  try {
    const notification = { title, body }
    if (sound) notification.sound = sound
    ctx.desktopRuntime.notify(notification)
  } catch (cause) {
    console.error('[desktop-notifications] notify failed:', cause)
  }
}

/** 从会话日志取最新标题（`session/title` 事件是 last-wins）。 */
function titleOf(session) {
  let events
  try {
    // rc.1 起 Session 用 snapshotEvents()；早期版本是 events getter，两者都兼容。
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : (session && session.events)
  } catch { events = null }
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string' && e.data.title) {
      return e.data.title
    }
  }
  return null
}

module.exports = {
  name: 'desktop-notifications',
  inject: ['desktopRuntime'],
  apply(ctx) {
    // 会话完成 / 出错：一轮（turn）结束。
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'turn/end' || !event.data || !event.data.reason) return
      const kind = event.data.reason.kind
      if (kind === 'completed') {
        const title = titleOf(session)
        notify(ctx, 'dsh 已完成', title || `第 ${event.data.turn} 轮已完成`)
      } else if (kind === 'error') {
        const err = event.data.reason.error
        const msg = err && err.message ? err.message : '执行出错'
        notify(ctx, 'dsh 出错', msg, 'Basso')
      }
    })

    // 需要审批：审批问答链被触发（waterfall）。只通知、不消费，委托给真正的 answerer。
    ctx.on('approval/request', (req, next) => {
      const body = req.toolName
        ? `${req.toolName}${req.reason ? '：' + req.reason : ''}`
        : (req.reason || '')
      notify(ctx, '需要审批', body, 'Ping')
      return next()
    })

    // 需要回答：agent 用 ask_user 工具向你提问（waterfall）。同样只通知、不消费。
    ctx.on('user-questions/request', (request, next) => {
      const q = request.questions && request.questions[0]
      notify(ctx, '需要回答', q && q.question ? q.question : '请回答一个问题', 'Ping')
      return next()
    })
  },
}
