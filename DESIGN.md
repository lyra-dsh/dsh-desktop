# lyra-dsh 架构：多插件桌面生态

本文定义项目的目标架构：把「桌面壳子」做成一层**框架无关的协议**，Electron/Tauri 等只是协议的一个实现，其余桌面功能（通知、终端、更新……）都是建立在协议之上的独立插件。

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 功能插件层   lyra-dsh-notifications / terminal / updates / …    │  ← Cordis 插件，ctx.inject(['desktopRuntime'])
├──────────────────────────────────────────────────────────────┤
│ Bridge 适配层  lyra-dsh-bridge                                    │  ← 依赖 Cordis，把 runtime 以 IPC 代理注册成服务
├──────────────────────────────────────────────────────────────┤
│ 协议层       lyra-dsh-protocol                                  │  ← 纯类型，零依赖（接口 + 事件 + 传输消息）
├──────────────────────────────────────────────────────────────┤
│ 实现层       lyra-dsh-electron / lyra-dsh-tauri / headless       │  ← 各自实现 DesktopCapabilities
└──────────────────────────────────────────────────────────────┘
```

（原「桌面集成层 desktop-shell」已删除——当前用不上；将来若需要「依赖 dsh 服务干桌面活」的插件层再加回来。）

核心原则：

1. **插件和壳子互不直接可见**，都通过 Bridge 通信：`插件 ⇄ Bridge ⇄ 壳子`。
2. **Bridge 只依赖协议**，不知道底下是 Electron 还是 Tauri。
3. **协议只传值、不传回调**（事件 + id），同进程、跨进程都通用。
4. **壳子只做决策上报**（点了关闭、请求了退出），策略由组装根决定。
5. **依赖只能朝下**（指向协议）；dsh/Cordis 的依赖只出现在 lyra-dsh-bridge、功能插件层。

## 目录结构

```
lyra-dsh/
├── package.json                 # workspace 根（workspaces: ["packages/*", "app"]）
├── DESIGN.md
├── packages/
│   ├── lyra-dsh-protocol/        # 协议层（零依赖，纯类型）
│   │   └── src/
│   │       ├── types.ts         #   DesktopCapabilities / DesktopShellLifecycle 相关类型
│   │       ├── events.ts        #   DesktopEvent
│   │       ├── transport.ts     #   DesktopTransport + 消息形状（跨进程 seam）
│   │       └── index.ts
│   ├── lyra-dsh-bridge/            # Bridge 适配层（依赖 cordis；零运行时依赖，仅 ctx/process）
│   │   └── src/index.js         #   createIpcTransport + createTransportRuntime + registerDesktopRuntime + 插件
│   ├── lyra-dsh-electron/        # Electron 实现（依赖 electron + 协议）
│   │   └── src/
│   │       ├── electron-runtime.js  # ElectronDesktopRuntime implements DesktopCapabilities + DesktopShellLifecycle
│   │       └── index.js
│   └── lyra-dsh-notifications/   # 功能插件：会话完成 / 需要审批 → ctx.desktopRuntime.notify
│       └── src/notifications.js
└── app/                         # 组装根 + 打包（composition root）
    ├── package.json             # main + electron-builder + 依赖所有包 + pnpm（运行时兜底安装 dsh，不打包 dsh）
    ├── build/                   # 图标
    └── src/
        ├── main.js              # 组合根：bootstrap → spawn dsh（带 ipc）→ URL → 建 runtime → IPC 分发 + 订阅决策
        ├── config.js            # 配置
        ├── policy.js            # 纯策略：IPC 白名单 + 事件转发过滤
        └── state.js             # dsh 进程组清理 + shutdown 标志
