# 前端

Vite + React SPA，使用 TanStack Router、TanStack Query 和 Tailwind CSS。依赖及版本见 [package.json](package.json)。

## 开发入口

整套联调与文档地图从[仓库 README](../README.md)开始；前端命令和验证要求见 [AGENTS.md](AGENTS.md)。

## 启动参数

在 `web/` 执行 `pnpm dev`，默认监听 `0.0.0.0:3013`，经同源代理连接 `http://127.0.0.1:7788`。监听地址、端口和后端目标通过 shell 环境变量指定：

```bash
HOST=127.0.0.1 PORT=3015 VITE_BACKEND_PROXY_TARGET=http://127.0.0.1:7789 pnpm dev
```

`VITE_BACKEND_PROXY_TARGET` 不从 `.env` 文件读取。`pnpm dev:mock` 固定使用 `mock` mode 和端口 3014，不连接后端；需要自定义 mock 端口时运行 `VITE_MODE=mock PORT=3015 pnpm dev`。

## 目录

| 路径                                  | 职责                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/app/`                            | Provider、router、主题与工作台注册装配                                                    |
| `src/routes/`                         | 文件路由与应用壳                                                                          |
| `src/features/`                       | 登录、首页、合集、会话、需求单与分镜业务模块                                              |
| `src/shared/api/`                     | REST 客户端与后端合同生成物                                                               |
| `src/shared/auth/`                    | 会话与权限能力                                                                            |
| `src/shared/icons/`、`src/shared/ui/` | 图标与共用 UI 组件                                                                        |
| `src/shared/transcript/`              | 对话协议、订阅与投影；vendor 维护要求见[目录说明](src/shared/transcript/vendor/README.md) |
| `src/shared/workbench/`               | 产物面板宿主、布局与选择状态                                                              |
| `src/shared/lib/`                     | 通用工具                                                                                  |
| `src/testing/`、`e2e/`                | 测试基建、MSW 与浏览器用例                                                                |
| `vite/`、`scripts/`                   | 构建助手与开发、检查命令                                                                  |
| `public/`                             | 静态资源                                                                                  |

## 分镜工作台

分镜工作台用于查看和编辑 Agent 交付的分镜、发起媒体生成。宿主与产品行为见 [ADR-0009](../docs/adr/0009-storyboard-workbench.md)，文件写回与生成约定见[跨端合同](../contract/conventions.md)。
