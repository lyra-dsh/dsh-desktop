'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createUpdater, createFeedTarget, compareVersions, createElectronUpdaterTarget, createNpmPackageTarget } = require('@omnilyra/desktop-updater')
const config = require('../src/config')

function mockTarget(overrides = {}) {
  return {
    id: 'shell',
    label: 'Shell',
    currentVersion: () => '0.2.0',
    check: async () => null,
    download: async () => {},
    install: () => {},
    ...overrides,
  }
}

function collectStates(updater) {
  const states = []
  updater.subscribe((s) => { if (states[states.length - 1] !== s.state) states.push(s.state) })
  return states
}

test('updater: check → available → (auto) download → downloaded', async () => {
  const updater = createUpdater({
    targets: [mockTarget({
      check: async () => ({ version: '0.3.0', currentVersion: '0.2.0' }),
      download: async (onProgress) => { onProgress && onProgress(50) },
    })],
  })
  const states = collectStates(updater)
  await updater.check()
  assert.deepStrictEqual(states, ['checking', 'available', 'downloading', 'downloaded'])
  assert.strictEqual(updater.getStatus().version, '0.3.0')
  assert.strictEqual(updater.getStatus().percent, 100)
})

test('updater: no update → not-available', async () => {
  const updater = createUpdater({ targets: [mockTarget()] })
  const states = collectStates(updater)
  await updater.check()
  assert.deepStrictEqual(states, ['checking', 'not-available'])
})

test('updater: autoDownload=false stops at available', async () => {
  const updater = createUpdater({
    targets: [mockTarget({ check: async () => ({ version: '0.3.0' }) })],
    autoDownload: false,
  })
  const states = collectStates(updater)
  await updater.check()
  assert.deepStrictEqual(states, ['checking', 'available'])
})

test('updater: download error → error', async () => {
  const updater = createUpdater({
    targets: [mockTarget({
      check: async () => ({ version: '0.3.0' }),
      download: async () => { throw new Error('boom') },
    })],
  })
  const states = collectStates(updater)
  await updater.check()
  assert.deepStrictEqual(states, ['checking', 'available', 'downloading', 'error'])
  assert.strictEqual(updater.getStatus().error, 'boom')
})

test('updater: install delegates to the active target', async () => {
  let installed = false
  const updater = createUpdater({
    targets: [mockTarget({
      check: async () => ({ version: '0.3.0' }),
      install: () => { installed = true },
    })],
    autoDownload: false,
  })
  await updater.check()
  updater.install()
  assert.strictEqual(installed, true)
})

test('updater: a failing target does not block later targets', async () => {
  const updater = createUpdater({
    targets: [
      mockTarget({ id: 'a', check: async () => { throw new Error('x') } }),
      mockTarget({ id: 'b', check: async () => ({ version: '0.3.0' }) }),
    ],
    autoDownload: false,
  })
  const states = collectStates(updater)
  await updater.check()
  assert.deepStrictEqual(states, ['checking', 'available'])
  assert.strictEqual(updater.getStatus().target, 'b')
})

test('compareVersions orders numeric dotted versions', () => {
  assert.strictEqual(compareVersions('0.3.0', '0.2.0'), 1)
  assert.strictEqual(compareVersions('0.2.0', '0.3.0'), -1)
  assert.strictEqual(compareVersions('0.2.0', '0.2.0'), 0)
  assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1)
})

test('feed target: check returns update info when newer', async () => {
  const target = createFeedTarget({
    id: 'shell',
    label: 'Shell',
    feedUrl: 'https://x/latest.json',
    currentVersion: () => '0.2.0',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.3.0', url: 'https://x/App.dmg' }) }),
    downloadsDir: () => '/tmp',
    openFile: () => {},
  })
  const info = await target.check()
  assert.deepStrictEqual(info, { version: '0.3.0', currentVersion: '0.2.0', releaseUrl: 'https://x/App.dmg' })
})