```

（供给层 `dsh.js`/`plugins.js` 已迁到 `packages/lyra-dsh-backend/`。）

## 协议内容（packages/lyra-dsh-protocol）

1. **启动契约**（组装根 → Shell，一次性）：`DesktopShellConfig`。
2. **能力接口**（Bridge → Shell）：`DesktopCapabilities`——主窗口、托盘（增量）、通知、对话框、外部链接、外观、升级、生命周期、`subscribe` 事件。
3. **事件**（Shell → 组装根）：`DesktopEvent`——托盘/窗口/退出/渲染/升级。
4. **传输 seam**（跨进程才实现）：`DesktopTransport` + 消息形状——同进程时退化为直接对象引用。

### 关键决策

- **现状模式**：协议只声明已实现且已验证的能力，按需生长；`openWindow`/`getWindow` 已删（后续按需加回）。
- **事件而非回调**：托盘项用 id，点击回传 `tray/item-activated`。
- **hide vs close 分开**：`hide()` 隐藏保活，`prepareToQuit()` 真退出。
- **决策在组装根**：`window/close-requested`、`quit/requested` 只上报。
- **两个 seam**：`DesktopCapabilities` + `DesktopShellLifecycle`（抽象"能力面 / 生命周期面"）+ `DesktopTransport`（抽象"进程模型"）。
- **传输 = 子进程 IPC**：dsh 是壳子的子进程，用 Node 自带的 `stdio: [..., 'ipc']` + `process.send()` / `child.on('message')` 做双向通道，不另起 server、不另开端口。

### 明确不进协议（属于功能插件）

自动更新、终端、插件市场、设置向导、崩溃恢复、诊断导出、profile 创建窗口、macOS 材质/多 shell 模式。

## 依赖方向（谁依赖谁，只许朝下）

| 包 | 依赖 |
|---|---|
| lyra-dsh-protocol | 无 |
| lyra-dsh-electron | protocol + electron（不依赖 dsh/Cordis） |
| lyra-dsh-bridge | cordis（运行时由 dsh 注入；零运行时 import） |
| lyra-dsh-notifications | cordis + protocol（功能插件，跑在 dsh 里） |
| app | 全部（组装根） |

## 通信通道（lyra-dsh-bridge ↔ lyra-dsh-electron）

dsh 是壳子 `spawn` 出来的子进程，所以直接用 **Node child_process IPC**（零 server、零端口、零发现）：

```
dsh 进程（子进程，spawn 时带 'ipc'）
  lyra-dsh-bridge: createIpcTransport() + createTransportRuntime(transport)
      方法调用 → process.send({ type:'invoke', id, method, args })
                                 │
                                 ▼
壳子进程（Electron 主进程）
  child.on('message', msg => runtime[msg.method](...msg.args))
      结果 → child.send({ type:'result', id, ok, value })
```

- **同进程（B1，暂未用）**：`registerDesktopRuntime(hostCtx, runtime)` 直接传对象引用，无通道、零序列化。
- **跨进程（当前 B2）**：`createIpcTransport()` 走子进程 IPC；`invoke`（Bridge → Shell）与 `onEvent`（Shell → Bridge）双向都在这一条通道上。
- 这是**我们自己的通道**，不借助 dsh/Cordis 的通信（不碰 dsh 的 web server / WebSocket）。

## 落地顺序

1. ✅ 协议（types/events/runtime/transport）。
2. ✅ lyra-dsh-electron（ElectronDesktopRuntime，实现 DesktopCapabilities + 覆盖层）。
3. ✅ app/（组合根 + 打包，迁入 config/state + 图标）。
4. ✅ 零 dsh 依赖：检测系统 dsh → 兜底用 pnpm 装私有 dsh（`lyra-dsh-backend`）。
5. ✅ lyra-dsh-bridge（IPC transport + 代理 + dsh bundle 载体）。
6. ✅ lyra-dsh-notifications / badge / keep-awake（会话事件 → notify / 托盘状态点 / 防休眠）。
7. ✅ 注入（`lyra-dsh-backend.bootstrapProfile`：`dsh plugin add` 一步安装 + 激活 bundle）。
8. ✅ 协议收口：拆 DesktopCapabilities + DesktopShellLifecycle，删 openWindow/getWindow（按需再加回）。
9. ✅ 运行期底线：IPC 白名单、事件转发过滤、请求式生命周期、keep-awake 引用计数、单实例锁。
10. ✅ 覆盖层（WebContentsView 状态面）+ 崩溃监管 + 启动失败进程清理。
11. ✅ 版本闸门（checkCompatibility + DSH_RANGE）+ 发布准备（8 包可发布 + CI + 契约双 job）。
12. ⏳ 端到端真跑一局（需带 API key）看通知弹出。

## 已删除 / 已改名

- **desktop-shell**（桌面集成层）：当前用不上，删。
- **app/src/hooks.js**（Claude Code hooks + osascript 旁路通知）：被 lyra-dsh-notifications + IPC 取代，删。
- **app/src/plugins.js / app/src/dsh.js**：迁入 `lyra-dsh-backend`。
- **desktop-host**：改名 `lyra-dsh-bridge`。
- **desktop-opener**：移除（打开项目插件）。
