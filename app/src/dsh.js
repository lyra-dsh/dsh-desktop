'use strict'

// dsh 供给：系统 dsh 优先；找不到就运行时安装一份"私有 dsh"到 userData 目录，
// 用 Electron 的 Node（ELECTRON_RUN_AS_NODE + --expose-internals）跑。
// 显式 `dshBin`（或 DSH_DESKTOP_DSH_BIN）是开发逃生口，永远最优先。

const { spawn } = require('node:child_process')
const readline = require('node:readline')
const net = require('node:net')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app } = require('electron')
const { toCliArgs } = require('./config')

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const DSH_VERSION = '0.1.2-alpha.3'
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\S*/
const READY_TIMEOUT_MS = 60_000
const FALLBACK_PROBE_MS = 20_000
const PROBE_INTERVAL_MS = 500

// ---- 系统 dsh 检测：PATH 优先，再补常见安装位置 ----

/**
 * GUI 应用（Finder/Dock 启动）拿到的 PATH 是精简的，不含 nvm / homebrew 等目录；
 * 因此除了 PATH，再扫一遍常见安装位置。
 */
function commonDshDirs(env = process.env) {
  const home = env.HOME || os.homedir()
  const dirs = []
  // nvm 各版本 bin（npm i -g 装的 dsh 通常在这），新版本优先
  const nvm = path.join(home, '.nvm', 'versions', 'node')
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) {
      if (/^v\d/.test(v)) dirs.push(path.join(nvm, v, 'bin'))
    }
  } catch { /* 无 nvm */ }
  dirs.push(path.join(home, '.local', 'bin'))
  dirs.push(path.join(home, '.bun', 'bin'))
  dirs.push('/opt/homebrew/bin')
  dirs.push('/usr/local/bin')
  return dirs
}

/** 找系统 dsh：先 PATH，再常见位置；返回绝对路径或 null。 */
function resolveSystemDsh(env = process.env) {
  if (env.DSH_DESKTOP_DSH_BIN && env.DSH_DESKTOP_DSH_BIN.length > 0) {
    return env.DSH_DESKTOP_DSH_BIN
  }
  const dirs = []
  if (env.PATH) dirs.push(...env.PATH.split(':').filter(Boolean))
  dirs.push(...commonDshDirs(env))
  for (const dir of dirs) {
    if (!dir) continue
    const p = path.join(dir, 'dsh')
    if (fs.existsSync(p)) return p
  }
  return null
}

// ---- 私有 dsh（兜底安装）----
function provisionDir() {
  return path.join(app.getPath('userData'), 'dsh')
}

function provisionBinJs() {
  return path.join(provisionDir(), 'node_modules', DSH_PACKAGE, 'lib', 'bin.js')
}

function provisionMarker() {
  return path.join(provisionDir(), '.installed')
}

function provisioned() {
  return fs.existsSync(provisionMarker()) && fs.existsSync(provisionBinJs())
}

/**
 * 解析打包进来的 pnpm 的 CLI 入口。
 * pnpm 9 的 exports 把 "." 映射到 ./package.json，所以 require.resolve('pnpm')
 * 直接得到其 package.json 路径；由此推导 bin/pnpm.cjs 并映射到 unpacked 物理路径。
 */
function resolvePnpmCli() {
  const pkgPath = require.resolve('pnpm')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const rel = (pkg.bin && (pkg.bin.pnpm || (typeof pkg.bin === 'string' ? pkg.bin : null))) || null
  if (!rel) throw new Error('pnpm: no bin entry')
  return unpackedAsarPath(path.join(path.dirname(pkgPath), rel))
}

/** 用 Electron 的 Node 跑 pnpm，把 dsh 装到私有目录。 */
function runPnpmInstall(dir) {
  return new Promise((resolve, reject) => {
    const pnpm = resolvePnpmCli()
    const child = spawn(process.execPath, [pnpm, 'add', `${DSH_PACKAGE}@${DSH_VERSION}`, '--dir', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [RUN_AS_NODE]: '1' },
    })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        try { fs.writeFileSync(provisionMarker(), DSH_VERSION) } catch { /* 非致命：下次仍会重装 */ }
        resolve()
      } else {
        reject(new Error(`dsh 安装失败 (code ${code}): ${output.slice(-1500)}`))
      }
    })
  })
}

