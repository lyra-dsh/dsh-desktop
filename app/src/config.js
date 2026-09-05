'use strict'

// Configuration for the dsh desktop wrapper (Electron port of config.rs).
//
// The file is a small JSON document read once at startup, at
// `$XDG_CONFIG_HOME/lyra-dsh/config.json` (default `~/.config/lyra-dsh/config.json`),
// created with sane defaults on first run. `DSH_DESKTOP_CONFIG` overrides the
// path entirely. Missing keys fall back to the same defaults.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Default config object; mirrors Config::default() in config.rs. */
const DEFAULT_CONFIG = Object.freeze({
  profile: 'web',
  dshBin: null,
  host: '127.0.0.1',
  port: 0, // 0 = OS 自动分配空闲端口，避免与残留 dsh 撞端口（EADDRINUSE）
  openBrowser: false,
  notify: true,
  extraArgs: [],
  editor: null,
  updater: Object.freeze({
    enabled: true,
    autoCheck: true,
    autoDownload: true,
    // 版本清单 URL（manual 模式）：JSON { version, url }。空则禁用自动升级。
    feedUrl: null,
  }),
})

/** The argv passed to dsh, mirroring Config::cli_args(). */
function toCliArgs(cfg) {
  const args = ['--profile', cfg.profile]
  if (cfg.host !== null && cfg.host !== undefined && cfg.host !== '') {
    args.push('--host', cfg.host)
  }
  // null 才省略 --port（用 dsh 默认端口）；0 必须显式传，让 dsh 自己分配。
  if (cfg.port !== null && cfg.port !== undefined) {
    args.push('--port', String(cfg.port))
  }
  if (!cfg.openBrowser) {
    args.push('--no-open')
  }
  args.push(...cfg.extraArgs)
  return args
}

/** The directory holding this app's config: `$XDG_CONFIG_HOME/lyra-dsh` or `~/.config/lyra-dsh`. */
function configDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, 'lyra-dsh')
  const home = env.HOME || os.homedir()
  return path.join(home, '.config', 'lyra-dsh')
}

/** Resolve the config file path. `DSH_DESKTOP_CONFIG` overrides everything. */
function configPath(env = process.env) {
  if (env.DSH_DESKTOP_CONFIG) return env.DSH_DESKTOP_CONFIG
  return path.join(configDir(env), 'config.json')
}

/** Pretty-printed default config JSON, matching serde_json::to_string_pretty. */
function defaultConfigJson() {
  return JSON.stringify({ ...DEFAULT_CONFIG }, null, 2) + '\n'
}

/** Create the config directory + default file if missing. Idempotent. */
function ensureDefault(filePath) {
  if (fs.existsSync(filePath)) return
  const parent = path.dirname(filePath)
  if (parent) fs.mkdirSync(parent, { recursive: true })
  fs.writeFileSync(filePath, defaultConfigJson())
}

/** Parse a config file, falling back per-key to defaults (does NOT create the file). */
function loadFrom(filePath) {
  const cfg = { ...DEFAULT_CONFIG }
  if (!fs.existsSync(filePath)) return cfg
  const text = fs.readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') return cfg
  // camelCase keys (serde rename_all = "camelCase"); missing keys keep defaults.
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      cfg[key] = parsed[key]
    }
  }
  // Normalize: extraArgs must be an array of strings; dshBin/host/editor null or string.
  if (!Array.isArray(cfg.extraArgs)) cfg.extraArgs = []
  cfg.extraArgs = cfg.extraArgs.map(String)
  // updater 是嵌套对象：按子键合并，缺失子键回退默认。
  if (parsed.updater && typeof parsed.updater === 'object') {
    cfg.updater = { ...DEFAULT_CONFIG.updater, ...parsed.updater }
  }
  return cfg
}

/** Resolve path, ensure a default file exists, then load it. */
function loadForApp(env = process.env) {
  const filePath = configPath(env)
  ensureDefault(filePath)
  return loadFrom(filePath)
}

module.exports = {
  DEFAULT_CONFIG,
  toCliArgs,
  configDir,
  configPath,
  defaultConfigJson,
  ensureDefault,
  loadFrom,
  loadForApp,
}
