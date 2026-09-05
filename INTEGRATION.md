# 集成指南：其他项目如何复用壳子、通知与更新组件

本文面向「想拿这套东西做自己的 dsh 壳子」的项目。dsh-desktop 不是单一应用，而是一层
**框架无关的桌面壳子 SDK** + 一个 **Electron 参考实现**。你既可以整壳 fork（改配置/图标/名字
就是一个新产品），也可以只挑几个 SDK 包复用到自己的壳子里。

阅读前建议先看两篇背景：[README.md](README.md)（这个壳子本身怎么跑）、
[DESIGN.md](DESIGN.md)（分层与协议设计）。本文只讲「怎么用」，不讲内部实现。

---

## 1. 分层与「谁在哪运行」

理解下面这张图，就理解了「怎么用」：

```
┌────────────────────────────────────────────────────────────────┐
│ 功能插件层（跑在 dsh 进程内，Cordis 插件）                        │
│   desktop-notifications / desktop-badge / desktop-keep-awake     │
│   desktop-opener(host 半 + client 半)                            │
│   统一通过 ctx.desktopRuntime 调壳子能力                          │
├────────────────────────────────────────────────────────────────┤
│ Host 适配层 desktop-host（跑在 dsh 进程内）                       │
│   把「壳子能力」以 IPC 代理注册成 ctx.desktopRuntime              │
├────────────────────────────────────────────────────────────────┤
│ 协议层 desktop-protocol（纯类型，零依赖，两边共享）                │
│   DesktopRuntime（能力接口）/ DesktopEvent（事件）/ DesktopTransport │
├────────────────────────────────────────────────────────────────┤
│ 实现层 + 主进程模块（跑在壳子进程内，Electron）                   │
│   desktop-electron（ElectronDesktopRuntime）                     │
│   desktop-updater（升级状态机 + 目标，主进程模块）                 │
└────────────────────────────────────────────────────────────────┘
        组装根 app/（跑在壳子进程内）：spawn dsh → IPC 分发 → 决策
```

两个关键点：

1. **`desktop-notifications` 等是 dsh 内的 Cordis 插件**，不是壳子代码。它们被 `--patch`
   注入进 dsh，只依赖一个服务：`ctx.desktopRuntime`（由 `desktop-host` 提供）。
2. **`desktop-electron`、`desktop-updater` 是壳子主进程模块**，在你的组装根里
   `require` 后接线，不进入 dsh。

依赖只朝下（指向协议），所以换掉 Electron（用 Tauri 等）只需重写「实现层」，插件和协议
一行不动。

---

## 2. 壳子（Shell）怎么用

### 2.1 两条路

- **A. 整壳 fork（推荐起步）**：把 `app/` 当模板，改三处——`app/package.json` 里的
  `name`/`appId`/`productName`/`build.publish`、`app/build/` 的图标、`app/src/main.js`
  里的产品名/窗口尺寸/托盘文案。dsh 供给、窗口、托盘、IPC、升级这些通用逻辑都是现成的。
- **B. 只复用 SDK 包**：自己写组装根，只 `require` 你需要的包（`desktop-electron`、
  `desktop-host`、`desktop-updater`、若干功能插件），自己 spawn dsh、自己接线。

### 2.2 协议核心：`DesktopRuntime`

所有壳子能力都在 `packages/desktop-protocol/src/runtime.ts` 的一个接口里。功能插件
（dsh 内）看到的 `ctx.desktopRuntime` 就是它；Electron 侧 `ElectronDesktopRuntime`
实现了它。方法一览：

| 分组 | 方法 |
|---|---|
| 主窗口 | `show()` `hide()` `reload()` `setTitle(title)` |
| 多窗口 | `openWindow(spec) → handle` `getWindow(id)` |
| 托盘 | `setTray(items)` |
| 通知 | `notify({title, body, sound?})` |
| 状态点 | `setBadge('error'\|'approval'\|'unread')` |
| 电源 | `setKeepAwake(enabled)` |
| 对话框 | `pickDirectory(opts)` `showMessageBox(opts)` |
| 外部 | `openExternal(url)` |
| 外观 | `setTheme(source)` `setLocale(locale)` |
| 升级 | `checkForUpdates()` `downloadUpdate()` `quitAndInstall()` `getUpdateStatus()` |
| 生命周期 | `quit()` `restart()` `prepareToQuit()` |
| 事件 | `subscribe(listener)` —— 壳子 → Host 的事件流 |

