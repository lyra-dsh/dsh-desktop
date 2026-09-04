# @omnilyra/desktop-protocol

框架无关的桌面壳子协议：`DesktopRuntime` 接口 + `DesktopEvent` 事件 + 基础类型。

- **零运行时依赖**，纯 TypeScript 类型。
- Host 和插件只依赖本协议；Electron / Tauri 各自实现它。
- 通信方向：方法 = Host → Shell；`subscribe` 事件 = Shell → Host。

## 内容

- `types.ts` — `DesktopPlatform`、`DesktopNotification`、`DesktopTrayItem`、`DesktopWindowSpec`、`DesktopWindowHandle`、`DesktopShellConfig` 等。
- `events.ts` — `DesktopEvent`（托盘/窗口/退出/渲染/主题事件）。
- `runtime.ts` — `DesktopRuntime` 接口。

## 目录

见仓库根 `DESIGN.md`。
