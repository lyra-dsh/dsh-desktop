'use strict'

const test = require('node:test')
const assert = require('node:assert')
const host = require('@omnilyra/desktop-host')

test('desktop-host exports a plugin with name and apply', () => {
  assert.strictEqual(host.name, 'desktop-host')
  assert.strictEqual(typeof host.apply, 'function')
  assert.strictEqual(host.DESKTOP_RUNTIME_KEY, 'desktopRuntime')
})

test('createTransportRuntime proxies notify over invoke', async () => {
  const calls = []
  const transport = {
    invoke(method, args) { calls.push([method, args]); return Promise.resolve(undefined) },
    onEvent() { return () => {} },
  }
  const runtime = host.createTransportRuntime(transport)
  const notification = { title: 't', body: 'b' }
  runtime.notify(notification)
  assert.deepStrictEqual(calls[0], ['notify', [notification]])
})

test('createTransportRuntime proxies void methods and subscribe', async () => {
  const calls = []
  let eventListener = null
  const transport = {
    invoke(method, args) { calls.push([method, args]); return Promise.resolve(undefined) },
    onEvent(listener) { eventListener = listener; return () => {} },
  }
  const runtime = host.createTransportRuntime(transport)
  runtime.show()
  runtime.setTitle('hello')
  runtime.setTray([{ id: 'x' }])
  runtime.setBadge('error')
  runtime.setKeepAwake(true)
  runtime.subscribe(() => {})
  assert.deepStrictEqual(calls[0], ['show', []])
  assert.deepStrictEqual(calls[1], ['setTitle', ['hello']])
  assert.deepStrictEqual(calls[2], ['setTray', [[{ id: 'x' }]]])
  assert.deepStrictEqual(calls[3], ['setBadge', ['error']])
  assert.deepStrictEqual(calls[4], ['setKeepAwake', [true]])
  assert.strictEqual(typeof eventListener, 'function')
})

test('registerDesktopRuntime provides the runtime under the key', () => {
  let providedName = null
  let providedValue = null
  const ctx = { provide(name, value) { providedName = name; providedValue = value } }
  const runtime = {}
  host.registerDesktopRuntime(ctx, runtime)
  assert.strictEqual(providedName, 'desktopRuntime')
  assert.strictEqual(providedValue, runtime)
})
