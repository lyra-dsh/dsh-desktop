'use strict'

const test = require('node:test')
const assert = require('node:assert')
const badge = require('@omnilyra/desktop-badge')

function fakeCtx() {
  const listeners = {}
  const badged = []
  return {
    listeners,
    badged,
    on(name, fn) { listeners[name] = fn },
    desktopRuntime: { setBadge: (s) => badged.push(s) },
  }
}

test('badge plugin declares inject desktopRuntime', () => {
  assert.deepStrictEqual(badge.inject, ['desktopRuntime'])
})

test('completed turn sets unread badge', () => {
  const ctx = fakeCtx()
  badge.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  assert.deepStrictEqual(ctx.badged, ['unread'])
})

test('error turn sets error badge', () => {
  const ctx = fakeCtx()
  badge.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
  )
  assert.deepStrictEqual(ctx.badged, ['error'])
})

test('non-completed/non-error turn sets no badge', () => {
  const ctx = fakeCtx()
  badge.apply(ctx)
  ctx.listeners['session/event'](
    { id: 's1' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'x' } } },
  )
  assert.deepStrictEqual(ctx.badged, [])
})

test('approval/request and user-questions/request set approval badge and delegate', () => {
  const ctx = fakeCtx()
  badge.apply(ctx)
  let delegated = false
  ctx.listeners['approval/request']({ toolName: 'bash' }, () => { delegated = true; return 'allowed-once' })
  assert.strictEqual(delegated, true)
  delegated = false
  ctx.listeners['user-questions/request']({ questions: [{ question: 'q' }] }, () => { delegated = true; return { answers: [] } })
  assert.strictEqual(delegated, true)
  assert.deepStrictEqual(ctx.badged, ['approval', 'approval'])
})
