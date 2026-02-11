# UI Module Conventions

**Generated:** 2026-02-11

## Overview

React 18 + TypeScript 前端应用，使用 Vite 构建，提供供应商管理、路由配置、日志查看等管理界面。

## Structure

```
src/ui/
├── main.tsx              # 应用入口
├── App.tsx                # 根组件、路由配置
├── vite-env.d.ts          # Vite 类型声明
├── api/
│   └── client.ts          # API 客户端 (axios 封装)
├── components/
│   ├── Toast.tsx          #  Toast 通知
│   ├── Modal.tsx          #  模态框
│   ├── Confirm.tsx        #  确认对话框
│   ├── Tooltip.tsx        #  提示工具
│   ├── TitleBar.tsx       #  标题栏
│   ├── Terminal.tsx       #  终端模拟器
│   ├── Switch.tsx          #  开关组件
│   ├── Pagination.tsx     #  分页组件
│   ├── NotificationBar.tsx #  通知栏
│   ├── JSONViewer.tsx     #  JSON 查看器
│   └── ToolsInstallModal.tsx # 工具安装模态框
├── pages/
│   ├── VendorsPage.tsx    # 供应商管理
│   ├── RoutesPage.tsx     # 路由配置
│   ├── SkillsPage.tsx     # Skills 管理
│   ├── LogsPage.tsx       # 日志查看
│   ├── SettingsPage.tsx   # 系统设置
│   ├── WriteConfigPage.tsx # 写入配置
│   ├── UsagePage.tsx      # 使用统计
│   └── StatisticsPage.tsx # 统计页面
├── hooks/
│   ├── useRulesStatus.ts  # 路由状态 Hook
│   ├── useFlipAnimation.ts # 翻转动画 Hook
│   └── docs.ts             # 文档相关 Hook
├── constants/
│   ├── index.ts           # 全局常量
│   └── vendors.ts         # 供应商相关常量
├── styles/
│   └── App.css            # 全局样式
└── assets/                # 静态资源
```

## Key Patterns

### Component Structure
- 组件使用 PascalCase 命名
- Props 接口使用 `Props` 后缀
- 复杂组件拆分为小组件

### State Management
- 本地状态: `useState`、`useReducer`
- 共享状态: React Context
- 数据获取: 自定义 Hook (`hooks/` 目录)

### API Communication
- `api/client.ts` 封装 axios 实例
- 统一错误处理与拦截器
- 敏感字段自动脱敏

### Styling
- CSS Modules 或全局 CSS
- 禁止使用依赖 GPU 的 CSS 动画
- 组件样式与组件文件同目录或统一管理

## Important Files

| File | Purpose |
|------|---------|
| `App.tsx` | 根组件、路由定义 |
| `api/client.ts` | API 通信层 |
| `pages/*` | 各功能页面 |
| `components/*` | 可复用组件 |

## Conventions

- 页面组件位于 `pages/` 目录
- 可复用组件位于 `components/` 目录
- 自定义 Hook 位于 `hooks/` 目录
- 全局常量位于 `constants/` 目录
- 禁止使用 GPU 依赖的 CSS 样式

## Common Operations

```bash
# 开发运行
yarn dev:ui

# 构建生产版本
yarn build:ui

# 类型检查
npx tsc -p tsconfig.json --noEmit
```
