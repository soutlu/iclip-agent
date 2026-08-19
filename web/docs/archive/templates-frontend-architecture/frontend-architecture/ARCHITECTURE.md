# 复杂前端项目通用架构规范（模板）

> 版本：1.0 ｜ 适用：Next.js（App Router / BFF）、Vite SPA、monorepo 子包等任意 TypeScript 前端工程
>
> 本文是「宪法」：只写与具体业务无关的不变量。每个项目通过 `.dependency-cruiser.cjs` 顶部的 **MANIFEST 清单**声明自己启用了哪些层、哪些白名单——规则由清单自动生成，项目不复制规则、只填清单。

---

## 1. 设计目标

复杂前端项目的退化路径几乎是固定的：跨模块随意 import → 隐式循环依赖 → 内部重构牵一发动全身 → 没人敢动老代码。本规范用三个手段拦住退化：

1. **单向分层**：依赖只能向下，方向用工具强制，不靠 review 肉眼。
2. **切片隔离 + 公共 API**：同层业务模块互相不可见，越界必须显式声明（白名单 = 架构决策留痕）。
3. **运行时硬边界**：服务端/客户端代码用构建期毒丸隔离，不靠目录命名自觉。

所有规则满足一个元原则：**违规必须在 CI 失败，而不是在文档里被违反**。

---

## 2. 分层模型

两个正交维度：**抽象层（横向）** 决定「谁能 import 谁」；**运行时轴（纵向）** 决定「代码跑在哪」。

### 2.1 抽象层（自上而下，依赖只能向下）

```
┌─────────────────────────────────────────────────────────┐
│ L5  app/        路由、页面入口、全局 Provider、框架胶水      │  必选
├─────────────────────────────────────────────────────────┤
│ L4  widgets/    跨 feature 组合的页面级区块                 │  可选
├─────────────────────────────────────────────────────────┤
│ L3  features/   业务能力单元（用户可感知的一个功能）          │  必选
├─────────────────────────────────────────────────────────┤
│ L2  entities/   领域内核：领域类型 + 纯领域逻辑 + 领域基础组件 │  可选
├─────────────────────────────────────────────────────────┤
│ L1  shared/     领域无关基础设施：ui kit、lib、hooks、api 基座│  必选
├─────────────────────────────────────────────────────────┤
│ L0  contracts/  跨端契约：纯类型 + 常量 + schema，零依赖      │  推荐
└─────────────────────────────────────────────────────────┘

   server/        （旁路）服务端域逻辑：BFF/全栈项目专用，
                  带 server-only 毒丸，只能依赖 contracts 与
                  白名单内的 shared 纯工具子路径
```

