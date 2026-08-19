# Producer 前端架构优化与防回归固化方案

> **⚠️ 已过时（2026-07-08）**：本方案基于 Next.js BFF 架构撰写，项目已迁移为 Vite 纯 SPA（见 `vite-migration-plan.md`），其中 `app/api`、`proxy.ts`、`server-only`、`NEXT_PUBLIC_*` 等假设不再成立。当前生效的整理计划见 **`refactor-plan-2026-07-08.md`**。
>
> 状态：已废弃 ｜ 撰写日期：2026-06-09 ｜ 适用版本：Next.js 16.2 / React 19 / Biome 2.4 / Vitest 4
>
> 本文是完整实施方案，不是已执行的变更。落地时按第 5 节路线图分阶段执行，每个 Phase 走一次 Trellis 任务流程（`task.py create`）。
>
> 注意：`docs/` 与 `.trellis/` 均在 `.gitignore` 中。本文件为本地文档；方案中规定的**固化产物**（`.dependency-cruiser.cjs`、`tests/arch/**`、基线文件等）必须进入版本库。

---

## 0. 摘要

本项目定位是「Next.js BFF 形态的前端工程」：真正的业务后端在独立服务，Next 服务端只承担认证 Cookie、流式代理、路由保护。本方案不改变这一定位，解决的是**模块分配与结构约束**问题：

1. **结构上**：确立 `contracts → shared → features → app/server` 的单向分层；拆掉 chat↔agent-flow 循环依赖；把跨端契约（cookie 名、auth 类型等）从客户端 feature 下沉到独立契约层；feature 对外只暴露 `index.ts` 公共 API。
2. **固化上**：用三层机制把规则变成可执行约束，防止回归：
   - **dependency-cruiser**（架构文件 `.dependency-cruiser.cjs` + 违规基线文件）：依赖方向、循环、barrel 收口、白名单；
   - **架构契约测试**（`tests/arch/**`，进 vitest）：源码级约定（env 访问、server/client 边界、空目录、巨文件行数 ratchet）；
   - **构建期毒丸**（`server-only` 包）：客户端误引服务端代码直接编译失败。
3. **策略上**：先冻结现状（已知违规进基线，新增违规立即报错），再分四个 Phase 清账。第 0 天就获得防回归能力，不需要等重构完成。

---

## 1. 背景与目标

### 1.1 背景

- 项目已有 `app / features / shared / server` 四层雏形，且**无上行违规**（shared 未引 features，features 未引 app/server），基础好于多数同规模项目。
- 但所有边界规则只存在于 `.trellis/spec/frontend/implementation.md` 的文字描述中，**没有任何自动化校验**。spec 明文规定「不写 import cycle」，而 chat↔agent-flow 的循环依赖已实际存在——证明纯文档约束必然回归。
- 202 个 TS/TSX 文件、37k 行代码，仍处于「一天能迁完一个 Phase」的窗口期。再晚成本指数上升。

### 1.2 目标

| # | 目标 | 衡量方式 |
| --- | --- | --- |
| G1 | 依赖方向单向化，零循环 | `npm run arch:check` 通过且基线清零 |
| G2 | feature 公共 API 收口 | feature 外部 import 全部走 `index.ts` |
| G3 | 服务端/客户端硬边界 | `server-only` 毒丸 + BFF 不引 features |
| G4 | 规则可执行、违规即失败 | `ci:check` 包含 arch 校验，新违规无法合入 |
| G5 | 知识固化进 spec 体系 | `.trellis/spec/frontend/architecture.md` 建立 |

**非目标**：不迁移构建工具（维持 Next/Turbopack）；不重写业务逻辑；不强制一次性拆完巨型文件（用 ratchet 渐进）。

---

## 2. 现状诊断

### 2.1 现有结构盘点（保留的基础）

```
src/
├── app/                  # 路由层：(home)、login、projects/[id]，route-local _components/_hooks/_utils/_state
│   └── api/              # BFF：auth、projects、sessions、agui、agentos、files、video-generations…（20+ route）
├── features/             # 业务域：agent-flow、artifacts、auth、chat、history(空)、project-canvas、projects
├── server/               # 服务端助手：backend-api.ts、producer-bff-auth.ts
├── shared/               # 通用层：composer、editor、hooks、lib、markdown、theme、ui
└── proxy.ts              # Next 16 代理（登录态路由保护）
```

做得对的部分（全部保留）：
- 分层方向整体干净：`grep` 证实无 shared→features/app/server、无 features→app/server。
- 每个 feature 有 `index.ts` barrel（除空的 history）。
- route-local 私有目录约定（`_components` 等）符合 App Router 最佳实践。
- `auth`/`projects` 已有 `*.api.ts`（BFF 客户端调用）与 `*.types.ts` 分离；`chat` 已有 `contracts.ts`。
- BFF 安全模式正确（HttpOnly Cookie、token 不出服务端、`proxy.ts` 只查 cookie 存在性）。

