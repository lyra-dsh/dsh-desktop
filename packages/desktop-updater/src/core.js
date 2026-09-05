'use strict'

/**
 * 框架无关的升级核心：状态机 + 目标抽象。
 *
 * 每个「更新目标」实现同一接口：
 *   { id, label, currentVersion(), check(), download(onProgress), install() }
 *
 * 这里把它们编排成统一的 检查 → 下载 → 安装 流程，并把状态以
 * `{ state, target, version, ... }` 形状推给订阅者。不依赖 electron /
 * electron-updater / dsh —— 纯逻辑，可单测。
 */

function createUpdater({ targets = [], autoDownload = true } = {}) {
  const listeners = new Set()
  let status = { state: 'idle' }
  let activeTarget = null
  let available = null

  function emit(patch) {
    status = { ...status, ...patch }
    for (const fn of [...listeners]) {
      try { fn(status) } catch (cause) { console.error('[desktop-updater] listener error:', cause) }
    }
    return status
  }

  async function check() {
    emit({ state: 'checking' })
    activeTarget = null
    available = null
    for (const target of targets) {
      try {
        const info = await target.check()
        if (info) {
          activeTarget = target
          available = { target: target.id, ...info }
          break
        }
      } catch (cause) {
        // 单个目标失败不中断整体；记日志后继续下一个目标。
        console.error(`[desktop-updater] check error on "${target.id}":`, cause)
      }
    }
    if (available) {
      emit({ state: 'available', ...available })
      if (autoDownload) await download()
    } else {
      emit({ state: 'not-available' })
    }
    return status
  }

  async function download() {
    if (!activeTarget || !available) return status
    emit({ state: 'downloading', ...available, percent: 0 })
    try {
      await activeTarget.download((percent) => emit({ percent }))
      emit({ state: 'downloaded', ...available, percent: 100 })
    } catch (cause) {
      emit({ state: 'error', error: String(cause && cause.message ? cause.message : cause) })
    }
    return status
  }

  function install() {
    if (!activeTarget) return
    try {
      activeTarget.install()
    } catch (cause) {
      console.error('[desktop-updater] install error:', cause)
    }
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    check,
    download,
    install,
    getStatus: () => status,
  }
}

module.exports = { createUpdater }
