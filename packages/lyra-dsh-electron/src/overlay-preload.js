'use strict'

// 覆盖层的 preload:通过 contextBridge 暴露 overlayBridge。
// 只在覆盖层 view 上使用;dsh 主窗口保持零 preload。

const { contextBridge, ipcRenderer } = require('electron')

function render(title, detail, showRestart) {
  const t = document.getElementById('title')
  const d = document.getElementById('detail')
  const r = document.getElementById('restart')
  if (t) t.textContent = title || ''
  if (d) d.textContent = detail || ''
  if (r) {
    r.style.display = (showRestart === true || showRestart === 'true') ? 'block' : 'none'
    r.onclick = () => ipcRenderer.send('lyra-dsh:overlay-restart')
  }
}

contextBridge.exposeInMainWorld('overlayBridge', {
  restart: () => ipcRenderer.send('lyra-dsh:overlay-restart'),
  render,
})
