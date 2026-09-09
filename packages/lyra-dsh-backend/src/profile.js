'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 核心层:bundle 载体。bridge 是 @omnilyra/lyra-dsh-bridge
const CORE_BUNDLES = ['@deepseek-ai/dsh-web-app', '@omnilyra/lyra-dsh-bridge']

// 用已解析的 dsh 入口执行 `dsh plugin --profile <name> add <pkg>`
// entry 形如 { kind: 'external'|'bundled', entry: <path> }
function runPluginAdd(entry, profile, pkg) {
  const args = ['plugin', '--profile', profile, 'add', pkg]
  if (entry.kind === 'bundled') {
    return spawnSync(process.execPath, ['--expose-internals', entry.entry, ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  }
  return spawnSync(entry.entry, args, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
}

function profilePackageJson(home, profile) {
  const h = home || process.env.DSH_HOME || path.join(process.env.HOME || require('node:os').homedir(), '.dsh')
  return path.join(h, 'profiles', profile, 'package.json')
}

// 读 profile 的 dependencies 对象(不存在返回 {})
function readDeps(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).dependencies ?? {} } catch { return {} }
}

/**
 * 幂等 bootstrap:核心层缺/版本不符则 plugin add(失败抛错);便利层缺则尝试 add(失败仅警告)。
 * @param entry 已解析 dsh 入口 {kind, entry}
 * @param profile profile 名
 * @param opts { extras?: string[], bridgeVersion?: string, home?: string }
 */
function bootstrapProfile(entry, profile, opts = {}) {
  const home = opts.home
  const file = profilePackageJson(home, profile)
  const extras = opts.extras ?? []
  const bridgeVersion = opts.bridgeVersion

  for (const pkg of CORE_BUNDLES) {
    const deps = readDeps(file)
    let need = !(pkg in deps)
    // bridge 需要精确匹配壳子版本;dsh-web-app 只判存在(版本由 dsh 生态管理)
    if (!need && pkg === '@omnilyra/lyra-dsh-bridge' && bridgeVersion && deps[pkg] !== bridgeVersion) need = true
    if (!need) continue
    const r = runPluginAdd(entry, profile, pkg)
    if (r.status !== 0) throw new Error(`failed to install core bundle ${pkg}: exit ${r.status}`)
  }

  for (const pkg of extras) {
    if (pkg in readDeps(file)) continue
    const r = runPluginAdd(entry, profile, pkg)
    if (r.status !== 0) console.warn(`[lyra-dsh-backend] optional plugin ${pkg} install failed (exit ${r.status}), continuing`)
  }
}

module.exports = { CORE_BUNDLES, runPluginAdd, profilePackageJson, readDeps, bootstrapProfile }
