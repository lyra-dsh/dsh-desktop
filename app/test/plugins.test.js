'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const backend = require('@omnilyra/lyra-dsh-backend')

test('dshHome defaults to ~/.dsh', () => {
  assert.strictEqual(backend.dshHome({}), path.join(os.homedir(), '.dsh'))
})

test('dshHome honors DSH_HOME', () => {
  assert.strictEqual(backend.dshHome({ DSH_HOME: '/x/y' }), '/x/y')
})

test('dshHome treats blank DSH_HOME as unset', () => {
  assert.strictEqual(backend.dshHome({ DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'))
})

test('profileNodeModules joins profile node_modules under dsh home', () => {
  assert.strictEqual(
    backend.profileNodeModules('lyra-dsh', { HOME: '/Users/u' }),
    path.join('/Users/u', '.dsh', 'profiles', 'lyra-dsh', 'node_modules'),
  )
})

test('profilePackageJson joins profile package.json under dsh home', () => {
  assert.strictEqual(
    backend.profilePackageJson('/tmp/dsh-home', 'lyra-dsh'),
    path.join('/tmp/dsh-home', 'profiles', 'lyra-dsh', 'package.json'),
  )
})

test('readDeps returns dependencies from a profile package.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-dsh-backend-'))
  try {
    const file = path.join(tmp, 'package.json')
    fs.writeFileSync(file, JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-web-app': '^1.0.0', x: '1.0.0' },
    }))
    assert.deepStrictEqual(backend.readDeps(file), {
      '@deepseek-ai/dsh-web-app': '^1.0.0',
      x: '1.0.0',
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('readDeps returns {} when package.json is missing', () => {
  assert.deepStrictEqual(backend.readDeps(path.join(os.tmpdir(), 'no-such-profile-pkg.json')), {})
})

test('readDeps returns {} when dependencies is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-dsh-backend-'))
  try {
    const file = path.join(tmp, 'package.json')
    fs.writeFileSync(file, JSON.stringify({ name: 'no-deps' }))
    assert.deepStrictEqual(backend.readDeps(file), {})
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('bootstrapProfile is a no-op when core bundles are already present', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-dsh-backend-'))
  try {
    const profileDir = path.join(home, 'profiles', 'lyra-dsh')
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        '@deepseek-ai/dsh-web-app': '^1.0.0',
        '@omnilyra/lyra-dsh-bridge': '0.2.0',
      },
    }))
    // entry 不会被用到（所有核心层都已满足），用一个不可能执行的入口兜底。
    const entry = { kind: 'external', entry: '/bin/false' }
    assert.doesNotThrow(() => backend.bootstrapProfile(entry, 'lyra-dsh', {
      home,
      bridgeVersion: '0.2.0',
    }))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
