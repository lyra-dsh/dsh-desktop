'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 版本比较：按 ./- 分段，数字段数值比较、非数字段字典序比较。 */
function compareVersions(a, b) {
  const parse = (v) => String(v).split(/[.-]/).map((s) => (/^\d+$/.test(s) ? parseInt(s, 10) : s))
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y ? 1 : -1
    } else {
      const xs = String(x)
      const ys = String(y)
      if (xs !== ys) return xs > ys ? 1 : -1
    }
  }
  return 0
}

/**
 * manual 模式的更新目标：从版本清单 URL 检查新版本、下载安装包到本地、再打开。
 *
 * 清单 JSON 形状：{ "version": "0.3.0", "url": "https://…/App-0.3.0.dmg" }
 *
 * `downloadsDir` / `openFile` / `fetchFn` 注入进来，便于测试（生产环境由 main.js 传入
 * Electron 的 app.getPath('downloads') / shell.openPath / 全局 fetch）。
 */
function createFeedTarget({
  id,
  label,
  feedUrl,
  currentVersion,
  fetchFn = fetch,
  downloadsDir,
  openFile,
}) {
  let available = null
  let localPath = null

  return {
    id,
    label,
    currentVersion: () => currentVersion(),
    async check() {
      const res = await fetchFn(feedUrl)
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`)
      const manifest = await res.json()
      if (!manifest || typeof manifest.version !== 'string' || typeof manifest.url !== 'string') {
        throw new Error('invalid feed manifest: expected { version, url }')
      }
      const cur = currentVersion()
      if (compareVersions(manifest.version, cur) > 0) {
        available = { version: manifest.version, url: manifest.url }
        return { version: manifest.version, currentVersion: cur, releaseUrl: manifest.url }
      }
      available = null
      return null
    },
    async download(onProgress) {
      if (!available) return
      if (onProgress) onProgress(0)
      const res = await fetchFn(available.url)
      if (!res.ok) throw new Error(`download HTTP ${res.status}`)
      const dir = downloadsDir()
      fs.mkdirSync(dir, { recursive: true })
      let filename = 'update'
      try { filename = path.basename(new URL(available.url).pathname) || 'update' } catch { /* 保持默认 */ }
      localPath = path.join(dir, filename)
      fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()))
      if (onProgress) onProgress(100)
    },
    install() {
      if (localPath) openFile(localPath)
    },
  }
}

module.exports = { createFeedTarget, compareVersions }
