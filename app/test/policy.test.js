'use strict'

const test = require('node:test')
const assert = require('node:assert')
const policy = require('../src/policy')
const { resolveDshMode } = require('../src/main.js')

test('IPC allowlist permits capability methods', () => {
  for (const m of ['notify', 'setBadge', 'setKeepAwake', 'addTrayItem', 'removeTrayItem', 'requestQuit', 'requestRestart', 'show', 'hide', 'openExternal', 'pickDirectory', 'showMessageBox']) {
    assert.strictEqual(policy.isAllowedMethod(m), true, `${m} should be allowed`)
  }
})

test('IPC allowlist rejects shell-lifecycle and unknown methods', () => {
  for (const m of ['createMainWindow', 'setUpdater', 'toggleKeepAwake', 'isKeepAwakeEnabled', 'clearBadge', 'prepareToQuit', 'setTray', 'quit', 'restart', 'openWindow', 'constructor', 'toString']) {
    assert.strictEqual(policy.isAllowedMethod(m), false, `${m} should be rejected`)
  }
})

test('event forwarding: quit/requested not forwarded, others forwarded', () => {
  assert.strictEqual(policy.shouldForwardEvent('quit/requested'), false)
  for (const t of ['tray/activated', 'tray/item-activated', 'window/visibility', 'window/close-requested', 'renderer/boot', 'update/state']) {
    assert.strictEqual(policy.shouldForwardEvent(t), true, `${t} should be forwarded`)
  }
})

test('resolveDshMode: explicit dshBin → none', () => {
  const cfg = { dshBin: '/x/dsh', updater: {} }
  assert.strictEqual(resolveDshMode(cfg, { kind: 'external', entry: '/x/dsh' }), 'none')
})

test('resolveDshMode: bundled → auto, system → notify, explicit runtime.mode wins', () => {
  assert.strictEqual(resolveDshMode({ dshBin: null, updater: {} }, { kind: 'bundled', entry: '/bin.js' }), 'auto')
  assert.strictEqual(resolveDshMode({ dshBin: null, updater: {} }, { kind: 'external', entry: '/usr/local/bin/dsh' }), 'notify')
  assert.strictEqual(resolveDshMode({ dshBin: null, updater: { runtime: { mode: 'none' } } }, { kind: 'bundled', entry: '/bin.js' }), 'none')
})