### 2.2 问题清单

| 编号 | 问题 | 证据 | 危害 |
| --- | --- | --- | --- |
| P1 | **feature 循环依赖** chat↔agent-flow | chat 3 处引 agent-flow；agent-flow 4 处引 chat，其 `index.ts` 甚至 re-export chat 类型（`export type { ProjectToolLogEntry } from '@/features/chat'`） | 边界是假的，两个域实为一体；违反 spec「不写 import cycle」 |
| P2 | **跨 feature 依赖无规则** | project-canvas→artifacts(16)、chat→projects(4)、project-canvas→chat(3)、chat→artifacts(3) | 没有声明谁可以依赖谁，耦合只会单调增加 |
| P3 | **barrel 被绕过** | app 层 10 处深层导入 feature 内部（如 `@/features/project-canvas/components/nodes/StoryboardWorkbenchCanvasNode`、`@/features/chat/project-pending-draft`） | feature 内部重构会破坏外部调用方，公共 API 形同虚设 |
| P4 | **server/client 无硬边界** | `src/server/**` 无 `import 'server-only'`；BFF（`app/api/auth/_shared.ts`、`ws-ticket/route.ts`、`proxy.ts`）直接 import `@/features/auth/*` | 无机制阻止客户端组件引入 undici/后端 origin；服务端与客户端 feature 目录互相渗透 |
| P5 | **巨型文件** | StoryboardWorkbenchCanvasNode.tsx 2169 行、project-assistant-messages.ts 1810 行、project-canvas-store.tsx 1571 行、ProjectConversationPanel.tsx 1528 行，Top7 均 >1200 行 | 组件/状态/适配器混杂，review 与测试成本高 |
| P6 | **feature 根目录平铺** | artifacts 根 17 个文件、chat 根 16 个文件，types/utils/runtime/adapters 混放 | 无内部结构约定，新文件无处安放 |
| P7 | **死目录与死配置** | `features/history/` 空；`app/brief-rich-preview/`、`app/markdown-image-parser-preview/` 空；`playwright.config.ts` 的 `testDir: './tests/e2e'` 指向不存在的目录 | 误导阅读者；e2e 配置不可运行 |
| P8 | **测试组织失序** | 70 个测试平铺 `tests/unit/`，无目录映射；Biome `files.includes` 只含 `src/**`，**tests 不被 lint/format** | 找不到某模块的测试；测试代码质量无人管 |
| P9 | **env 访问分散且无校验** | `process.env` 出现在 `app/api/auth/_shared.ts`、`features/projects/producer-generation-events.ts`、`server/backend-api.ts`，无启动时校验 | 配置错误延迟到运行时爆炸；NEXT_PUBLIC 与服务端 env 不区分 |
| P10 | **零架构防回归机制** | 上述所有规则只在 spec 文档里 | 文档约束已被 P1 证伪 |

仓库卫生（顺手修复）：`src.zip` 未跟踪文件位于仓库根；`tmp/`、`output/`、`downloads/` 需确认是否该入库（`git ls-files tmp output downloads` 验证），不需要则加 `.gitignore`。

---

## 3. 目标架构

### 3.1 分层模型与依赖方向

```
            ┌────────────────────────────────────────────┐
  L4 路由层  │  src/app/**（页面） src/app/api/** + src/proxy.ts（BFF）│
            └──────┬─────────────────────┬───────────────┘
                   │                     │
  L3 服务端域      │              ┌──────▼───────┐
                   │              │  src/server   │ import 'server-only'
                   │              └──────┬───────┘
            ┌──────▼───────┐             │
  L2 业务域  │ src/features  │             │
            └──────┬───────┘             │
            ┌──────▼───────┐             │
  L1 通用层  │ src/shared    │◄────────────┘（仅纯工具，禁 UI）
            └──────┬───────┘
            ┌──────▼─────────────┐
  L0 契约层  │ src/shared/contracts │ 零依赖、同构、纯类型+常量+校验
            └────────────────────┘
```

**方向规则（即 4.1 节 depcruise 规则的人话版）：**

| from | 允许 to | 禁止 to |
| --- | --- | --- |
| `app`（页面） | features（仅 barrel）、shared、contracts | server、app/api 内部 |
| `app/api`、`proxy.ts` | server、contracts、shared/lib（纯工具） | **features**、shared/ui 等含 UI 模块 |
| `server` | server 内部、contracts、`server-only` | features、app、shared 其余部分 |
| `features/<x>` | 白名单内其他 feature（仅 barrel）、shared、contracts | app、server、白名单外 feature |
| `shared`（除 contracts） | shared 内部 | features、app、server |
| `shared/contracts` | 仅 contracts 内部 | src 内一切其他模块 |

### 3.2 目标目录骨架

