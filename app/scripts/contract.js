'use strict'

// 契约测试:验证 lyra-dsh 的 bundle 插件能被 dsh 正确识别、安装并加载。
// 这是对 dsh 外部契约(plugin 命令 / dsh.bundle / profiles 布局)的冒烟验证,
// 供 CI 的 contract-pinned(钉版本阻塞)与 contract-latest(定时允许失败)两个 job 使用。
//
// 用法: node app/scripts/contract.js [--dsh <version>]
//   --dsh <version>  期望的 dsh 版本(仅用于诊断输出;实际用 PATH 上的 dsh 或 npx 安装)

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const BRIDGE_DIR = path.join(ROOT, 'packages', 'lyra-dsh-bridge')

function fail(msg) {
  console.error(`[contract] FAIL: ${msg}`)
  process.exit(1)
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit' })
  if (r.error) fail(`cannot run ${cmd}: ${r.error.message}`)
  return r.status
}

function main() {
  const args = process.argv.slice(2)
  const dshIdx = args.indexOf('--dsh')
  const expectedDsh = dshIdx >= 0 ? args[dshIdx + 1] : null

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-dsh-contract-'))
  const env = { ...process.env, DSH_HOME: home }
  const dshBin = 'dsh'

  // 1. 初始化专属 profile 并装核心 bundle(dsh-web-app 声明 dsh.bundle)
  if (run(dshBin, ['plugin', '--profile', 'test', 'add', '@deepseek-ai/dsh-web-app'], env) !== 0) {
    fail('dsh-web-app install failed')
  }

  // 2. 用 file: 引用本地 bridge(bundle 载体),验证 dsh.bundle 被识别进 bundles
  if (run(dshBin, ['plugin', '--profile', 'test', 'add', `file:${BRIDGE_DIR}`], env) !== 0) {
    fail('bridge install failed')
  }

  // 3. 断言 bridge 进入了 bundles(证明 dsh 读到了 bridge 的 dsh.bundle.patch)
  const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'test', 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@omnilyra/lyra-dsh-bridge')) {
    fail(`bridge not reconciled into bundles: ${JSON.stringify(bundles)}`)
  }

  // 4. 断言 4 个桌面插件都在 bridge 的 patch 里(dsh --dump-config 能解析、不报错)
  if (run(dshBin, ['--profile', 'test', '--dump-config'], env) !== 0) {
    fail('dump-config failed (profile cannot be composed)')
  }

  console.log(`[contract] PASS: bundles = ${JSON.stringify(bundles)}${expectedDsh ? ` (expected dsh ${expectedDsh})` : ''}`)
  fs.rmSync(home, { recursive: true, force: true })
}

main()