事件（`DesktopEvent`）：`tray/activated`、`tray/item-activated`、`window/visibility`、
`window/close-requested`、`quit/requested`、`renderer/boot`、`theme/changed`、`update/state`。

### 2.3 组装根要做的四件事（参考 `app/src/main.js`）

```js
// 1) 供给 dsh：显式 dshBin > 系统 dsh > 兜底安装私有 dsh
const entry = await dsh.resolveEntry(cfg)          // app/src/dsh.js

// 2) spawn dsh，多带一个 'ipc' stdio 通道
const child = dsh.spawnDsh(cfg, entry, process.env, notifyArgs)

// 3) 等 dsh 的 web URL（stdout 捕获 + 端口探测兜底）
const url = await dsh.waitForReady(child, cfg)

// 4) 建 runtime、开窗口、IPC 分发、订阅事件做决策
const runtime = new ElectronDesktopRuntime({ url, trayIconPath, ... })
runtime.createMainWindow()
child.on('message', (msg) => { /* invoke → runtime[msg.method](...) */ })
runtime.subscribe((event) => { /* 决策：关闭→隐藏、退出→杀 dsh…… */ })
```

dsh 供给顺序与兜底安装逻辑在 `app/src/dsh.js`；插件注入（复制 `@omnilyra/*` 进 profile
`node_modules` + 写 `--patch`）在 `app/src/plugins.js`。这两块都是「通用壳子」的公共部分，
fork 时通常原样保留。

### 2.4 IPC 通道（我们自己的通道，不碰 dsh 的 web server）

dsh 是壳子的子进程，用 Node 自带的 `child_process` IPC 通信：

```
dsh 进程      desktop-host：process.send({type:'invoke', id, method, args})
壳子主进程    child.on('message') → runtime[method](...args) → child.send({type:'result', ...})
壳子→dsh 事件 child.send({type:'event', event}) → desktop-host onEvent → ctx.desktopRuntime.subscribe
```

---

## 3. 通知组件（desktop-notifications）怎么用

### 3.1 它做什么

在 dsh 内订阅三类事件，弹**系统原生通知**（不负责托盘点、不负责防休眠）：

| dsh 事件 | 触发 | 通知 |
|---|---|---|
| `session/event` → `turn/end`（`completed`） | 一轮跑完 | 「dsh 已完成」+ 会话标题 |
| `session/event` → `turn/end`（`error`） | 一轮出错 | 「dsh 出错」+ 错误信息（提示音 Basso） |
| `approval/request` | 需要审批 | 「需要审批」（提示音 Ping） |
| `user-questions/request` | agent 用 ask_user 提问 | 「需要回答」（提示音 Ping） |

### 3.2 依赖注入

它是标准 Cordis 插件，只注入一个服务：

```js
module.exports = {
  name: 'desktop-notifications',
  inject: ['desktopRuntime'],   // 由 desktop-host 提供
  apply(ctx) { /* ctx.on(...) → ctx.desktopRuntime.notify({title, body, sound}) */ },
}
```

`desktopRuntime.notify(notification)` 的入参就是协议里的 `DesktopNotification`：
`{ title, body, sound? }`（`sound` 是 macOS 系统提示音名，如 `"Ping"`/`"Basso"`）。

### 3.3 接入到你自己的项目

1. 把 `@omnilyra/desktop-host`、`@omnilyra/desktop-notifications` 复制进你 dsh profile 的
   `node_modules`，并写进 `--patch`（参考 `app/src/plugins.js` 的 `PLUGINS` 数组和
   `patchContent()`，把两个名字加进去即可）。
2. 壳子侧 spawn dsh 时带 `ipc` stdio 通道，并在 `child.on('message')` 里把 `invoke`
   分发到 `runtime[method]`（参考 `app/src/main.js`）。
3. 壳子侧 `ElectronDesktopRuntime.notify()` 已经实现好了，无需再写。

### 3.4 自定义你自己的通知（或别的桌面能力）

