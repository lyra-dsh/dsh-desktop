'use strict'

/**
 * desktop-opener 的 host 半：注册 HTTP 路由。
 *   GET  /api/desktop.editors            —— 已安装编辑器列表（{id,label}）
 *   POST /api/desktop.open-with          —— {editorId, sessionId} → 解析 cwd → open 打开
 *   GET  /api/desktop.editor-icon        —— ?editorId=… → 该系统应用的图标（image/png）
 *   GET  /api/desktop.editor-preference  —— 记住的用户默认编辑器
 *   PUT  /api/desktop.editor-preference  —— 写入 {editorId}
 *
 * 客户端半见 ./client.js（会话头部 split-button），由 dsh-client-modules 经 dsh.client 注入。
 */

const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const name = 'desktop-opener'
const inject = ['connection', 'sessions', 'sessionQuery']

// 编辑器清单：app 是 `open -a` 的 app 名；dir 是用于检测是否安装 / 取图标的 .app 路径。
// finder 特殊处理（open <dir> 直接在 Finder 打开目录）；它的图标从系统 Finder.app 取。
const EDITORS = [
  { id: 'vscode', label: 'Visual Studio Code', app: 'Visual Studio Code', dir: '/Applications/Visual Studio Code.app' },
  { id: 'zed', label: 'Zed', app: 'Zed', dir: '/Applications/Zed.app' },
  { id: 'finder', label: 'Finder', app: null, dir: '/System/Library/CoreServices/Finder.app' },
  { id: 'terminal', label: 'Terminal', app: 'Terminal', dir: '/System/Applications/Utilities/Terminal.app' },
  { id: 'iterm2', label: 'iTerm2', app: 'iTerm', dir: '/Applications/iTerm.app' },
  { id: 'ghostty', label: 'Ghostty', app: 'Ghostty', dir: '/Applications/Ghostty.app' },
  { id: 'android-studio', label: 'Android Studio', app: 'Android Studio', dir: '/Applications/Android Studio.app' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA', app: 'IntelliJ IDEA', dir: '/Applications/IntelliJ IDEA.app' },
]

// .icns 中「PNG 块」OSType → 像素尺寸（现代 icns 用 ic07+ 存原始 PNG）。
const ICNS_PNG_SIZES = {
  ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
  ic11: 32, ic12: 64, ic13: 256, ic14: 512,
}

const ICON_CACHE = new Map()

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function isInstalled(e) {
  return e.id === 'finder' || fs.existsSync(e.dir)
}

function installedEditors() {
  return EDITORS.filter(isInstalled).map((e) => ({ id: e.id, label: e.label }))
}

/** dsh 数据根（与 @deepseek-ai/dsh-home-paths 一致），用于偏好持久化。 */
function dshHome(env = process.env) {
  const h = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : path.join(env.HOME || os.homedir(), '.dsh')
  return h
}

function preferenceFile() {
  return path.join(dshHome(), 'desktop-opener-preference.json')
}

function readPreference() {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferenceFile(), 'utf8'))
    if (parsed && typeof parsed.editorId === 'string') return parsed.editorId
  } catch { /* 无偏好文件或损坏 → 返回 null */ }
  return null
}

function writePreference(editorId) {
  const file = preferenceFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ editorId }, null, 2))
}

/** 读取 Info.plist 的 CFBundleIconFile（plutil 可同时解析 binary / XML plist）。 */
function plistIconName(appDir) {
  try {
    const out = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', path.join(appDir, 'Contents', 'Info.plist')], { encoding: 'utf8' })
    const v = out.trim()
    return v || null
  } catch { return null }
}

/** 定位 app 图标 .icns：优先 CFBundleIconFile，其次按文件名 / 大小兜底。 */
function resolveIconFile(appDir) {
  if (!fs.existsSync(appDir)) return null
  const res = path.join(appDir, 'Contents', 'Resources')
  const cf = plistIconName(appDir)
  if (cf) {
    const base = cf.toLowerCase().endsWith('.icns') ? cf : `${cf}.icns`
    const p = path.join(res, base)
    if (fs.existsSync(p)) return p
  }
  let entries = []
  try { entries = fs.readdirSync(res).filter((f) => f.toLowerCase().endsWith('.icns')) } catch { entries = [] }
  if (entries.length === 0) return null
  const appName = path.basename(appDir, '.app').toLowerCase()
  const match = entries.find((f) => f.toLowerCase().startsWith(appName)) || entries[0]
  return path.join(res, match)
}