> 层名与 [Feature-Sliced Design](https://feature-sliced.design) 对齐（app/widgets/features/entities/shared），便于团队复用社区心智；在 FSD 基础上增加 `contracts`（跨端契约）与 `server`（BFF 旁路）两个现代全栈前端必需的概念。

### 2.2 各层职责与准入标准

| 层 | 放什么 | 不放什么 | 切片化 |
| --- | --- | --- | --- |
| `app` | 路由文件、layout、全局 providers、框架约定文件（Next 的 `page/layout/route`、Vite 的 `main.tsx` + router 配置）、route-local 私有目录（`_components` 等） | 可复用业务逻辑（被第二个路由用到就下沉） | 按路由组织 |
| `widgets` | 由多个 feature 组合的大块 UI（如「带侧栏会话 + 画布的工作台」） | 业务规则本体（属于 feature） | ✅ 每个 widget 一个切片 |
| `features` | 一个用户可感知的功能闭环：UI + 状态 + 客户端 api 调用 | 跨 feature 共享的领域模型（下沉 entities）、通用 UI（下沉 shared） | ✅ 每个 feature 一个切片 |
| `entities` | 被 ≥2 个 feature 共享的领域名词：类型、纯函数、领域展示组件（如 `Money`、`UserAvatar`、订单状态机） | 流程编排、页面布局、fetch 副作用 | ✅ 每个实体一个切片 |
| `shared` | 与业务领域完全无关的能力：ui kit、hooks、lib、http client 基座、env 客户端入口 | 任何出现领域名词的代码 | 按技术类别分目录，不算业务切片 |
| `contracts` | 浏览器与 BFF/后端共守的协议：请求/响应类型、常量（cookie 名、事件名）、schema 校验、纯解析函数 | React、框架 API、fetch、任何副作用 | 按域分文件 |
| `server` | 服务端域逻辑：上游调用、token 注入、流式代理、服务端 env 校验 | UI、客户端状态 | 按域分文件/目录 |

### 2.3 运行时轴

| 标记 | 含义 | 强制手段 |
| --- | --- | --- |
| server-only | 只能在服务端运行（含密钥、Node API、上游 origin） | 每个 `server/**` 模块首行 `import 'server-only'`（depcruise `required` 规则保证不漏写）；客户端误引 → **构建失败** |
| isomorphic | 双端可跑 | `contracts/` 与 `shared/` 默认要求同构（不碰 `window`/Node API 的纯逻辑） |
| client-only | 仅浏览器 | 默认态，无需标记；Next 项目由 `'use client'` 表达 |

纯 SPA 项目没有 server 层，此轴退化为「`contracts/shared` 保持环境无关」一条。

---

## 3. 依赖方向规则（宪法条款）

以下条款由 `.dependency-cruiser.cjs` 自动生成并在 CI 强制，编号供 PR/评审引用：

| 条款 | 规则 | 生成方式 |
| --- | --- | --- |
| **A1 单向分层** | 任意层不得 import 其上方任何层 | 由 MANIFEST `layers` 顺序两两生成 |
| **A2 切片隔离** | 同层切片互相不可依赖，除非进入 `allowedSliceDeps` 白名单；白名单不得成环 | 切片自动发现 + 白名单生成 |
| **A3 公共 API** | 切片外部（含同层其他切片）只能 import 该切片的 `index.ts(x)` | 通用规则 |
| **A4 契约零依赖** | `contracts` 不得依赖 `src` 内任何其他模块 | 通用规则 |
| **A5 服务端隔离** | `server` 只能依赖自身、`contracts`、白名单内 shared 子路径 | MANIFEST `server.allowedShared` |
| **A6 服务端入口净化** | BFF 入口（`app/api`、`middleware`/`proxy` 等）不得依赖任何客户端切片层，跨端共享一律走 `contracts` | MANIFEST `server.entrypoints` |
| **A7 毒丸必涂** | `server/**` 每个模块必须依赖 `server-only` | depcruise `required` 规则 |
| **A8 零循环** | 全图禁止循环依赖（type-only import 同样计入） | `tsPreCompilationDeps: true` |
| **A9 无孤儿** | 无人引用且不引用任何人的模块视为死代码（warn） | 通用规则，排除框架约定文件 |

**派生约定**（由源码契约测试强制，见 arch-tests）：

- **B1** `process.env` 只允许出现在 env 入口模块（服务端 `server/env.ts` + 客户端 `shared/env.client.ts`）。
- **B2** 服务端目录中不得出现 `'use client'`。
- **B3** 每个切片必须有 `index.ts`；`src` 下不允许空目录。
- **B4** 单文件行数 ≤ 上限（默认 800）；存量超标文件进 ratchet 清单，只许缩小。
- **B5** 协议字面量（cookie 名、storage key、事件名等）只允许出现在声明的唯一来源文件。

---

## 4. 「这段代码放哪」决策树

```
是浏览器与服务端共守的协议（类型/常量/schema）？
└─ 是 → contracts/
只在服务端运行（密钥、上游调用、Node API）？
└─ 是 → server/（首行毒丸）
代码里出现业务领域名词吗？
├─ 否 → shared/（ui / lib / hooks / config）
└─ 是 ↓
是被 ≥2 个 feature 使用的领域名词本体（类型/纯逻辑/基础展示）？
├─ 是 → entities/<名词>/
└─ 否 ↓
是一个用户可感知的功能闭环？
├─ 是 → features/<功能>/
└─ 否 ↓
是多个 feature 的页面级组合？
├─ 是 → widgets/<区块>/（未启用 widgets 层则放 app 的 route-local）
└─ 否 → 只被单一路由使用 → app/<路由>/_components 等私有目录
```

**提升规则**：代码先放在最靠上、最局部的位置（route-local），出现第二个真实使用方时才下沉一层。禁止「预防性下沉」。

---

## 5. 切片内部模板

```
<layer>/<slice>/
├── index.ts        # 唯一对外出口；只导出外部真正需要的符号（A3 的载体）
├── api/            # 客户端数据访问（fetch + AbortSignal）
├── model/          # 纯逻辑：*.types.ts、*.utils.ts、adapters —— 禁 import React/框架
├── state/          # store / Provider / context
├── hooks/          # use*
└── components/     # UI
```

- 小切片可以省略子目录（文件直接平铺），但**超过 ~8 个文件必须按模板归类**。
- `index.ts` 是边界不是仓库：禁止 `export * from` 全量转发；禁止嵌套 barrel（子目录不再设 index）；禁止层级总 barrel（如 `features/index.ts`）——这三条是 barrel 不拖垮 tree-shaking/HMR 的前提。
- `model/` 不依赖 React 的意义：可被 server、worker、测试零成本复用；做不到时说明它其实属于 contracts 或 state。

---

## 6. 可选层启用时机

| 信号 | 动作 |
| --- | --- |
| 两个 feature 开始互相 import 对方的类型/纯逻辑 | 启用 `entities`，把共享领域名词下沉；而不是加白名单 |
| 某 feature 的白名单超过 2 项 | 它大概率是 widget（组合体）或包含了该下沉的 entity |
| app 路由文件里组合逻辑超过 ~200 行 | 启用 `widgets` 承接组合 |
| 出现第二个运行端（BFF、Electron main、worker 协议） | 启用 `contracts` |
| 纯 SPA 且无跨端协议 | 可不启用 `contracts` 与 `server`，层模型退化为 app/features/shared 三层 |

**白名单的本质是债务登记簿**：每一项都应附「为什么不下沉」的理由注释，评审时优先质疑白名单增项而非代码细节。

---

## 7. 测试与质量结构（通用）

```
tests/
├── unit/<镜像 src 路径>/   # 单测路径 = 被测模块路径，杜绝"找不到测试"
├── arch/                   # 架构契约测试（依赖规则 + 源码约定），进 vitest 默认运行
├── e2e/                    # 端到端（playwright 等）
└── stubs/                  # server-only 等环境 stub
```

- **质量契约 = `npm run ci:check`**：`lint → typecheck → arch:check → test:unit`。CI 平台 yaml 只是这个契约的薄壳（见 ci/ 模板），换 CI 平台不换契约。
- 架构测试进 `npm test`：开发者日常跑测试即校验架构，不依赖"记得跑另一个命令"。
- `build` 在 CI 单独执行：server-only 毒丸与框架级错误只在构建期暴露（vitest 中毒丸被 stub）。

---

## 8. 治理流程

1. **改架构 = 改 MANIFEST**：新增层、调整白名单、放宽规则，只能通过修改 `.dependency-cruiser.cjs` 顶部清单完成，PR 中必须说明理由；规则体本身（生成器）原则上不动。
2. **基线只缩不涨**：存量项目接入时用 `arch:baseline` 冻结现状（已知违规进 `.dependency-cruiser-known-violations.json`），此后该文件 diff 只允许删行；清零后删除文件与 `--ignore-known` 参数。
3. **豁免集中可见**：源码级豁免（env 散点、行数 ratchet、字面量来源）全部集中在 arch-tests 顶部常量区，带 `TODO(清账)` 注释。
4. **规范与工具同步**：本文条款变更必须与生成器/测试同 PR；只改文档不改工具的提案直接拒绝（回到元原则）。

---

## 9. 框架适配说明

### Next.js（App Router，含 BFF）

- `app/` 即 L5；route handler 保持「薄」：解析请求 → 调 `server/` → 映射响应。
- `middleware.ts` / `proxy.ts` 属于 A6 的服务端入口。
- `NEXT_PUBLIC_*` 必须以 `process.env.NEXT_PUBLIC_X` 字面量形式集中在 `shared/env.client.ts`（构建期文本内联的要求）。
- MANIFEST：`server` 配置完整启用。

### Vite / 纯 SPA

- L5 为 `app/`（入口 + router 配置 + providers），页面组件放 `app/routes/` 或启用 `pages` 命名均可，清单里改 `layers` 即可。
- MANIFEST：`server: null`，A5–A7 自动关闭；其余条款不变。
- env 入口为 `shared/env.client.ts`（`import.meta.env`），B1 的匹配模式相应调整。

### Monorepo

- 层模型映射到包：`contracts` → `packages/contracts`，`shared/ui` → `packages/ui`，每个 app 包内仍保留 app/features(/entities) 层。
- 包内方向：本模板原样生效（每包一份 MANIFEST）。
- 跨包方向：由 workspace 依赖图天然强制（package.json 不声明就 import 不到），辅以 `no-restricted-imports` 禁止 `../../packages/*/src` 直捅源码。

---

## 10. 已知取舍

| 决策 | 取舍 |
| --- | --- |
| dependency-cruiser 而非 ESLint boundaries 插件 | 独立于 linter 选型（Biome/ESLint/oxlint 均可共存）；支持循环检测、required 规则、`$1` 组匹配、基线冻结。代价：多一个 devDependency |
| 切片边界用单层 barrel | 重构自由度 > 极限 tree-shaking；用「禁嵌套/禁全量转发/禁层级总 barrel」控制代价 |
| 规则生成器读文件系统自动发现切片 | 新增切片零配置即被纳管；代价：config 含少量逻辑（生成器 <100 行，一次写好不再动） |
| 测试独立 `tests/` 目录镜像 src 而非 colocation | 对构建排除、lint includes、框架目录约定零侵入；镜像路径已解决可发现性 |
| 行数限制用 ratchet 而非一次重构 | 防止新增巨文件的同时，把存量拆分压力分散到日常迭代 |