```
src/
├── proxy.ts                        # 不变（Next 16 约定，spec 已规定不回退 middleware.ts）
├── app/
│   ├── layout.tsx / globals.css / favicon.ico
│   ├── (home)/                     # 不变：route-local 私有目录约定保留
│   ├── login/
│   ├── projects/[id]/
│   └── api/                        # route handler 保持「薄」：解析→调 src/server→映射响应
├── server/                         # ⚠ 每个文件首行 import 'server-only'
│   ├── env.ts                      # 新增：服务端 env 唯一入口（启动校验）
│   ├── backend-api.ts
│   └── producer-bff-auth.ts
├── features/
│   ├── artifacts/                  # 领域内核：被 chat / project-canvas 消费
│   ├── auth/
│   ├── chat/
│   │   └── agent-tools/            # 新增：原 agent-flow 并入（见 3.4）
│   ├── project-canvas/
│   └── projects/                   # 领域内核：项目/session 元数据
│   # history/ 删除；agent-flow/ 并入 chat
└── shared/
    ├── contracts/                  # 新增 L0：跨端契约
    │   ├── auth.ts                 # cookie 名、ProducerAuthUser、登录请求/响应类型
    │   └── …                       # 后续按域增加（chat run 状态、ws ticket 等）
    ├── env.client.ts               # 新增：NEXT_PUBLIC_* 唯一入口
    ├── composer/ editor/ hooks/ lib/ markdown/ theme/ ui/   # 不变
tests/
├── unit/<镜像 src 路径>/            # 如 tests/unit/features/chat/project-chat.utils.spec.ts
├── arch/                           # 新增：架构契约测试
│   ├── dependency-rules.spec.ts
│   └── source-conventions.spec.ts
├── e2e/                            # 补建（playwright testDir 已指向此处）
└── stubs/server-only.ts            # vitest 用空 stub
```

### 3.3 feature 内部结构模板

新增文件按此模板放置；存量文件**被修改时**顺势归位（不专门发起搬家 PR，见 Phase 4）：

```
features/<domain>/
├── index.ts        # 唯一对外出口；只 export 外部真正需要的符号
├── api/            # BFF 客户端调用（fetch + AbortSignal），如 producer-project.api.ts
├── model/          # 纯领域逻辑：*.types.ts、*.utils.ts、adapters（禁 React）
├── state/          # zustand store、Provider、context
├── hooks/          # use*
└── components/     # UI（可再分子目录）
```

配套规则（进 spec 与 arch 测试）：
- 单文件 ≤ 800 行；存量超标文件进 ratchet 清单，只许减不许增（见 4.4）。
- `model/` 内禁止 import React / next（保证可被 server 与测试低成本复用——若某 model 需跨端，应下沉 contracts）。

### 3.4 跨 feature 白名单与解环决策

**解环：agent-flow 并入 chat，成为 `chat/agent-tools/` 子模块。**

理由：agent-flow 仅 3 个根文件 + 1 个组件目录，与 chat 双向纠缠 7 处，其 barrel 还 re-export chat 的类型——它从未真正独立。把「工具调用 UI（AskUserQuestion、tool log）」视作 chat 的子能力符合实际。备选方案（共享类型下沉 contracts 保持两个 feature）成本更高且边界依然牵强，不采用。

合并后的依赖图为 **DAG**：

```
auth        →  (无)
artifacts   →  (无)          ← 领域内核
projects    →  (无)          ← 领域内核
chat        →  artifacts, projects
project-canvas → artifacts, projects, chat
```

白名单固化为配置（见 4.1 的 `FEATURE_ALLOWED`）。新增跨 feature 依赖 = 修改白名单 = 显式架构决策，需在 PR 中说明并同步 `.trellis/spec/frontend/architecture.md`。

> project-canvas→chat 的 3 处依赖（canvas store / FocusedArtifact / VideoPromptCanvasNode 读取 chat 运行态）暂时合法化。若后续希望 canvas 不依赖 chat，应把「会话运行态契约」下沉 contracts——记为待议，不阻塞本方案。

### 3.5 跨端契约层 `shared/contracts`

**动机**：BFF（服务端）现在直接 import `@/features/auth/producer-auth.constants` 拿 cookie 名——服务端代码依赖客户端 feature 目录，方向是错的。这些本质是「浏览器和 BFF 共守的协议」，应放在双方都能依赖的最底层。

**规则**：
- 只允许：纯类型、常量、纯函数校验/解析（如 `parseProducerLoginRequest`）。
- 禁止：React、next/*、fetch 调用、zustand、任何副作用。depcruise 规则强制其零内部依赖。
- 首批迁入：`PRODUCER_ACCESS_TOKEN_COOKIE`、`ProducerAuthUser`、登录请求/响应类型与解析、`sanitizeProducerAuthNextPath`（`proxy.ts` 与登录页共用）。
- `state-management.md` 中既有契约描述（cookie 属性、登录响应不得含 token 等）不变，实现位置统一指向 contracts。

### 3.6 env 集中管理

```ts
// src/server/env.ts —— 服务端唯一 env 入口
import 'server-only';

/**
 * 读取并校验必填的服务端环境变量。
 *
 * @param name - 环境变量名。
 * @returns 非空字符串值。
 * @throws 当变量缺失或为空时抛出错误，使配置问题在启动期暴露。
 */
