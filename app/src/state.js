'use strict'

// Managed state carrying the dsh child process, process-group teardown, and shutdown intent
// (Electron port of state.rs). The child is spawned detached (its own process group), so the
// group id equals the child pid.

class DshState {
  constructor(child) {
    this._child = child
    this._pid = child && child.pid != null ? child.pid : (typeof child === 'number' ? child : null)
    this.shuttingDown = false
  }

  pid() {
    return this._pid
  }

  /** Take and clear the pid, making teardown idempotent. */
  takePid() {
    const pid = this._pid
    this._pid = null
    return pid
  }

  /** Send a signal to the whole dsh process group. */
  signal(sig) {
    const pid = this._pid
    if (pid === null || pid === undefined) return
    try {
      process.kill(-pid, sig)
    } catch {
      // Process group already gone; ignore.
    }
  }

  /**
   * Graceful teardown: SIGTERM now, then SIGKILL after a grace period.
   * 观察子进程退出以提前收尾(不再傻等 graceMs);`done` 在 teardown 后调用
   * (或没有 pid 时立即调用)。置位 shuttingDown,用于区分主动退出与崩溃。
   */
  killGracefully(graceMs, done) {
    this.shuttingDown = true
    const pid = this.takePid()
    if (pid === null || pid === undefined) {
      if (done) done()
      return
    }
    let finished = false
    let timer
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (done) done()
    }
    const child = this._child
    if (child && typeof child.once === 'function') child.once('exit', finish)
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {}
    timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
      finish()
    }, graceMs)
  }
}

module.exports = { DshState }
