# dsh-desktop 架构：多插件桌面生态

本文定义项目的目标架构：把「桌面壳子」做成一层**框架无关的协议**，Electron/Tauri 等只是协议的一个实现，其余桌面功能（通知、终端、更新……）都是建立在协议之上的独立插件。

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 功能插件层   desktop-notifications / terminal / updates / …    │  ← Cordis 插件，ctx.inject(['desktopRuntime'])
├──────────────────────────────────────────────────────────────┤
│ Host 适配层  desktop-host                                      │  ← 依赖 Cordis，把 runtime 以 IPC 代理注册成服务
├──────────────────────────────────────────────────────────────┤
│ 协议层       desktop-protocol                                  │  ← 纯类型，零依赖（接口 + 事件 + 传输消息）
├──────────────────────────────────────────────────────────────┤
│ 实现层       desktop-electron / desktop-tauri / headless       │  ← 各自实现 DesktopRuntime
└──────────────────────────────────────────────────────────────┘
```

（原「桌面集成层 desktop-shell」已删除——当前用不上；将来若需要「依赖 dsh 服务干桌面活」的插件层再加回来。）

核心原则：

1. **插件和壳子互不直接可见**，都通过 Host 通信：`插件 ⇄ Host ⇄ 壳子`。
2. **Host 只依赖协议**，不知道底下是 Electron 还是 Tauri。
3. **协议只传值、不传回调**（事件 + id），同进程、跨进程都通用。
4. **壳子只做决策上报**（点了关闭、请求了退出），策略由 Host 决定。
5. **依赖只能朝下**（指向协议）；dsh/Cordis 的依赖只出现在 desktop-host、功能插件层。

## 目录结构

```
dsh-desktop/
├── package.json                 # workspace 根（workspaces: ["packages/*", "app"]）
├── DESIGN.md
├── packages/
│   ├── desktop-protocol/        # 协议层（零依赖，纯类型）
│   │   └── src/
│   │       ├── types.ts         #   DesktopRuntime 相关接口
│   │       ├── events.ts        #   DesktopEvent
│   │       ├── transport.ts     #   DesktopTransport + 消息形状（跨进程 seam）
│   │       └── index.ts
│   ├── desktop-host/            # Host 适配层（依赖 cordis；零运行时依赖，仅 ctx/process）
│   │   └── src/index.js         #   createIpcTransport + createTransportRuntime + registerDesktopRuntime + 插件
│   ├── desktop-electron/        # Electron 实现（依赖 electron + 协议）
│   │   └── src/
│   │       ├── electron-runtime.js  # ElectronDesktopRuntime implements DesktopRuntime
│   │       └── index.js
│   └── desktop-notifications/   # 功能插件：会话完成 / 需要审批 → ctx.desktopRuntime.notify
│       └── src/notifications.js
└── app/                         # 组装根 + 打包（composition root）
    ├── package.json             # main + electron-builder + 依赖所有包 + pnpm（运行时兜底安装 dsh，不打包 dsh）
    ├── build/                   # 图标
    └── src/
        ├── main.js              # 组合根：spawn dsh（带 ipc）→ URL → 建 runtime → IPC 分发 + 订阅决策
        ├── config.js            # 配置
        ├── dsh.js               # dsh 供给：检测系统 dsh → 兜底安装私有 dsh（userData）→ spawn/URL 捕获
        ├── plugins.js           # 桌面插件注入：复制 @omnilyra/* 到 profile node_modules + 写 --patch
        └── state.js             # dsh 进程组清理
