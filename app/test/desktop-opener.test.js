'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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

function route(ctx, path) {
  return ctx.routes.find((r) => r.path === path)
}

test('desktop-opener declares name and inject', () => {
  assert.strictEqual(opener.name, 'desktop-opener')
  assert.deepStrictEqual(opener.inject, ['connection', 'sessions', 'sessionQuery'])
})

test('apply registers all routes', () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  assert.deepStrictEqual(ctx.routes.map((r) => [r.path, r.methods]), [
    ['/api/desktop.editors', ['GET']],
    ['/api/desktop.editor-icon', ['GET']],
    ['/api/desktop.editor-preference', ['GET', 'PUT']],
    ['/api/desktop.open-with', ['POST']],
  ])
})

test('editors route returns a JSON list of installed editors', async () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  const res = await route(ctx, '/api/desktop.editors').fetch()
  assert.strictEqual(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.editors))
  // Finder 永远可用
  assert.ok(data.editors.some((e) => e.id === 'finder'))
})

test('open-with returns 400 for unknown editor', async () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  const res = await route(ctx, '/api/desktop.open-with').fetch(new Request('http://x/api/desktop.open-with', {
    method: 'POST',
    body: JSON.stringify({ editorId: 'nope', sessionId: 's1' }),
  }))
  assert.strictEqual(res.status, 400)
  const data = await res.json()
  assert.strictEqual(data.ok, false)
})

test('editor-icon returns 400 for unknown editor', async () => {
  const ctx = fakeCtx()
  opener.apply(ctx)
  const res = await route(ctx, '/api/desktop.editor-icon').fetch(new Request('http://x/api/desktop.editor-icon?editorId=nope'))
  assert.strictEqual(res.status, 400)
})

test('editor-preference GET/PUT persists the chosen editor (Finder)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-opener-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const ctx = fakeCtx()
    opener.apply(ctx)
    const getRoute = route(ctx, '/api/desktop.editor-preference')
    const putRoute = route(ctx, '/api/desktop.editor-preference')

    // 未写入时：默认取第一个已安装编辑器（Finder 一定可用）。
    const first = await getRoute.fetch(new Request('http://x/api/desktop.editor-preference'))
    assert.strictEqual(first.status, 200)
    const firstData = await first.json()
    assert.strictEqual(typeof firstData.editorId, 'string')

    // 写入 finder 后：GET 返回 finder。
    const put = await putRoute.fetch(new Request('http://x/api/desktop.editor-preference', {
      method: 'PUT',
      body: JSON.stringify({ editorId: 'finder' }),
    }))
    assert.strictEqual(put.status, 200)
    assert.deepStrictEqual(await put.json(), { ok: true, editorId: 'finder' })

    const again = await getRoute.fetch(new Request('http://x/api/desktop.editor-preference'))
    assert.deepStrictEqual(await again.json(), { editorId: 'finder' })
  } finally {
    process.env.DSH_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('editor-preference PUT rejects an unknown editor', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-opener-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const ctx = fakeCtx()
    opener.apply(ctx)
    const res = await route(ctx, '/api/desktop.editor-preference').fetch(new Request('http://x/api/desktop.editor-preference', {
      method: 'PUT',
      body: JSON.stringify({ editorId: 'nope' }),
    }))
    assert.strictEqual(res.status, 400)
  } finally {
    process.env.DSH_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