/** 从 .icns 提取内嵌 PNG：优先 >= 64px 的最小块，否则取最大块。 */
function extractIconPng(icnsPath) {
  let buf
  try { buf = fs.readFileSync(icnsPath) } catch { return null }
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') return null
  const candidates = []
  let off = 8
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32BE(off + 4)
    if (len < 8 || off + len > buf.length) break
    if (ICNS_PNG_SIZES[type] !== undefined) {
      const data = buf.subarray(off + 8, off + len)
      if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
        candidates.push({ size: ICNS_PNG_SIZES[type], data })
      }
    }
    off += len
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.size - b.size)
  // 优先取 >= 128px 的最小块（16px 图标 8x 超采样，视网膜屏更清晰），否则取最大可用块。
  const pick = candidates.find((c) => c.size >= 128) || candidates[candidates.length - 1]
  return Uint8Array.from(pick.data)
}

function iconFor(editor) {
  if (ICON_CACHE.has(editor.id)) return ICON_CACHE.get(editor.id)
  const icns = resolveIconFile(editor.dir)
  const png = icns ? extractIconPng(icns) : null
  ICON_CACHE.set(editor.id, png) // 缓存成功与失败（null）结果，避免反复读盘
  return png
}

/** 解析会话工作区 cwd：优先活会话，其次从 sessionQuery 读冷会话 header。 */
async function cwdOf(ctx, sessionId) {
  const live = ctx.sessions && ctx.sessions.get(sessionId)
  if (live && live.header && live.header.cwd) return live.header.cwd
  const q = ctx.sessionQuery
  if (q && typeof q.readSession === 'function') {
    try {
      const snap = await q.readSession(sessionId)
      if (snap && snap.header && snap.header.cwd) return snap.header.cwd
    } catch { /* 冷会话读取失败则返回 null */ }
  }
  return null
}

function openEditor(editor, cwd) {
  const args = editor.id === 'finder' ? [cwd] : ['-a', editor.app, cwd]
  return new Promise((resolve) => {
    const child = spawn('open', args, { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function apply(ctx) {
  const conn = connectionOf(ctx)

  conn.fetch.register({
    path: '/api/desktop.editors',
    methods: ['GET'],
    fetch: async () => json({ editors: installedEditors() }),
  })

  conn.fetch.register({
    path: '/api/desktop.editor-icon',
    methods: ['GET'],
    fetch: async (request) => {
      const url = new URL(request.url)
      const editorId = url.searchParams.get('editorId')
      const editor = EDITORS.find((e) => e.id === editorId)
      if (!editor) return json({ error: 'unknown editor' }, 400)
      const png = iconFor(editor)
      if (!png) return json({ error: 'no icon' }, 404)
      return new Response(png, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
      })
    },
  })

  conn.fetch.register({
    path: '/api/desktop.editor-preference',
    methods: ['GET', 'PUT'],
    fetch: async (request) => {
      if (request.method === 'GET') {
        const pref = readPreference()
        const editorId = pref && EDITORS.some((e) => e.id === pref && isInstalled(e)) ? pref : installedEditors()[0]?.id ?? null
        return json({ editorId })
      }
      let body
      try { body = await request.json() } catch { return json({ ok: false, error: 'invalid body' }, 400) }
      const editorId = body && body.editorId
      if (typeof editorId !== 'string' || !EDITORS.some((e) => e.id === editorId && isInstalled(e))) {
        return json({ ok: false, error: 'unknown editor' }, 400)
      }
      writePreference(editorId)
      return json({ ok: true, editorId })
    },
  })

  conn.fetch.register({
    path: '/api/desktop.open-with',
    methods: ['POST'],
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { return json({ ok: false, error: 'invalid body' }, 400) }
      const { editorId, sessionId } = body || {}
      const editor = EDITORS.find((e) => e.id === editorId)
      if (!editor) return json({ ok: false, error: 'unknown editor' }, 400)
      const cwd = await cwdOf(ctx, sessionId)
      if (!cwd) return json({ ok: false, error: 'session not found' }, 404)
      const ok = await openEditor(editor, cwd)
      return json({ ok })
    },
  })
}

module.exports = { name, inject, apply }