test('feed target: check returns null when not newer', async () => {
  const target = createFeedTarget({
    id: 'shell',
    label: 'Shell',
    feedUrl: 'https://x/latest.json',
    currentVersion: () => '0.3.0',
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.2.0', url: 'https://x/App.dmg' }) }),
    downloadsDir: () => '/tmp',
    openFile: () => {},
  })
  assert.strictEqual(await target.check(), null)
})

test('feed target: download writes file and install opens it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-'))
  let opened = null
  const bytes = Uint8Array.from([1, 2, 3, 4])
  const target = createFeedTarget({
    id: 'shell',
    label: 'Shell',
    feedUrl: 'https://x/latest.json',
    currentVersion: () => '0.2.0',
    fetchFn: async (url) => {
      if (url.endsWith('latest.json')) {
        return { ok: true, status: 200, json: async () => ({ version: '0.3.0', url: 'https://x/App-0.3.0.dmg' }) }
      }
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer }
    },
    downloadsDir: () => dir,
    openFile: (p) => { opened = p },
  })
  await target.check()
  const progress = []
  await target.download((p) => progress.push(p))
  target.install()
  assert.deepStrictEqual(progress, [0, 100])
  assert.strictEqual(opened, path.join(dir, 'App-0.3.0.dmg'))
  assert.deepStrictEqual([...fs.readFileSync(opened)], [1, 2, 3, 4])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('electron target: dev mode without config skips check (no electron-updater load)', async () => {
  const target = createElectronUpdaterTarget({
    id: 'shell',
    label: 'Shell',
    currentVersion: () => '0.2.0',
    isPackaged: () => false,
  })
  assert.strictEqual(await target.check(), null)
})

test('npm target: check returns version when newer', async () => {
  const target = createNpmPackageTarget({
    id: 'dsh',
    label: 'dsh',
    packageName: '@deepseek-ai/dsh',
    currentVersion: () => '0.1.0',
    apply: async () => {},
    fetchFn: async (url) => {
      assert.ok(url.includes('@deepseek-ai%2Fdsh'))
      return { ok: true, status: 200, json: async () => ({ version: '0.2.0' }) }
    },
  })
  assert.deepStrictEqual(await target.check(), { version: '0.2.0', currentVersion: '0.1.0' })
})

test('npm target: check returns null when not newer', async () => {
  const target = createNpmPackageTarget({
    id: 'dsh',
    label: 'dsh',
    packageName: '@deepseek-ai/dsh',
    currentVersion: () => '0.2.0',
    apply: async () => {},
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.1.0' }) }),
  })
  assert.strictEqual(await target.check(), null)
})

test('npm target: install calls apply with the available version', async () => {
  let applied = null
  const target = createNpmPackageTarget({
    id: 'dsh',
    label: 'dsh',
    packageName: '@deepseek-ai/dsh',
    currentVersion: () => '0.1.0',
    apply: async (v) => { applied = v },
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.2.0' }) }),
  })
  await target.check()
  await target.download(() => {})
  target.install()
  assert.strictEqual(applied, '0.2.0')
})

test('config: updater defaults', () => {
  const cfg = config.loadFrom('/nonexistent-config.json')
  assert.deepStrictEqual(cfg.updater, {
    enabled: true,
    autoCheck: true,
    autoDownload: true,
    feedUrl: null,
    runtime: { mode: null, package: '@deepseek-ai/dsh' },
  })
})

test('config: updater section merges sub-keys with defaults', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-')), 'config.json')
  fs.writeFileSync(file, JSON.stringify({ updater: { feedUrl: 'https://x/latest.json', runtime: { mode: 'none' } } }))
  const cfg = config.loadFrom(file)
  assert.deepStrictEqual(cfg.updater, {
    enabled: true,
    autoCheck: true,
    autoDownload: true,
    feedUrl: 'https://x/latest.json',
    runtime: { mode: 'none', package: '@deepseek-ai/dsh' },
  })
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})
