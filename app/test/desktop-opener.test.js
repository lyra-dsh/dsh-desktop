'use strict'

const test = require('node:test')
const assert = require('node:assert')
const opener = require('@omnilyra/desktop-opener')

function fakeCtx() {
  const routes = []
  return {
    routes,
    connection: { fetch: { register: (r) => routes.push(r) } },
    sessions: { get: () => null },
    sessionQuery: null,
  }
}

test('desktop-opener declares name and inject', () => {
  assert.strictEqual(opener.name, 'desktop-opener')
  assert.deepStrictEqual(opener.inject, ['connection', 'sessions', 'sessionQuery'])
})

test('apply registers editors + open-with routes', () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  assert.deepStrictEqual(ctx.routes.map((r) => [r.path, r.methods]), [
    ['/api/desktop.editors', ['GET']],
    ['/api/desktop.open-with', ['POST']],
  ])
})

test('editors route returns a JSON list of installed editors', async () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  const res = await ctx.routes[0].fetch()
  assert.strictEqual(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.editors))
  // Finder 永远可用
  assert.ok(data.editors.some((e) => e.id === 'finder'))
})

test('open-with returns 400 for unknown editor', async () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  const res = await ctx.routes[1].fetch(new Request('http://x/api/desktop.open-with', {
    method: 'POST',
    body: JSON.stringify({ editorId: 'nope', sessionId: 's1' }),
  }))
  assert.strictEqual(res.status, 400)
  const data = await res.json()
  assert.strictEqual(data.ok, false)
})