const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少必需的环境变量：${name}`);
  }
  return value;
};

export const serverEnv = {
  backendOrigin: requireEnv('PRODUCER_BACKEND_ORIGIN'), // 以现有实际变量名为准
} as const;
```

```ts
// src/shared/env.client.ts —— NEXT_PUBLIC_* 唯一入口
// 注意：必须保留 process.env.NEXT_PUBLIC_X 字面量写法，Next 构建期做文本内联。

export const clientEnv = {
  producerBackendWsUrl: process.env.NEXT_PUBLIC_PRODUCER_BACKEND_WS_URL?.trim(),
} as const;
```

其余位置出现 `process.env` 一律视为违规（由 4.4 的源码契约测试强制，初始放行存量 3 处，Phase 3 清零）。

---

## 4. 防回归固化机制（核心交付）

三层防线，对应关系：

| 防线 | 载体 | 拦截时机 | 覆盖 |
| --- | --- | --- | --- |
| 依赖图规则 | `.dependency-cruiser.cjs` + 基线 | `arch:check`（CI / 本地） | 方向、循环、白名单、barrel、孤儿 |
| 源码契约测试 | `tests/arch/**`（vitest） | `npm test`（开发者日常） | env 访问、'use client' 位置、空目录、行数 ratchet、契约字面量唯一性 |
| 构建毒丸 | `server-only` 包 | `next build` / dev | 客户端误引服务端模块 |

### 4.1 `.dependency-cruiser.cjs`（完整内容）

新增 devDependency：`dependency-cruiser@^16`。

```js
/**
 * Producer 前端架构依赖规则。
 *
 * 修改本文件 = 架构决策，必须同步更新 .trellis/spec/frontend/architecture.md。
 * 清理存量违规后运行 `npm run arch:baseline` 收缩基线文件。
 */

/** feature 间依赖白名单：key 可以依赖 value 列表中的 feature（均只许经 index.ts）。 */
const FEATURE_ALLOWED = {
  artifacts: [],
  auth: [],
  chat: ['artifacts', 'projects'],
  'project-canvas': ['artifacts', 'projects', 'chat'],
  projects: [],
};

/** 由白名单生成每个 feature 的越界禁令。 */
const featureWhitelistRules = Object.entries(FEATURE_ALLOWED).map(([feature, allowed]) => ({
  name: `feature-deps-${feature}`,
  comment: `features/${feature} 只能依赖白名单内 feature：[${allowed.join(', ') || '无'}]`,
  severity: 'error',
  from: { path: `^src/features/${feature}/` },
  to: { path: `^src/features/(?!(${[feature, ...allowed].join('|')})/)` },
}));

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: '禁止任何循环依赖（含 type-only）',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-zero-deps',
      comment: '契约层是 L0：不得依赖 src 内任何其他模块',
      severity: 'error',
      from: { path: '^src/shared/contracts/' },
      to: { path: '^src/', pathNot: '^src/shared/contracts/' },
    },
    {
      name: 'shared-stays-bottom',
      comment: 'shared 是 L1：不得依赖 features/app/server',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(features|app|server)/' },
    },
    {
      name: 'features-no-upper-layers',
      comment: 'features 是 L2：不得依赖 app/server',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/(app|server)/|^src/proxy\\.ts$' },
    },
    {
      name: 'server-keeps-to-itself',
      comment: 'server 只能依赖 server 内部与 contracts',
      severity: 'error',
      from: { path: '^src/server/' },
      to: { path: '^src/', pathNot: '^src/(server/|shared/contracts/)' },
    },
    {
      name: 'bff-no-client-features',
      comment: 'BFF（app/api 与 proxy.ts）不得依赖客户端 features，跨端共享走 contracts',
      severity: 'error',
      from: { path: '^src/(app/api/|proxy\\.ts$)' },
      to: { path: '^src/features/' },
    },
    {
      name: 'feature-public-api-only',
      comment: 'feature 外部只能通过 features/<x>/index.ts 引入',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/features/' },
      to: {
        path: '^src/features/[^/]+/.',
        pathNot: '^src/features/[^/]+/index\\.ts$',
      },
    },
    {
      name: 'cross-feature-via-barrel-only',
      comment: 'feature 之间也只能经对方 index.ts（$1 为来源 feature 名）',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/(?!$1/)[^/]+/.',
        pathNot: '^src/features/[^/]+/index\\.ts$',
      },
    },
    {
      name: 'no-orphans',
      comment: '孤儿模块（无人引用且不引用任何人）通常是死代码',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '\\.css$',
          '^src/app/', // Next 约定文件由框架引用
          '^src/proxy\\.ts$',
        ],
      },
      to: {},
    },
  ],
  required: [
    {
      name: 'server-must-be-poisoned',
      comment: 'src/server 下每个模块必须 import "server-only"（构建期毒丸）',
      severity: 'error',
      module: { path: '^src/server/[^/]+\\.ts$' },
      to: { path: 'server-only' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true, // type-only import 同样构成架构耦合
  },
};
```

