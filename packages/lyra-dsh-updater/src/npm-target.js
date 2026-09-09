'use strict'

const { compareVersions } = require('./feed-target')

/**
 * npm 包更新目标：查 npm registry 的 latest 版本，与当前版本比较。
 * 「安装」动作（apply）由产品注入——比如「pnpm 重装 + 重启 dsh」或「只提示」。
 *
 * 通用性：packageName 不写死，任何 npm 分发的运行时都能用；非 npm 的自定义渠道请用
 * createFeedTarget（查 JSON 清单）。
 */
function createNpmPackageTarget({
  id,
  label,
  packageName,
  currentVersion,
  apply,
  fetchFn = fetch,
}) {
  let available = null
  // scoped 包名里的 '/' 需要编码为 %2F（@scope/pkg → @scope%2Fpkg）。
  const registryUrl = `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`

  return {
    id,
    label,
    currentVersion: () => currentVersion(),
    async check() {
      const res = await fetchFn(registryUrl)
      if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`)
      const manifest = await res.json()
      if (!manifest || typeof manifest.version !== 'string') throw new Error('invalid npm registry response')
      const cur = currentVersion()
      if (compareVersions(manifest.version, cur) > 0) {
        available = { version: manifest.version }
        return { version: manifest.version, currentVersion: cur }
      }
      available = null
      return null
    },
    async download(onProgress) {
      // npm 目标没有独立「下载」阶段：真正的拉取/重装由 install() 的 apply 完成。
      if (onProgress) onProgress(0)
      if (onProgress) onProgress(100)
    },
    install() {
      if (available && typeof apply === 'function') apply(available.version)
    },
  }
}

module.exports = { createNpmPackageTarget }