/** 安装并返回私有 dsh 的 bin.js；已装则直接复用。 */
async function provisionDsh() {
  const dir = provisionDir()
  if (provisioned()) return provisionBinJs()
  fs.mkdirSync(dir, { recursive: true })
  await runPnpmInstall(dir)
  return provisionBinJs()
}

// ---- 入口解析：显式 > 系统 > 私有兜底 ----
/**
 * @returns {Promise<{ kind: 'external'|'bundled', entry: string }>}
 */
async function resolveEntry(cfg, env = process.env) {
  if (cfg.dshBin && String(cfg.dshBin).length > 0) {
    return { kind: 'external', entry: String(cfg.dshBin) }
  }
  const sys = resolveSystemDsh(env)
  if (sys) return { kind: 'external', entry: sys }
  const binJs = await provisionDsh()
  return { kind: 'bundled', entry: binJs }
}

/** Map a path inside app.asar to its sibling unpacked physical path. */
function unpackedAsarPath(p) {
  return p.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
}

/** Build a deduped PATH: homebrew/system dirs followed by the existing PATH. */
function buildPath(env = process.env) {
  const parts = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  if (env.PATH) parts.push(...env.PATH.split(':').filter(Boolean))
  return [...new Set(parts)].join(':')
}

/** Environment passed to the dsh child. */
function buildEnv(extra = {}, env = process.env) {
  const out = { PATH: buildPath(env) }
  for (const key of ['HOME', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'USER']) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return Object.assign(out, extra)
}

/**
 * 组装 dsh argv。dsh 启动器只解析自己的 flag（--profile / --patch / --dump-* …），
 * 遇到第一个无法识别的 token 就把其后全部交给 profile 应用；因此启动器 flag 必须
 * 放在第一个应用 flag（--host / --port / --no-open）之前。
 */
function buildArgs(cfg, extraArgs = []) {
  const base = toCliArgs(cfg)
  // --profile <name> 是前两项；把 extraArgs（--patch 等启动器 flag）插在它之后。
  return [...base.slice(0, 2), ...extraArgs, ...base.slice(2)]
}

/**
 * Spawn dsh。`bundled`（私有/打包）用 Electron 的 Node 跑 bin.js；`external` 走 shebang。
 * `detached: true` 使其自成进程组（pid == pgid）。
 */
function spawnDsh(cfg, entry, env = process.env, extraArgs = []) {
  const args = buildArgs(cfg, extraArgs)
  if (entry.kind === 'bundled') {
    // --expose-internals：dsh 的 loader/HMR 需要；在 Electron 的 Node 下必须显式传。
    // stdio 第 4 项 'ipc'：给 dsh 里的 desktop-host 插件一条与壳子通信的 IPC 通道。
    return spawn(process.execPath, ['--expose-internals', entry.entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: buildEnv({ [RUN_AS_NODE]: '1' }, env),
      detached: true,
    })
  }
  return spawn(entry.entry, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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
 * capturing stderr for diagnostics.
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
        if (!sent && !settled) fail(detailFromStderr('dsh exited before serving a URL.'))
      })
    } else if (!settled) {
      fail('dsh exited before serving a URL.')
    }

    readyTimer = setTimeout(async () => {
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
      const fallback = signal
        ? `dsh exited on signal ${signal}.`
        : `dsh exited with code ${code}.`
      fail(detailFromStderr(fallback))
    })
  })
}

module.exports = {
  RUN_AS_NODE,
  DSH_PACKAGE,
  DSH_VERSION,
  unpackedAsarPath,
  resolveSystemDsh,
  commonDshDirs,
  provisionDir,
  provisionBinJs,
  resolvePnpmCli,
  provisionDsh,
  resolveEntry,
  buildPath,
  buildEnv,
  buildArgs,
  spawnDsh,
  resolveFallbackPort,
  probePort,
  waitForReady,
  READY_TIMEOUT_MS,
  FALLBACK_PROBE_MS,
}