```

## 协议内容（packages/desktop-protocol）

1. **启动契约**（Host → Shell，一次性）：`DesktopShellConfig`。
2. **能力接口**（Host → Shell）：`DesktopRuntime`——窗口（含多窗口 `openWindow`/`getWindow`）、托盘、通知、对话框、外部链接、外观、生命周期、`subscribe` 事件。
3. **事件**（Shell → Host）：`DesktopEvent`——托盘/窗口/退出/渲染/主题。
4. **传输 seam**（跨进程才实现）：`DesktopTransport` + 消息形状——同进程时退化为直接对象引用。

### 关键决策

- **多窗口**：通用 `openWindow(spec) → DesktopWindowHandle` + `getWindow(id)`；窗口操作挂 handle 上；主窗口 `id === 'main'`。
- **事件而非回调**：托盘项用 id，点击回传 `tray/item-activated`。
- **hide vs close 分开**：`hide()` 隐藏保活，`close()` 真销毁。
- **决策在 Host**：`window/close-requested`、`quit/requested` 只上报。
- **两个 seam**：`DesktopRuntime`（抽象"框架"）+ `DesktopTransport`（抽象"进程模型"）。
- **传输 = 子进程 IPC**：dsh 是壳子的子进程，用 Node 自带的 `stdio: [..., 'ipc']` + `process.send()` / `child.on('message')` 做双向通道，不另起 server、不另开端口。

### 明确不进协议（属于功能插件）

自动更新、终端、插件市场、设置向导、崩溃恢复、诊断导出、profile 创建窗口、macOS 材质/多 shell 模式。

## 依赖方向（谁依赖谁，只许朝下）

| 包 | 依赖 |
|---|---|
| desktop-protocol | 无 |
| desktop-electron | protocol + electron（不依赖 dsh/Cordis） |
| desktop-host | cordis（运行时由 dsh 注入；零运行时 import） |
| desktop-notifications | cordis + protocol（功能插件，跑在 dsh 里） |
| app | 全部（组装根） |

## 通信通道（desktop-host ↔ desktop-electron）

dsh 是壳子 `spawn` 出来的子进程，所以直接用 **Node child_process IPC**（零 server、零端口、零发现）：

```
dsh 进程（子进程，spawn 时带 'ipc'）
  desktop-host: createIpcTransport() + createTransportRuntime(transport)
      方法调用 → process.send({ type:'invoke', id, method, args })
                                 │
                                 ▼
壳子进程（Electron 主进程）
  child.on('message', msg => runtime[msg.method](...msg.args))
      结果 → child.send({ type:'result', id, ok, value })
```

- **同进程（B1，暂未用）**：`registerDesktopRuntime(hostCtx, runtime)` 直接传对象引用，无通道、零序列化。
- **跨进程（当前 B2）**：`createIpcTransport()` 走子进程 IPC；`invoke`（Host → Shell）与 `onEvent`（Shell → Host）双向都在这一条通道上。
- 这是**我们自己的通道**，不借助 dsh/Cordis 的通信（不碰 dsh 的 web server / WebSocket）。

## 落地顺序

1. ✅ 协议（types/events/runtime/transport）。
2. ✅ desktop-electron（ElectronDesktopRuntime，迁自旧 wrapper）。
3. ✅ app/（组合根 + 打包，迁入 config/dsh/state + 图标）。
4. ✅ 零 dsh 依赖：检测系统 dsh → 兜底用 pnpm 装私有 dsh（`app/src/dsh.js`）。
5. ✅ desktop-host（IPC transport + runtime 代理 + 插件）。
6. ✅ desktop-notifications（会话完成 `turn/end completed` + 需要审批 `approval/request` → notify）。
7. ✅ 插件注入（`app/src/plugins.js`：复制到 profile node_modules + `--patch`）+ 壳子侧 IPC 分发（`main.js`）。
8. ⏳ 端到端真跑一局（需带 API key）看通知弹出。
9. ⏳ 补全 `DesktopRuntime` 剩余方法的代理（openWindow 的 Promise、getWindow 的 handle、subscribe 反向事件）。

## 已删除

- **desktop-shell**（桌面集成层）：当前用不上，删。
- **app/src/hooks.js**（Claude Code hooks + osascript 旁路通知）：被 desktop-notifications + IPC 取代，删。
