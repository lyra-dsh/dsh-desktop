'use strict'

// 构建后对 macOS .app 做 ad-hoc 临时签名（本地跑系统通知需要有效代码签名）。
// 仅在 macOS 上生效；其它系统直接跳过（electron-builder --mac 本身也只应在 mac 上跑）。
// 注意：ad-hoc 签名只能用于本地测试，不能用于分发（需 Developer ID + 公证）。

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'darwin') {
  console.log('[sign-mac] skipped: not on macOS')
  process.exit(0)
}

// 找 release/<dir>/Dsh-Desktop.app（mac-arm64 / mac / mac-x64 等目录下）。
const releaseDir = path.join(__dirname, '..', 'release')
let appPath = null
try {
  for (const name of fs.readdirSync(releaseDir)) {
    const candidate = path.join(releaseDir, name, 'Dsh-Desktop.app')
    if (fs.existsSync(candidate)) {
      appPath = candidate
      break
    }
  }
} catch { /* release 目录不存在 */ }

if (!appPath) {
  console.error('[sign-mac] Dsh-Desktop.app not found under release/')
  process.exit(1)
}

const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
if (result.status !== 0) {
  console.error('[sign-mac] codesign failed')
  process.exit(result.status || 1)
}
console.log('[sign-mac] ad-hoc signed:', appPath)