### 4.2 基线冻结策略（第 0 天即获得防回归）

存量违规不阻塞规则上线——用 dependency-cruiser 的 known-violations 基线：

```bash
# Phase 0 一次性生成基线（把 2.2 节的存量违规全部冻结）
npm run arch:baseline   # 生成 .dependency-cruiser-known-violations.json（进版本库）

# 日常与 CI 校验：老账不报、新账即错
npm run arch:check      # depcruise src --config .dependency-cruiser.cjs --ignore-known
```

规约：**基线文件只许缩小，不许扩大**。每个清账 Phase 结束时重新生成基线并在 PR 中展示 diff。全部清零后删除基线文件与 `--ignore-known` 参数。

### 4.3 `tests/arch/dependency-rules.spec.ts`

让 `npm test` 同样覆盖架构（开发者不需要记得单独跑 arch:check）：

```ts
import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('架构依赖契约（dependency-cruiser）', () => {
  it('src 依赖图符合 .dependency-cruiser.cjs 全部规则（基线内除外）', () => {
    /**
     * 调用与 CI 相同的 arch:check 命令，保证本地测试与 CI 行为一致。
     * 失败时把 depcruise 的违规报告作为断言信息抛出。
     */
    try {
      execSync('npx depcruise src --config .dependency-cruiser.cjs --ignore-known', {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
      });
    } catch (error) {
      const report =
        error instanceof Error && 'stdout' in error
          ? String((error as { stdout: Buffer }).stdout)
          : String(error);
      expect.fail(`依赖规则违规：\n${report}`);
    }
  });
});
```

### 4.4 `tests/arch/source-conventions.spec.ts`

覆盖依赖图表达不了的源码级约定。所有「存量豁免」集中在文件顶部常量区，清账即删：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');

/** Phase 3 前临时放行的 process.env 访问点；清账后应只剩 env 两个入口。 */
const ENV_ACCESS_ALLOWLIST = new Set([
  'src/server/env.ts',
  'src/shared/env.client.ts',
  // TODO(Phase 3 清账)：
  'src/app/api/auth/_shared.ts',
  'src/features/projects/producer-generation-events.ts',
  'src/server/backend-api.ts',
]);

/** cookie 名字面量唯一来源；Phase 1 契约下沉后收紧为 contracts 单文件。 */
const COOKIE_LITERAL_ALLOWLIST = new Set([
  'src/shared/contracts/auth.ts',
  // TODO(Phase 1 清账)：
  'src/features/auth/producer-auth.constants.ts',
]);

/** 巨型文件 ratchet：只许变小，不许变大。拆完一个删一行。 */
const LEGACY_LINE_BUDGET: Record<string, number> = {
  'src/features/project-canvas/components/nodes/StoryboardWorkbenchCanvasNode.tsx': 2169,
  'src/features/chat/project-assistant-messages.ts': 1810,
  'src/features/project-canvas/state/project-canvas-store.tsx': 1571,
  'src/features/chat/components/sidebar/ProjectConversationPanel.tsx': 1528,
  'src/features/artifacts/renderers/VideoPromptCanvasCard.tsx': 1325,
  'src/features/chat/ProjectChatProvider.tsx': 1202,
  'src/features/chat/project-state.adapters.ts': 822,
};

/** 新文件行数上限。 */
const MAX_LINES = 800;

/**
 * 递归收集目录下全部 TS/TSX 源文件的相对路径（posix 分隔）。
 *
 * @param dir - 绝对目录路径。
 * @returns 相对项目根的文件路径数组。
 */
const collectSourceFiles = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(absolute);
    }
    if (/\.(ts|tsx)$/.test(entry.name)) {
      return [path.relative(PROJECT_ROOT, absolute).split(path.sep).join('/')];
    }
    return [];
  });
};

/**
 * 递归收集目录下的全部空目录。
 *
 * @param dir - 绝对目录路径。
 * @returns 空目录的相对路径数组。
 */
const collectEmptyDirs = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) {
    return [path.relative(PROJECT_ROOT, dir)];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => collectEmptyDirs(path.join(dir, entry.name)));
};

const sourceFiles = collectSourceFiles(SRC_ROOT);
const readSource = (relative: string) => fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');

