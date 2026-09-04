'use strict'

const test = require('node:test')
const assert = require('node:assert')
const notifications = require('@omnilyra/desktop-notifications')

function fakeCtx() {
  const listeners = {}
  const notified = []
  return {
    listeners,
    notified,
    on(name, fn) { listeners[name] = fn },
    desktopRuntime: { notify: (n) => notified.push(n) },
  }
}

test('notifications plugin declares inject desktopRuntime', () => {
  assert.deepStrictEqual(notifications.inject, ['desktopRuntime'])
})

test('apply subscribes to session/event and approval/request', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  assert.strictEqual(typeof ctx.listeners['session/event'], 'function')
  assert.strictEqual(typeof ctx.listeners['approval/request'], 'function')
})

test('completed turn notifies with session and turn info', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  )
  assert.deepStrictEqual(ctx.notified, [{ title: 'dsh 已完成', body: '会话 s1 第 3 轮已完成' }])
})

test('non-completed turn does not notify', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: 'x' } } },
  )
  assert.deepStrictEqual(ctx.notified, [])
})

test('approval/request notifies and delegates', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  let delegated = false
  const result = ctx.listeners['approval/request'](
    { toolName: 'bash', reason: 'run it' },
    () => { delegated = true; return 'allowed-once' },
  )
  assert.strictEqual(delegated, true)
  assert.strictEqual(result, 'allowed-once')
  assert.deepStrictEqual(ctx.notified, [{ title: '需要审批', body: 'bash：run it' }])
})
