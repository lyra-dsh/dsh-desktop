'use strict'

/**
 * desktop-opener 的 host 半：注册两个 HTTP 路由。
 *   GET  /api/desktop.editors    —— 返回已安装编辑器列表（供客户端渲染菜单）
 *   POST /api/desktop.open-with  —— {editorId, sessionId} → 解析工作区 cwd → open 打开
 *
 * 客户端半见 ./client.js（会话头部按钮），由 dsh-client-modules 经 dsh.client 注入。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')

const name = 'desktop-opener'
const inject = ['connection', 'sessions', 'sessionQuery']

// 编辑器清单：app 是 `open -a` 的 app 名；dir 是用于检测是否安装的 .app 路径。
// finder 特殊处理（open <dir> 直接在 Finder 打开目录）。
const EDITORS = [
  { id: 'vscode', label: 'Visual Studio Code', app: 'Visual Studio Code', dir: '/Applications/Visual Studio Code.app' },
  { id: 'zed', label: 'Zed', app: 'Zed', dir: '/Applications/Zed.app' },
  { id: 'finder', label: 'Finder', app: null, dir: null },
  { id: 'terminal', label: 'Terminal', app: 'Terminal', dir: '/System/Applications/Utilities/Terminal.app' },
  { id: 'iterm2', label: 'iTerm2', app: 'iTerm', dir: '/Applications/iTerm.app' },
  { id: 'ghostty', label: 'Ghostty', app: 'Ghostty', dir: '/Applications/Ghostty.app' },
  { id: 'android-studio', label: 'Android Studio', app: 'Android Studio', dir: '/Applications/Android Studio.app' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA', app: 'IntelliJ IDEA', dir: '/Applications/IntelliJ IDEA.app' },
]

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function installedEditors() {
  return EDITORS
    .filter((e) => e.id === 'finder' || (e.dir && fs.existsSync(e.dir)))
    .map((e) => ({ id: e.id, label: e.label }))
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
