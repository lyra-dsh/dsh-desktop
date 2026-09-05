'use strict'

/**
 * auto 模式的更新目标：包一层 electron-updater 的 autoUpdater。
 *
 * 用于 Windows（NSIS）/ Linux（AppImage）——这两个平台无签名也能 quitAndInstall。
 * macOS 因需要 Developer ID 签名，请改用 feed-target（manual 模式）。
 *
 * electron-updater 懒加载：require 本模块本身不会加载 electron-updater，只有第一次
 * check/download/install 时才 require，因此非 Electron 环境 require 本模块也不报错。
 */
function createElectronUpdaterTarget({
  id,
  label,
  currentVersion,
  isPackaged = () => true,
  devUpdateConfigPath = null,
}) {
  let updater = null

  function getUpdater() {
    if (updater) return updater
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = false // 下载由 core 的 autoDownload 驱动，避免双重下载
    autoUpdater.autoInstallOnAppQuit = false // 安装由 core 的 install() 显式触发
    if (!isPackaged() && devUpdateConfigPath) {
      autoUpdater.updateConfigPath = devUpdateConfigPath
      autoUpdater.forceDevUpdateConfig = true
    }
    updater = autoUpdater
    return updater
  }

  return {
    id,
    label,
    currentVersion: () => currentVersion(),
    async check() {
      // 未打包（dev）且没给 dev 配置时优雅跳过：autoUpdater 会因缺 app-update.yml 抛错。
      if (!isPackaged() && !devUpdateConfigPath) return null
      const au = getUpdater()
      const result = await au.checkForUpdates()
      if (result && result.updateInfo && result.updateInfo.version) {
        return { version: result.updateInfo.version, currentVersion: currentVersion() }
      }
      return null
    },
    async download(onProgress) {
      const au = getUpdater()
      const onProgressEvent = (p) => { if (onProgress) onProgress(Math.round(p.percent || 0)) }
      au.on('download-progress', onProgressEvent)
      try {
        if (onProgress) onProgress(0)
        await au.downloadUpdate()
        if (onProgress) onProgress(100)
      } finally {
        au.removeListener('download-progress', onProgressEvent)
      }
    },
    install() {
      getUpdater().quitAndInstall()
    },
  }
}

module.exports = { createElectronUpdaterTarget }
