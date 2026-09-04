'use strict'

const test = require('node:test')
const assert = require('node:assert')
const keepAwake = require('@omnilyra/desktop-keep-awake')

function fakeCtx() {
  const listeners = {}
  const keepAwakes = []
  return {
    listeners,
    keepAwakes,
    on(name, fn) { listeners[name] = fn },
    desktopRuntime: { setKeepAwake: (enabled) => keepAwakes.push(enabled) },
  }
}

test('keep-awake plugin declares inject desktopRuntime', () => {
  assert.deepStrictEqual(keepAwake.inject, ['desktopRuntime'])
})

test('turn/start starts keep-awake, turn/end stops it', () => {
  const ctx = fakeCtx()
  keepAwake.apply(ctx)
  ctx.listeners['session/event']({ id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  assert.deepStrictEqual(ctx.keepAwakes, [true])
  ctx.listeners['session/event']({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'x' } } })
  assert.deepStrictEqual(ctx.keepAwakes, [true, false])
})

test('keep-awake stays on while multiple turns (e.g. subagents) are running', () => {
  const ctx = fakeCtx()
  keepAwake.apply(ctx)
  ctx.listeners['session/event']({ id: 'main' }, { type: 'turn/start', data: { turn: 1 } })
  ctx.listeners['session/event']({ id: 'sub' }, { type: 'turn/start', data: { turn: 1 } })
  assert.deepStrictEqual(ctx.keepAwakes, [true])
  ctx.listeners['session/event']({ id: 'main' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'x' } } })
  assert.deepStrictEqual(ctx.keepAwakes, [true]) // 子 agent 还在跑
  ctx.listeners['session/event']({ id: 'sub' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'x' } } })
  assert.deepStrictEqual(ctx.keepAwakes, [true, false])
})
