'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const dsh = require('../src/dsh')
const config = require('../src/config')

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

test('resolveEntry: explicit dshBin wins', async () => {
  const entry = await dsh.resolveEntry({ dshBin: '/usr/bin/dsh' }, {})
  assert.deepStrictEqual(entry, { kind: 'external', entry: '/usr/bin/dsh' })
})

test('resolveEntry: env override wins over null dshBin', async () => {
  const entry = await dsh.resolveEntry({ dshBin: null }, { DSH_DESKTOP_DSH_BIN: '/opt/dsh' })
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

test('buildArgs puts launcher flags (--patch) before app flags (--host)', () => {
  const args = dsh.buildArgs({ ...config.DEFAULT_CONFIG }, ['--patch', '/tmp/x.yml'])
  // --profile <name> 之后紧跟启动器 flag，然后才是 --host
  assert.deepStrictEqual(args.slice(0, 4), ['--profile', 'web', '--patch', '/tmp/x.yml'])
  assert.strictEqual(args[4], '--host')
})

test('commonDshDirs includes nvm/homebrew/local bin locations', () => {
  const dirs = dsh.commonDshDirs({ HOME: '/Users/u' })
  assert.ok(dirs.includes('/Users/u/.local/bin'))
  assert.ok(dirs.includes('/Users/u/.bun/bin'))
  assert.ok(dirs.includes('/opt/homebrew/bin'))
  assert.ok(dirs.includes('/usr/local/bin'))
})

test('resolveSystemDsh finds dsh in a non-PATH nvm location', () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), '.test-nvm-'))
  try {
    const bin = path.join(tmp, '.nvm', 'versions', 'node', 'v24.15.0', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'dsh'), '')
    // PATH 里没有 dsh，但 nvm 目录里有 —— GUI 应用场景
    const found = dsh.resolveSystemDsh({ HOME: tmp, PATH: '/usr/bin:/bin' })
    assert.strictEqual(found, path.join(bin, 'dsh'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
