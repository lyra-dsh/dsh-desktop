'use strict'

/**
 * desktop-badge：把 dsh 的会话状态映射成托盘图标上的红/黄/绿状态点。
 *
 * 只负责「托盘状态点」这一件事；系统通知见 desktop-notifications，防休眠见
 * desktop-keep-awake。只注入 `desktopRuntime`，事件走 cordis 的 `ctx.on`。
 */

function badge(ctx, state) {
  try {
    ctx.desktopRuntime.setBadge(state)
  } catch (cause) {
    console.error('[desktop-badge] setBadge failed:', cause)
  }
}

module.exports = {
  name: 'desktop-badge',
  inject: ['desktopRuntime'],
  apply(ctx) {
    // 完成 → 绿点；出错 → 红点。
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'turn/end' || !event.data || !event.data.reason) return
      const kind = event.data.reason.kind
      if (kind === 'completed') badge(ctx, 'unread')
      else if (kind === 'error') badge(ctx, 'error')
    })

    // 待审批 / 提问 → 黄点。只标记、不消费，委托给真正的 answerer。
    ctx.on('approval/request', (req, next) => {
      badge(ctx, 'approval')
      return next()
    })
    ctx.on('user-questions/request', (request, next) => {
      badge(ctx, 'approval')
      return next()
    })
  },
}
