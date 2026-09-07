'use strict'

/**
 * 打包后的 Unix 桌面端：source 一次交互式登录 shell，抓出它的完整环境
 * （PATH + 所有 export 的变量）。
 *
 * GUI 从 Finder/Dock 启动时 `process.env` 只有最小集（PATH 精简、缺 SSH_AUTH_SOCK
 * 等 shell 配置里的变量）。这里在 spawn dsh 之前抓一次登录 shell 的真实环境，
 * 合并进 `process.env`，让 dsh 及其子进程（终端/沙箱）继承到「终端里看到的样子」。
 * 失败时回退到继承 env（`dsh.buildPath` 继续兜底 PATH）。
 */

const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const os = require('node:os')
const { basename } = require('node:path')

const CAPTURE_TIMEOUT_MS = 2000

/** 支持的登录 shell → 交互式登录参数。 */
const SUPPORTED_SHELLS = new Map([
  ['bash', ['-ilc']],
  ['zsh', ['-ilc']],
  ['fish', ['--login', '--interactive', '--command']],
])

/** 解析用户账号的登录 shell：`userInfo().shell` 优先，其次 `$SHELL`。 */
function resolveShell(env = process.env) {
  try {
    const account = os.userInfo().shell
    if (account) return account
  } catch { /* 读账号 shell 失败则回退 $SHELL */ }
  return env.SHELL || null
}

/**
 * 解析捕获 payload（`start\0 … env -0 … \0end`）为 env 对象；失败返回 null。
 * 纯函数，可单测。
 */
function parseShellEnvPayload(payload, startMarker, endMarker) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
  const start = text.indexOf(`${startMarker}\0`)
  if (start < 0) return null
  const bodyStart = start + startMarker.length + 1
  const end = text.indexOf(`${endMarker}\0`, bodyStart)
  if (end < 0) return null
  const env = {}
  for (const record of text.slice(bodyStart, end).split('\0')) {
    if (record === '') continue
    const eq = record.indexOf('=')
    if (eq <= 0) continue
    env[record.slice(0, eq)] = record.slice(eq + 1)
  }
  return Object.keys(env).length > 0 ? env : null
}

/**
 * 抓取一次交互式登录 shell 的完整环境。用随机 marker 包裹 `env -0` 的输出，
 * 避免 shell 启动文件的 stdout 噪声污染解析。超时/失败返回 null。
 */
function captureLoginShellEnv({ shell, timeoutMs = CAPTURE_TIMEOUT_MS, cwd } = {}) {
  const resolved = shell || resolveShell()
  if (!resolved) return Promise.resolve(null)
  const shellArgs = SUPPORTED_SHELLS.get(basename(resolved).toLowerCase())
  if (!shellArgs) return Promise.resolve(null)

  const nonce = randomBytes(8).toString('hex')
  const start = `DSH_DESKTOP_SHELL_ENV_START_${nonce}`
  const end = `DSH_DESKTOP_SHELL_ENV_END_${nonce}`
  const command = `/usr/bin/printf '%s\\0' '${start}'; /usr/bin/env -0; /usr/bin/printf '%s\\0' '${end}'`

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(resolved, [...shellArgs, command], {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: cwd || os.homedir(),
      })
    } catch { resolve(null); return }
    const chunks = []
    let settled = false
    const finish = (env) => { if (settled) return; settled = true; clearTimeout(timer); resolve(env) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } finish(null) }, timeoutMs)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => finish(null))
    child.on('close', () => finish(parseShellEnvPayload(Buffer.concat(chunks), start, end)))
  })
}

/**
 * 决定是否/如何抓取登录 shell 环境，返回要合并进 `process.env` 的 updates。
 * 只在打包后的 darwin/linux 上抓；其余场景回退（空 updates）。
 */
async function resolveDesktopShellEnv({
  environment = process.env,
  isPackaged,
  platform = process.platform,
  shell,
  timeoutMs,
  capture = captureLoginShellEnv,
} = {}) {
  if (!isPackaged) return { updates: {}, source: 'process', fallbackReason: 'not-packaged' }
  if (platform !== 'darwin' && platform !== 'linux') {
    return { updates: {}, source: 'process', fallbackReason: 'unsupported-platform' }
  }
  const captured = await capture({ shell, timeoutMs })
  if (!captured) return { updates: {}, source: 'process', fallbackReason: 'capture-failed' }
  if (!captured.PATH) return { updates: {}, source: 'process', fallbackReason: 'missing-path' }
  // 全量：登录 shell 的值覆盖继承值（与「全量透传」一致）。
  const updates = {}
  for (const [name, value] of Object.entries(captured)) {
    if (value !== undefined && environment[name] !== value) updates[name] = value
  }
  return { updates, source: 'login-shell' }
}

module.exports = {
  CAPTURE_TIMEOUT_MS,
  SUPPORTED_SHELLS,
  resolveShell,
  parseShellEnvPayload,
  captureLoginShellEnv,
  resolveDesktopShellEnv,
}
