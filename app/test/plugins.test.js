'use strict'

const test = require('node:test')
const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')
const plugins = require('../src/plugins')

test('dshHome defaults to ~/.dsh', () => {
  assert.strictEqual(plugins.dshHome({}), path.join(os.homedir(), '.dsh'))
})

test('dshHome honors DSH_HOME', () => {
  assert.strictEqual(plugins.dshHome({ DSH_HOME: '/x/y' }), '/x/y')
})

test('dshHome treats blank DSH_HOME as unset', () => {
  assert.strictEqual(plugins.dshHome({ DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'))
})

test('profileNodeModules joins profile node_modules under dsh home', () => {
  assert.strictEqual(
    plugins.profileNodeModules('web', { HOME: '/Users/u' }),
    path.join('/Users/u', '.dsh', 'profiles', 'web', 'node_modules'),
  )
})

test('patchContent inserts both plugins', () => {
  const yaml = plugins.patchContent()
  assert.ok(yaml.startsWith('- insert:'))
  assert.ok(yaml.includes("name: '@omnilyra/desktop-host'"))
  assert.ok(yaml.includes("name: '@omnilyra/desktop-notifications'"))
})

test('pluginRoot resolves the scoped package dir', () => {
  const root = plugins.pluginRoot('desktop-host')
  assert.strictEqual(path.basename(root), 'desktop-host')
  assert.ok(require('node:fs').existsSync(path.join(root, 'package.json')))
})
