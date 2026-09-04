'use strict'

// 桌面插件注入：把随壳子打包的 @omnilyra/desktop-host + desktop-notifications
// 复制进 dsh 的 profile node_modules，并生成 --patch 覆盖层把它们挂进 dsh。
//
// dsh 解析插件「先从 dsh 安装目录，再从 profile 自身的 node_modules」；我们把
// 插件放到 profile 的 node_modules，这样系统 dsh 和兜底 dsh 都能解析到，且不
// 触碰 dsh 安装目录。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')

const PLUGINS = ['desktop-host', 'desktop-notifications', 'desktop-badge', 'desktop-keep-awake', 'desktop-opener']

/** Map app.asar → app.asar.unpacked（与 dsh.js 同款）。 */
function unpackedAsarPath(p) {
  return p.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
}

/** dsh 数据根：$DSH_HOME || ~/.dsh（与 @deepseek-ai/dsh-home-paths 一致）。 */
function dshHome(env = process.env) {
  const h = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : path.join(env.HOME || os.homedir(), '.dsh')
  return h
}

function profileNodeModules(profile, env = process.env) {
  return path.join(dshHome(env), 'profiles', profile, 'node_modules')
}

/** 打包进来的插件包根目录（dev 是 workspace 符号链接；prod 是 unpacked 物理路径）。 */
function pluginRoot(name) {
  const pkgJson = require.resolve(`@omnilyra/${name}/package.json`)
  return path.dirname(unpackedAsarPath(pkgJson))
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

/** 把一个插件包复制进 profile node_modules/@omnilyra/<name>（跳过 node_modules）。 */
function installPlugin(name, omnilyraDir) {
  const root = pluginRoot(name)
  const dst = path.join(omnilyraDir, name)
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const s = path.join(root, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function patchContent() {
  return [
    '- insert:',
    '    - id: desktop-host',
    "      name: '@omnilyra/desktop-host'",
    '    - id: desktop-notifications',
    "      name: '@omnilyra/desktop-notifications'",
    '    - id: desktop-badge',
    "      name: '@omnilyra/desktop-badge'",
    '    - id: desktop-keep-awake',
    "      name: '@omnilyra/desktop-keep-awake'",
    '    - id: desktop-opener',
    "      name: '@omnilyra/desktop-opener'",
    '',
  ].join('\n')
}

/**
 * 幂等安装插件 + 写 --patch；返回追加到 dsh argv 的片段。
 * @returns {string[]}
 */
function ensureDesktopPlugins(profile, env = process.env) {
  const omnilyraDir = path.join(profileNodeModules(profile, env), '@omnilyra')
  for (const name of PLUGINS) installPlugin(name, omnilyraDir)
  const patchPath = path.join(app.getPath('userData'), 'dsh-desktop.patch.yml')
  fs.writeFileSync(patchPath, patchContent())
  return ['--patch', patchPath]
}

module.exports = {
  dshHome,
  profileNodeModules,
  pluginRoot,
  patchContent,
  ensureDesktopPlugins,
}
