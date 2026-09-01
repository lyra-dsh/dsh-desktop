'use strict'

// dsh subprocess entry resolution, environment, spawning, and readiness probing
// (Electron port of dsh.rs). The dsh runtime is bundled as a dependency and run
// with Electron's own Node via the `runAsNode` fuse + `ELECTRON_RUN_AS_NODE=1`.
// An explicit `dshBin` (or `DSH_DESKTOP_DSH_BIN`) is a development escape hatch
// that spawns an external dsh command through its shebang instead.

const { spawn } = require('node:child_process')
const readline = require('node:readline')
const net = require('node:net')
const path = require('node:path')
const os = require('node:os')
const { toCliArgs } = require('./config')

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\S*/
const READY_TIMEOUT_MS = 60_000
const FALLBACK_PROBE_MS = 20_000
const PROBE_INTERVAL_MS = 500

/** Map a path inside app.asar to its sibling unpacked physical path. */
function unpackedAsarPath(p) {
  return p.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
}

/**
 * Resolve the dsh entry to spawn.
 * @returns {{ kind: 'bundled'|'external', entry: string }}
 */
function resolveEntry(cfg, env = process.env) {
  if (cfg.dshBin && String(cfg.dshBin).length > 0) {
    return { kind: 'external', entry: String(cfg.dshBin) }
  }
  if (env.DSH_DESKTOP_DSH_BIN && env.DSH_DESKTOP_DSH_BIN.length > 0) {
    return { kind: 'external', entry: env.DSH_DESKTOP_DSH_BIN }
  }
  const resolved = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  return { kind: 'bundled', entry: unpackedAsarPath(resolved) }
}

/** Build a deduped PATH: homebrew/system dirs followed by the existing PATH. */
function buildPath(env = process.env) {
  const parts = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  if (env.PATH) parts.push(...env.PATH.split(':').filter(Boolean))
  return [...new Set(parts)].join(':')
}

/** Environment passed to the dsh child (mirrors the Rust spawn). */
function buildEnv(extra = {}, env = process.env) {
  const out = { PATH: buildPath(env) }
  for (const key of ['HOME', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'USER']) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return Object.assign(out, extra)
}

/**
 * Spawn dsh. Bundled entries run under Electron-as-node (`ELECTRON_RUN_AS_NODE=1`);
 * external entries run as ordinary commands through their shebang.
 * `detached: true` puts the child in its own process group (pid == pgid).
 */
function spawnDsh(cfg, entry, env = process.env) {
  const args = toCliArgs(cfg)
  if (entry.kind === 'bundled') {
    // `--expose-internals` is required by dsh's loader/HMR service: under a real
    // Node the `node-addon-require-builtin` addon exposes internals, but it cannot
    // reach Electron's patched builtin registry, so we pass the flag explicitly.
    return spawn(process.execPath, ['--expose-internals', entry.entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildEnv({ [RUN_AS_NODE]: '1' }, env),
      detached: true,
    })
  }
  return spawn(entry.entry, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv({}, env),
    detached: true,
  })
}

/** The port we may probe if stdout doesn't reveal the URL soon enough. */
function resolveFallbackPort(cfg) {
  if (cfg.port === null || cfg.port === undefined) return 3080
  if (cfg.port === 0) return null
  return cfg.port
}

/** Poll until the loopback port accepts a TCP connection, or the timeout elapses. */
function probePort(port, timeoutMs = FALLBACK_PROBE_MS) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(ok)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() >= deadline) finish(false)
        else setTimeout(attempt, PROBE_INTERVAL_MS)
      })
    }
    attempt()
  })
}

/**
 * Wait until dsh reports its loopback URL on stdout (with a port-probe fallback),
 * capturing stderr for diagnostics. Resolves the URL, or rejects with an Error
 * carrying the captured stderr.
 */
function waitForReady(child, cfg, { readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let stderrBuf = ''
    let settled = false
    let readyTimer = null

    const captureUrl = (url) => {
      if (settled) return
      settled = true
      if (readyTimer) clearTimeout(readyTimer)
      resolve(url)
    }
    const fail = (detail) => {
      if (settled) return
      settled = true
      if (readyTimer) clearTimeout(readyTimer)
      reject(new Error(detail || 'dsh failed to start.'))
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderrBuf += chunk })
    }

    const detailFromStderr = (fallback) => {
      const t = stderrBuf.trim()
      return t.length > 0 ? t : fallback
    }

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      let sent = false
      rl.on('line', (line) => {
        if (sent) return
        const m = URL_RE.exec(line)
        if (m) {
          sent = true
          captureUrl(m[0])
        }
      })
      rl.on('close', () => {
        if (!sent && !settled) {
          // stdout closed before a URL appeared.
          fail(detailFromStderr('dsh exited before serving a URL.'))
        }
      })
    } else if (!settled) {
      fail('dsh exited before serving a URL.')
    }

    readyTimer = setTimeout(async () => {
      // Timed out waiting for the stdout line; fall back to probing the port.
      const port = resolveFallbackPort(cfg)
      if (port === null) {
        fail(detailFromStderr('dsh did not report a URL within the timeout.'))
        return
      }
      const up = await probePort(port)
      if (up) captureUrl(`http://127.0.0.1:${port}`)
      else fail(detailFromStderr(`dsh did not serve on port ${port} within the timeout.`))
    }, readyTimeoutMs)

    child.once('exit', (code, signal) => {
      if (settled) return
      // Child exited before we resolved; surface captured stderr.
      const fallback = signal
        ? `dsh exited on signal ${signal}.`
        : `dsh exited with code ${code}.`
      fail(detailFromStderr(fallback))
    })
  })
}

module.exports = {
  RUN_AS_NODE,
  unpackedAsarPath,
  resolveEntry,
  buildPath,
  buildEnv,
  spawnDsh,
  resolveFallbackPort,
  probePort,
  waitForReady,
  READY_TIMEOUT_MS,
  FALLBACK_PROBE_MS,
}
