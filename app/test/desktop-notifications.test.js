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

test('apply subscribes to session/event, approval/request and user-questions/request', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  assert.strictEqual(typeof ctx.listeners['session/event'], 'function')
  assert.strictEqual(typeof ctx.listeners['approval/request'], 'function')
  assert.strictEqual(typeof ctx.listeners['user-questions/request'], 'function')
})

test('completed turn notifies with turn info when no title yet', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  )
  assert.deepStrictEqual(ctx.notified, [{ title: 'dsh 已完成', body: '第 3 轮已完成' }])
})

test('completed turn uses the session title instead of id', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1', events: [{ type: 'session/title', data: { title: '实现消息通知' } }] },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  assert.deepStrictEqual(ctx.notified, [{ title: 'dsh 已完成', body: '实现消息通知' }])
})

test('title comes from the latest session/title event', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    {
      id: 's1',
      events: [
        { type: 'session/title', data: { title: '旧标题' } },
        { type: 'session/title', data: { title: '新标题' } },
      ],
    },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  )
  assert.deepStrictEqual(ctx.notified, [{ title: 'dsh 已完成', body: '新标题' }])
})

test('title comes from snapshotEvents() (rc.1 Session API)', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1', snapshotEvents: () => [{ type: 'session/title', data: { title: 'rc1 标题' } }] },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  assert.deepStrictEqual(ctx.notified, [{ title: 'dsh 已完成', body: 'rc1 标题' }])
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

test('approval/request notifies with Ping sound and delegates', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  let delegated = false
  const result = ctx.listeners['approval/request'](
    { toolName: 'bash', reason: 'run it' },
    () => { delegated = true; return 'allowed-once' },
  )
  assert.strictEqual(delegated, true)
  assert.strictEqual(result, 'allowed-once')
  assert.deepStrictEqual(ctx.notified, [{ title: '需要审批', body: 'bash：run it', sound: 'Ping' }])
})

test('user-questions/request notifies with Ping sound and delegates', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  let delegated = false
  const result = ctx.listeners['user-questions/request'](
    { questions: [{ question: '要用哪种方案？' }] },
    () => { delegated = true; return { answers: [] } },
  )
  assert.strictEqual(delegated, true)
  assert.deepStrictEqual(ctx.notified, [{ title: '需要回答', body: '要用哪种方案？', sound: 'Ping' }])
})

test('error turn notifies with Basso sound', () => {
  const ctx = fakeCtx()
  notifications.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } } },
  )
  assert.deepStrictEqual(ctx.notified, [{ title: 'dsh 出错', body: 'boom', sound: 'Basso' }])
})
