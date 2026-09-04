'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const config = require('../src/config')

test('defaultConfigJson parses and matches defaults', () => {
  const json = config.defaultConfigJson()
  const cfg = JSON.parse(json)
  assert.strictEqual(cfg.profile, 'web')
  assert.strictEqual(cfg.dshBin, null)
  assert.strictEqual(cfg.host, '127.0.0.1')
  assert.strictEqual(cfg.port, 0)
  assert.strictEqual(cfg.openBrowser, false)
  assert.strictEqual(cfg.notify, true)
  assert.deepStrictEqual(cfg.extraArgs, [])
  assert.strictEqual(cfg.editor, null)
})

test('toCliArgs default passes --port 0 (OS-assigned)', () => {
  assert.deepStrictEqual(
    config.toCliArgs({ ...config.DEFAULT_CONFIG }),
    ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
  )
})

test('toCliArgs with port and extra args and openBrowser', () => {
  const cfg = { ...config.DEFAULT_CONFIG, port: 8080, openBrowser: true, extraArgs: ['--trusted-host', 'app.internal'] }
  assert.deepStrictEqual(
    config.toCliArgs(cfg),
    ['--profile', 'web', '--host', '127.0.0.1', '--port', '8080', '--trusted-host', 'app.internal'],
  )
})

test('toCliArgs omits --port only when null', () => {
  const cfg = { ...config.DEFAULT_CONFIG, port: null }
  assert.deepStrictEqual(
    config.toCliArgs(cfg),
    ['--profile', 'web', '--host', '127.0.0.1', '--no-open'],
  )
})

test('configDir leaf name is lyra-dsh', () => {
  const dir = config.configDir({ HOME: '/Users/tester' })
  assert.strictEqual(path.basename(dir), 'lyra-dsh')
})

test('configPath honors DSH_DESKTOP_CONFIG override', () => {
  assert.strictEqual(config.configPath({ DSH_DESKTOP_CONFIG: '/tmp/x.json' }), '/tmp/x.json')
})

test('ensureDefault creates a parseable file and loadFrom round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'))
  try {
    const file = path.join(dir, 'config.json')
    config.ensureDefault(file)
    assert.ok(fs.existsSync(file))
    const cfg = config.loadFrom(file)
    assert.strictEqual(cfg.profile, 'web')
    assert.strictEqual(cfg.port, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadFrom falls back per-key for missing keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'))
  try {
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify({ profile: 'tui' }))
    const cfg = config.loadFrom(file)
    assert.strictEqual(cfg.profile, 'tui')
    assert.strictEqual(cfg.host, '127.0.0.1')
    assert.strictEqual(cfg.port, 0)
    assert.deepStrictEqual(cfg.extraArgs, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadFrom returns defaults when the file is missing', () => {
  const cfg = config.loadFrom('/nonexistent/dsh-desktop-config.json')
  assert.strictEqual(cfg.profile, 'web')
})
