'use strict'

const test = require('node:test')
const assert = require('node:assert')
const dsh = require('../src/dsh')

test('resolveFallbackPort: null -> 3080', () => {
  assert.strictEqual(dsh.resolveFallbackPort({ port: null }), 3080)
})

test('resolveFallbackPort: 0 -> null (OS-assigned)', () => {
  assert.strictEqual(dsh.resolveFallbackPort({ port: 0 }), null)
})

test('resolveFallbackPort: pinned port', () => {
  assert.strictEqual(dsh.resolveFallbackPort({ port: 8080 }), 8080)
})

test('unpackedAsarPath maps app.asar to app.asar.unpacked', () => {
  assert.strictEqual(
    dsh.unpackedAsarPath('/a/app.asar/node_modules/x/bin.js'),
    '/a/app.asar.unpacked/node_modules/x/bin.js',
  )
})

test('unpackedAsarPath leaves non-asar paths untouched', () => {
  const p = '/a/node_modules/x/bin.js'
  assert.strictEqual(dsh.unpackedAsarPath(p), p)
})

test('resolveEntry: explicit dshBin wins', () => {
  const entry = dsh.resolveEntry({ dshBin: '/usr/bin/dsh' }, {})
  assert.deepStrictEqual(entry, { kind: 'external', entry: '/usr/bin/dsh' })
})

test('resolveEntry: env override wins over null dshBin', () => {
  const entry = dsh.resolveEntry({ dshBin: null }, { DSH_DESKTOP_DSH_BIN: '/opt/dsh' })
  assert.deepStrictEqual(entry, { kind: 'external', entry: '/opt/dsh' })
})

test('buildPath dedupes and keeps a stable order', () => {
  const p = dsh.buildPath({ PATH: '/opt/homebrew/bin:/usr/bin' })
  const parts = p.split(':')
  assert.strictEqual(new Set(parts).size, parts.length)
  assert.ok(parts.includes('/opt/homebrew/bin'))
  assert.ok(parts.includes('/usr/bin'))
  assert.ok(parts.includes('/bin'))
  assert.ok(parts.indexOf('/opt/homebrew/bin') < parts.indexOf('/usr/bin'))
})

test('buildEnv carries ELECTRON_RUN_AS_NODE and passthrough vars', () => {
  const env = dsh.buildEnv({ ELECTRON_RUN_AS_NODE: '1' }, { HOME: '/home/u', DSH_HOME: '/home/u/.dsh' })
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1')
  assert.strictEqual(env.HOME, '/home/u')
  assert.strictEqual(env.DSH_HOME, '/home/u/.dsh')
  assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0)
})