不想用现成插件？照葫芦画瓢写一个 Cordis 插件即可，关键是拿到 `desktopRuntime`：

```js
module.exports = {
  name: 'my-desktop-feature',
  inject: ['desktopRuntime'],
  apply(ctx) {
    // 订阅任何 dsh 事件，然后调壳子能力
    ctx.on('session/event', (session, event) => {
      if (event?.type === 'turn/end') ctx.desktopRuntime.notify({ title: '……', body: '……' })
    })
    // 或直接：ctx.desktopRuntime.setBadge('approval')
  },
}
```

壳子侧对应的能力（notify / setBadge / setKeepAwake…）都已在 `ElectronDesktopRuntime`
里实现，插件只管调用。

---

## 4. 更新组件（desktop-updater）怎么用

`@omnilyra/desktop-updater` 是**壳子主进程模块**（不在 dsh 内），它把「升级」拆成
**一个状态机 + 若干可插拔目标（target）**。这是通用性的关键：**升级什么、从哪升级、
怎么装，全部由你（产品）配置，SDK 不写死**。

### 4.1 状态机

```js
const { createUpdater } = require('@omnilyra/desktop-updater')

const updater = createUpdater({ targets: [...], autoDownload: true })
updater.subscribe((status) => console.log(status))
await updater.check()   // checking → available → (auto) downloading → downloaded | not-available
updater.install()       // 用户确认后调用
updater.getStatus()     // 当前状态快照
```

状态：`idle / checking / available / not-available / downloading / downloaded / error`。
`status` 里带 `target`（哪个目标）、`version`、`currentVersion`、`percent`、`error`、
`releaseUrl`。

### 4.2 目标（target）接口 + 内置三个实现

每个目标实现同一接口：`{ id, label, currentVersion(), check(), download(onProgress), install() }`。

| 目标工厂 | 用途 | 适用平台 |
|---|---|---|
| `createFeedTarget({feedUrl, currentVersion, downloadsDir, openFile})` | manual：查 JSON 清单 `{version,url}` → 下载安装包 → 打开 | macOS（无签名） |
| `createElectronUpdaterTarget({currentVersion, isPackaged})` | auto：electron-updater 的 `quitAndInstall`（NSIS/AppImage 无签名也能装） | Windows / Linux |
| `createNpmPackageTarget({packageName, currentVersion, apply})` | 运行时升级：查 npm registry latest，`apply` 由产品注入 | 兜底安装的 dsh |

### 4.3 一个完整的组装例子（就是 `app/src/main.js` 里的 `buildUpdater`）

```js
const { createUpdater, createFeedTarget, createElectronUpdaterTarget, createNpmPackageTarget } =
  require('@omnilyra/desktop-updater')

function buildUpdater(cfg, entry, dshVer, dshMode, state, runtime) {
  const targets = []

  // 目标 1：壳子自身
  if (process.platform === 'darwin') {
    targets.push(createFeedTarget({
      id: 'shell', feedUrl: cfg.updater.feedUrl,
      currentVersion: () => app.getVersion(),
      downloadsDir: () => app.getPath('downloads'),
      openFile: (p) => shell.openPath(p),
    }))
  } else {
    targets.push(createElectronUpdaterTarget({
      id: 'shell', currentVersion: () => app.getVersion(), isPackaged: () => app.isPackaged,
    }))
  }

  // 目标 2：dsh 运行时（可选，按供给方式）
  if (dshMode !== 'none') {
    targets.push(createNpmPackageTarget({
      id: 'dsh', packageName: cfg.updater.runtime.package || '@deepseek-ai/dsh',
      currentVersion: () => dshVer,
      apply: dshMode === 'auto'
        ? async (version) => { await dsh.upgradeProvisionedDsh(version); state.killGracefully(1500, () => runtime.restart()) }
        : null, // notify：只提示，不动作
    }))
  }

  return createUpdater({ targets, autoDownload: cfg.updater.autoDownload !== false })
}
```

然后把状态接到你的 UX（弹窗 / 通知）：

```js
updater.subscribe(async (status) => {
  if (status.state === 'downloaded') {
    const res = await dialog.showMessageBox({ message: `新版本 ${status.version} 已下载，是否安装？`, buttons: ['安装', '稍后'] })
    if (res.response === 0) updater.install()
  }
})
```

