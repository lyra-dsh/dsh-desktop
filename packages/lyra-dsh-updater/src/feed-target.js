'use strict'

const fs = require('node:fs')
const path = require('node:path')
const semver = require('semver')

/** 版本比较：委托 semver 处理预发布序。返回负数/0/正数。 */
function compareVersions(a, b) {
  return semver.compare(a, b)
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
