'use strict'

// Managed state carrying the dsh child process id, and process-group teardown
// (Electron port of state.rs). The child is spawned detached (its own process
// group), so the group id equals the child pid.

class DshState {
  constructor(pid) {
    this._pid = pid
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
   * `done` is called after the SIGKILL is sent (or immediately if there is no pid).
   */
  killGracefully(graceMs, done) {
    const pid = this.takePid()
    if (pid === null || pid === undefined) {
      if (done) done()
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
      if (done) done()
    }, graceMs)
  }
}

module.exports = { DshState }