### 4.4 产品自定义：这才是重点

换一个项目，改的不是 SDK，而是「**选哪个目标 + 传什么渠道**」：

- **深度自定义的 dsh**：不走 npm，改走自己的清单 → 用 `createFeedTarget({ feedUrl: 你的dsh清单URL })`，
  或干脆 `runtime.mode = 'none'`（不自动升级，dsh 跟着壳子一起发版）。
- **自己的升级服务器 / GitHub Releases**：壳子目标换 `feedUrl` 或改 `build.publish`（auto 模式），
  SDK 不动。
- **再加一个升级对象**（比如你额外带了个模型运行时）：再塞一个 target 即可，状态机/UX 自动覆盖。

### 4.5 配置（`config.json` 的 `updater` 段）

```jsonc
"updater": {
  "enabled": true,          // 总开关
  "autoCheck": true,        // 启动自动检查
  "autoDownload": true,     // 检查到新版自动下载
  "feedUrl": null,          // manual 模式的版本清单 URL（JSON {version,url}）
  "runtime": {              // dsh 运行时升级
    "mode": null,           // 'auto' | 'notify' | 'none' | null（null=按供给方式推断）
    "package": "@deepseek-ai/dsh"
  }
}
```

`runtime.mode` 默认按「dsh 是怎么来的」推断：**兜底安装 → auto（npm 查新+重装+重启）**；
**系统 dsh → notify（只提示）**；**显式 dshBin → none（产品自管）**。

> 签名提醒：macOS 的 `quitAndInstall`（auto 模式）需要 Developer ID 签名 + 公证，无签名走
> `createFeedTarget`（manual）。Windows（NSIS）/ Linux（AppImage）的 auto 无需签名。

---

## 5. 功能插件速查

| 包 | 跑在哪 | 注入 | 做什么 | 调用的 runtime 方法 |
|---|---|---|---|---|
| `desktop-notifications` | dsh 内 | `['desktopRuntime']` | 会话完成/出错/审批/提问 → 系统通知 | `notify` |
| `desktop-badge` | dsh 内 | `['desktopRuntime']` | 会话状态 → 托盘红/黄/绿点 | `setBadge` |
| `desktop-keep-awake` | dsh 内 | `['desktopRuntime']` | 运行时防休眠（允许息屏） | `setKeepAwake` |
| `desktop-opener` | dsh 内（双面包） | host: `['connection','sessions','sessionQuery']`；client: `['slots']` | 会话头部「打开项目」：用外部编辑器打开工作区 | 自己的 HTTP 路由 + `spawn('open')` |
| `desktop-host` | dsh 内 | 无（提供服务） | 把壳子能力以 IPC 代理注册成 `ctx.desktopRuntime` | （提供者） |
| `desktop-electron` | 壳子主进程 | 无 | `ElectronDesktopRuntime` 实现协议 | （实现者） |
| `desktop-updater` | 壳子主进程 | 无 | 升级状态机 + 目标 | 协议升级方法 |

---

## 6. 常见问题

- **Q：我的壳子不是 Electron，能用吗？** 能。协议层（`desktop-protocol`）是纯类型零依赖，
  你按 `DesktopRuntime` 写一个自己的实现（比如 Tauri），插件和 Host 层都不用改。
- **Q：我不想用 `--patch` 注入，能直接在 dsh 里装吗？** 能，`--patch` 只是这个壳子选用的
  注入方式；任何能把 `@omnilyra/desktop-host` 挂进 dsh 的机制（`dsh.client`/profile 依赖）都行。
- **Q：通知没弹？** 依次检查：壳子 spawn dsh 时带了 `ipc` stdio；`desktop-host` 和
  `desktop-notifications` 都进了 `--patch`；壳子侧 `child.on('message')` 把 `invoke` 分发到
  `runtime[method]`；macOS 上通知需要系统授权（首次会问）。
- **Q：升级想完全关掉？** 配 `"updater": { "enabled": false }` 即可（`buildUpdater` 返回 null）。
- **Q：升级目标怎么加一个？** 实现一个 `{id,label,currentVersion,check,download,install}`
  对象塞进 `createUpdater({ targets })`，状态机和弹窗自动覆盖。
