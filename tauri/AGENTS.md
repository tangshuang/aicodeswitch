# Tauri Desktop Application Conventions

**Generated:** 2026-02-11

## Overview

Tauri 2.0 桌面应用，使用 Rust 主进程管理 Node.js 后端和 WebView UI。

## Structure

```
tauri/
├── src/
│   ├── main.rs           # Rust 主进程入口
│   └── main.rs           # 主进程: 窗口管理、Node 进程生命周期
├── build.rs             # 构建脚本
├── Cargo.toml           # Rust 依赖配置
├── tauri.conf.json      # Tauri 应用配置
├── capabilities/         # 权限配置
├── gen/
│   └── schemas/          # 自动生成的 schema
├── icons/               # 应用图标
│   ├── ios/             # iOS 图标
│   ├── android/         # Android 图标
│   └── *.png, *.ico     # 多平台图标
└── resources/
    ├── dist/            # 嵌入的 UI/Server 构建产物
    ├── node_modules/    # 嵌入的 Node 依赖
    └── screens/         # 屏幕截图等资源
```

## Key Patterns

### Process Management
- Rust 主进程管理 Node.js 子进程
- 启动时检查 Node.js 安装
- 退出时自动禁用所有激活的路由
- 窗口管理与 WebView 集成

### Resource Embedding
- 构建时嵌入 `dist/server` 和 `dist/ui`
- 资源路径在 `tauri.conf.json` 中配置

### Security
- CSP (内容安全策略) 配置
- Asset protocol 限制
- 权限系统控制 API 访问

## Important Files

| File | Purpose |
|------|---------|
| `src/main.rs` | Rust 主进程入口 |
| `build.rs` | 构建脚本 |
| `tauri.conf.json` | Tauri 配置 |

## Conventions

- 使用 Rust std::process 管理子进程
- Node.js 检测: 运行 `node --version` 命令
- 错误处理: 显示友好对话框而非崩溃
- 退出处理: 自动清理激活的路由配置

## Common Operations

```bash
# 开发运行 (需要 Rust 工具链)
yarn tauri:dev

# 构建生产版本
yarn tauri:build

# 生成图标
yarn tauri:icon path/to/icon.png
```

## Platform Notes

### Windows
- 需要 Microsoft Visual Studio C++ Build Tools
- 使用 WebView2 (Windows 10/11 自带)

### macOS
- 需要 Xcode Command Line Tools
- 使用 WebKit

### Linux
- 需要 webkit2gtk 和开发包
- 支持 DEB、AppImage 打包