describe('源码级架构契约', () => {
  it('process.env 只出现在 env 入口模块（及待清账豁免）', () => {
    const violations = sourceFiles.filter(
      (file) => !ENV_ACCESS_ALLOWLIST.has(file) && /\bprocess\.env\b/.test(readSource(file)),
    );
    expect(violations).toEqual([]);
  });

  it('服务端代码（server、app/api、proxy.ts）不得出现 use client 指令', () => {
    const serverFiles = sourceFiles.filter(
      (file) => file.startsWith('src/server/') || file.startsWith('src/app/api/') || file === 'src/proxy.ts',
    );
    const violations = serverFiles.filter((file) => /['"]use client['"]/.test(readSource(file)));
    expect(violations).toEqual([]);
  });

  it('每个 feature 目录必须有 index.ts 公共出口', () => {
    const featuresRoot = path.join(SRC_ROOT, 'features');
    const missing = fs
      .readdirSync(featuresRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !fs.existsSync(path.join(featuresRoot, entry.name, 'index.ts')))
      .map((entry) => entry.name);
    expect(missing).toEqual([]);
  });

  it('src 下不允许存在空目录（死目录立即清理）', () => {
    expect(collectEmptyDirs(SRC_ROOT)).toEqual([]);
  });

  it('登录态 cookie 名字面量只允许出现在契约层', () => {
    const violations = sourceFiles.filter(
      (file) => !COOKIE_LITERAL_ALLOWLIST.has(file) && readSource(file).includes('producer_access_token'),
    );
    expect(violations).toEqual([]);
  });

  it('文件行数：新文件 ≤ 800 行；遗留巨型文件只许缩小（ratchet）', () => {
    const violations = sourceFiles.flatMap((file) => {
      const lines = readSource(file).split('\n').length;
      const budget = LEGACY_LINE_BUDGET[file] ?? MAX_LINES;
      return lines > budget ? [`${file}: ${lines} 行（上限 ${budget}）`] : [];
    });
    expect(violations).toEqual([]);
  });
});
```

### 4.5 `server-only` 毒丸与 vitest stub

1. 安装：`npm i server-only`（`client-only` 暂不引入，现阶段无明确客户端独占模块）。
2. `src/server/` 下每个文件首行加 `import 'server-only';`（depcruise `required` 规则保证不漏）。
3. vitest 环境没有 react-server 条件，直接 import 会抛错，需 stub：

```ts
// tests/stubs/server-only.ts
// vitest 环境下对 server-only 毒丸的空实现，仅用于单测可加载 BFF/服务端模块。
export {};
```

```ts
// vitest.config.ts（更新后全文）
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: [
      'tests/unit/**/*.spec.ts',
      'tests/unit/**/*.spec.tsx',
      'tests/arch/**/*.spec.ts',
    ],
  },
});
```

### 4.6 工具链接入

**package.json**（diff 摘要）：

```jsonc
{
  "scripts": {
    // 修改：
    "ci:check": "npm run lint && npm run typecheck && npm run arch:check && npm run test:unit",
    "lint": "biome lint ./src ./tests",
    "format": "biome format --write ./src ./tests",
    "check": "biome check --write ./src ./tests",
    // 新增：
    "arch:check": "depcruise src --config .dependency-cruiser.cjs --ignore-known",
    "arch:baseline": "depcruise src --config .dependency-cruiser.cjs --output-type baseline --output-to .dependency-cruiser-known-violations.json"
  },
  "dependencies": { "server-only": "^0.0.1" },
  "devDependencies": { "dependency-cruiser": "^16" }
}
```

**biome.json**：`files.includes` 改为 `["src/**", "tests/**"]`（解决 P8 中「测试不被 lint」）。

**playwright.config.ts**：补建 `tests/e2e/` 并放入最小 smoke 用例（登录页可渲染）；或暂时移除 e2e script，二选一，不允许配置指向不存在的目录。

**next.config.ts（可选加固）**：开启 `typedRoutes: true`，链接错路由变成类型错误（Next 16 下 Turbopack 已稳定支持）。

**tsconfig**：保持单一 `@/*` 别名，不引入每层别名——路径规则交给 depcruise，别名越少心智越简单。

### 4.7 `.trellis/spec` 同步固化（知识层）

自动化是硬约束，spec 是「为什么」的载体，两者必须同步修改：

1. **新增 `.trellis/spec/frontend/architecture.md`**：3.1 分层图、3.4 白名单及理由、契约层准入标准、「修改架构规则的流程」（改 depcruise 配置 → 跑 arch:baseline → 同步本文件 → PR 说明）。
2. **改 `implementation.md` 的「目录边界」节**：替换为指向 architecture.md 的链接 + feature 内部模板（3.3）+「单文件 ≤ 800 行，触碰 ratchet 清单文件时必须拆出本次相关部分」。
3. **改 `guides/frontend-preflight-guide.md`**：preflight 增加「跑 `npm run arch:check`；若你的改动需要新增跨层依赖，先读 architecture.md 判断是改设计还是改规则」。
4. **`index.md` 路由表**增加 architecture.md 条目。
5. **AGENTS.md**（进版本库）追加一行：「架构边界由 `.dependency-cruiser.cjs` 与 `tests/arch/` 强制，修改规则前读 `.trellis/spec/frontend/architecture.md`」——保证不读 .trellis 的协作者/AI 也能从仓库内文件发现规则。

---

## 5. 迁移路线图

原则：每个 Phase 一个 Trellis 任务、一个 PR、独立可合入可回滚（`git revert` 单 PR 即回滚）；每个 Phase 结束 `npm run ci:check` 全绿且基线文件只缩不涨。

### Phase 0 — 钉子安装与现状冻结（~0.5 天，纯增量，不动业务代码）

1. 删除死目录：`src/features/history/`、`src/app/brief-rich-preview/`、`src/app/markdown-image-parser-preview/`（均为空目录，本地 `rmdir` 即可）。
2. 仓库卫生：处理 `src.zip`；`git ls-files tmp output downloads` 确认归属，不入库则加 `.gitignore`。
3. 安装 `dependency-cruiser`、`server-only`；`src/server/*.ts` 首行加毒丸。
4. 落地 `.dependency-cruiser.cjs`（4.1）、`tests/arch/**`（4.3/4.4）、`tests/stubs/server-only.ts`、vitest/biome/package.json 变更（4.5/4.6）。
5. `npm run arch:baseline` 生成基线（预期内容 = 附录 A）。
6. 补建 `tests/e2e/` smoke 或调整 playwright 配置。
7. spec 固化（4.7）。

**验收**：`ci:check` 全绿；故意在任意客户端组件 import `@/server/backend-api` 能令构建与 arch:check 双重失败（毒丸自检）。

### Phase 1 — 契约下沉（~0.5–1 天）

1. 建 `src/shared/contracts/auth.ts`：迁入 cookie 名常量、`ProducerAuthUser`、登录请求/响应类型与纯解析函数、`sanitizeProducerAuthNextPath`。
2. 改 `app/api/auth/**`、`proxy.ts`、`app/login/page.tsx`、`features/auth/**` 的 import 指向 contracts；`features/auth` 保留 UI 组件与客户端 api 调用，并从 barrel re-export 契约类型以兼容站内调用。
3. 重新生成基线：`bff-no-client-features` 相关条目应清零；`COOKIE_LITERAL_ALLOWLIST` 收紧为 contracts 单文件。

**验收**：`grep -rn "@/features" src/app/api src/proxy.ts` 为空；auth 相关单测（form-urlencoded 转换、cookie 属性、安全 next 等，见 state-management.md）全绿。

### Phase 2 — 解环：agent-flow 并入 chat（~1 天）

1. `git mv src/features/agent-flow src/features/chat/agent-tools`（components 一并迁移）。
2. 删除原 agent-flow/index.ts 对 chat 的 re-export；chat/index.ts 统一导出 agent-tools 公共符号。
3. 更新站内 import（chat 内 3 处、外部引用若干）；同步迁移 `tests/unit` 对应测试文件。
4. 重新生成基线：`no-circular` 与 chat/agent-flow 相关白名单条目清零。

**验收**：`arch:check` 中循环类违规为 0；chat 相关单测全绿。

### Phase 3 — barrel 收口 + env 集中（~1 天）

1. 修复附录 A 列出的 10 处深层导入：能走 barrel 的改 barrel（feature index.ts 按需补导出）；`@/features/projects/project-session.constants` 这类被 app 直接使用的常量评估是否属于契约 → 下沉 contracts。
2. 落地 `src/server/env.ts`、`src/shared/env.client.ts`，三处存量 `process.env` 改走入口；`ENV_ACCESS_ALLOWLIST` 收紧为两个入口文件。
3. 重新生成基线：`feature-public-api-only` 与 `cross-feature-via-barrel-only` 条目清零。**基线文件此时应为空 → 删除基线文件与 `--ignore-known` 参数。**

**验收**：`arch:check`（无 ignore-known）直接全绿；dev/build 启动时缺 env 立即报错。

### Phase 4 — 渐进项（随日常迭代，不设截止）

1. **测试镜像化**：`tests/unit` 平铺文件按被测模块路径 `git mv`（如 `project-chat.utils.spec.ts → tests/unit/features/chat/`）。可一次脚本迁完，也可改哪个迁哪个；新测试必须按镜像路径放（写进 spec）。
2. **巨文件清账**：遵守 ratchet——每次触碰 `LEGACY_LINE_BUDGET` 中的文件，至少拆出与本次改动相关的部分并下调预算值；拆完删条目。优先级：project-assistant-messages.ts（纯逻辑易拆）→ project-canvas-store.tsx（按 slice 拆）→ 两个巨型组件（按子卡片/区块拆）。
3. **feature 内部归位**：按 3.3 模板，改哪个文件归位哪个（`git mv` 保留历史）。
4. （可选）`typedRoutes`、coverage 阈值、`arch:graph`（graphviz 依赖图 SVG 供 review 用）。

---

## 6. 验收标准（方案完成的定义）

- [ ] `npm run ci:check` 包含 arch 校验且全绿（lint + typecheck + arch:check + test:unit）。
- [ ] `.dependency-cruiser-known-violations.json` 已删除（基线清零）。
- [ ] 依赖图为 DAG：feature 白名单 = `chat→[artifacts,projects]`、`project-canvas→[artifacts,projects,chat]`，其余为空。
- [ ] `src/app/api/**` 与 `proxy.ts` 对 `src/features/**` 零依赖。
- [ ] `src/server/**` 全部带 `server-only` 毒丸（depcruise required 规则在岗）。
- [ ] feature 外部 import 100% 经 `index.ts`。
- [ ] `process.env` 仅存在于 `src/server/env.ts` 与 `src/shared/env.client.ts`。
- [ ] `tests/arch/` 两个契约测试在岗且豁免清单仅剩 ratchet 行数表。
- [ ] `.trellis/spec/frontend/architecture.md` 建立，implementation/preflight/index 同步更新，AGENTS.md 提及强制机制。
- [ ] Biome 覆盖 `tests/**`；playwright 配置与目录一致。

---

## 7. 附录 A：现存违规清单（= Phase 0 基线的预期内容）

### A.1 循环依赖（P1，Phase 2 清零）

```
chat → agent-flow：
  features/chat/components/sidebar/ProjectInlineAskPanel.tsx → agent-flow/components/tools/AskUserQuestionPanel（且为深层导入）
  features/chat/components/sidebar/ProjectConversationPanel.tsx → agent-flow
  features/chat/project-assistant-messages.ts → agent-flow
agent-flow → chat：
  features/agent-flow/index.ts（re-export chat 类型）
  features/agent-flow/project-ask-user-question.utils.ts
  features/agent-flow/project-tool-log.ts
  features/agent-flow/components/tools/AskUserQuestionPanel.tsx
```

### A.2 BFF/proxy 依赖客户端 feature（P4，Phase 1 清零）

```
app/api/auth/_shared.ts        → features/auth/producer-auth.constants、producer-auth.types
app/api/auth/ws-ticket/route.ts → features/auth/producer-auth.constants
proxy.ts                        → features/auth/producer-auth.constants
```

### A.3 绕过 barrel 的深层导入（P3，Phase 3 清零）

```
app/(home)/_components/HomeHero.tsx                  → chat/project-pending-draft
app/projects/[id]/_components/ProjectRoute.tsx       → chat/agentos-runs
app/projects/[id]/_components/CanvasVideoWorkspace.tsx → project-canvas/components/nodes/project-canvas-node.types
app/projects/[id]/_components/ProjectDesktopShell.tsx  → project-canvas/components/nodes/{StoryboardWorkbenchCanvasNode, project-canvas-node.types}
app/projects/[id]/_components/ProjectSessionTabs.tsx   → projects/project-session.constants
app/login/page.tsx                                   → auth/producer-auth-navigation
（另：A.1 中 chat → agent-flow/components/... 一处跨 feature 深层导入）
```

### A.4 process.env 散点（P9，Phase 3 收口）

```
app/api/auth/_shared.ts
features/projects/producer-generation-events.ts   （NEXT_PUBLIC_PRODUCER_BACKEND_WS_URL）
server/backend-api.ts
```

### A.5 巨型文件 ratchet 初始预算（P5，Phase 4 渐进）

见 4.4 节 `LEGACY_LINE_BUDGET`（7 个文件，2169～822 行）。

---

## 8. 附录 B：关键决策记录

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 用 dependency-cruiser 做依赖规则 | eslint-plugin-boundaries / Biome 规则 | 项目无 ESLint（Biome 体系），为边界规则引入整套 ESLint 过重；Biome 2.4 尚无成熟的路径级边界/分层规则。depcruise 独立于 linter、支持循环检测、required 规则、基线冻结与 `$1` 组匹配，正好覆盖全部需求 |
| arch 测试用 execSync 调 CLI | dependency-cruiser JS API | 与 CI 命令字面一致，零行为偏差；202 文件规模下性能无虞 |
| agent-flow 并入 chat | 共享类型下沉 contracts 保持独立 | 双向纠缠 7 处 + barrel re-export 对方类型，说明域边界本来就不存在；合并是承认现实，成本最低 |
| 测试保持 `tests/` 独立目录（镜像 src） | 测试与源码同目录（colocation） | 沿用现有约定，避免 70 文件大迁移叠加 Biome includes、vitest include、Next 构建排除等连锁配置改动；镜像路径已解决「找不到测试」的核心痛点 |
| 基线冻结而非一次性修完 | 大爆炸式重构 | 第 0 天即获得「新增违规即失败」能力；清账压力分散到 4 个独立 PR，每步可回滚 |
| 保留 Next.js BFF 形态 | 迁移 Vite 纯 SPA | 见前期讨论：HttpOnly Cookie 认证、SSE 流式代理、服务端路由保护是真实服务端职责；Turbopack 已覆盖 Vite 的 DX 优势 |
