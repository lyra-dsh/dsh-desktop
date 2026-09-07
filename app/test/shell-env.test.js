'use strict'

const test = require('node:test')
const assert = require('node:assert')
const {
  parseShellEnvPayload,
  resolveDesktopShellEnv,
} = require('../src/shell-env')

test('parseShellEnvPayload parses marker-delimited env records', () => {
  const payload = `START\0HOME=/home/u\0PATH=/usr/bin:/bin\0END\0`
  const env = parseShellEnvPayload(payload, 'START', 'END')
  assert.deepStrictEqual(env, { HOME: '/home/u', PATH: '/usr/bin:/bin' })
})

test('parseShellEnvPayload ignores shell startup noise outside markers', () => {
  const payload = `noise from startup files\nSTART\0HOME=/home/u\0END\0trailing noise\n`
  const env = parseShellEnvPayload(payload, 'START', 'END')
  assert.deepStrictEqual(env, { HOME: '/home/u' })
})

test('parseShellEnvPayload returns null when markers are missing', () => {
  assert.strictEqual(parseShellEnvPayload('no markers here', 'START', 'END'), null)
})

test('resolveDesktopShellEnv falls back when not packaged', async () => {
  const result = await resolveDesktopShellEnv({ isPackaged: false, platform: 'darwin' })
  assert.deepStrictEqual(result, { updates: {}, source: 'process', fallbackReason: 'not-packaged' })
})

test('resolveDesktopShellEnv falls back on unsupported platform', async () => {
  const result = await resolveDesktopShellEnv({ isPackaged: true, platform: 'win32' })
  assert.deepStrictEqual(result, { updates: {}, source: 'process', fallbackReason: 'unsupported-platform' })
})

test('resolveDesktopShellEnv falls back when capture fails', async () => {
  const result = await resolveDesktopShellEnv({
    isPackaged: true,
    platform: 'darwin',
    capture: async () => null,
  })
  assert.deepStrictEqual(result, { updates: {}, source: 'process', fallbackReason: 'capture-failed' })
})

test('resolveDesktopShellEnv falls back when captured env has no PATH', async () => {
  const result = await resolveDesktopShellEnv({
    isPackaged: true,
    platform: 'darwin',
    capture: async () => ({ HOME: '/home/u' }),
  })
  assert.deepStrictEqual(result, { updates: {}, source: 'process', fallbackReason: 'missing-path' })
})

test('resolveDesktopShellEnv merges captured values over inherited (full pass-through)', async () => {
  const result = await resolveDesktopShellEnv({
    environment: { PATH: '/minimal', HOME: '/home/u', EXISTING: 'keep-me' },
    isPackaged: true,
    platform: 'darwin',
    capture: async () => ({ PATH: '/full/path', HOME: '/home/u', NEW_VAR: 'from-shell' }),
  })
  assert.deepStrictEqual(result, {
    updates: { PATH: '/full/path', NEW_VAR: 'from-shell' },
    source: 'login-shell',
  })
})
