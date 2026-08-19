# 前端架构模板套件（Frontend Architecture Kit）

> 适用于任意复杂 TypeScript 前端项目：Next.js（App Router / BFF）、Vite SPA、monorepo 子包。
> 与具体业务、具体 lint 工具、具体 CI 平台解耦。

## 这套模板解决什么

复杂前端项目的腐化路径是固定的：**跨模块随意 import → 循环依赖 → 重构牵一发动全身 → 没人敢动老代码**。本套件提供：

1. 一份**通用分层规范**（依赖方向 + 切片隔离 + 服务端边界）—— `ARCHITECTURE.md`
2. 一套**可执行约束**（违规 = CI 失败，不靠 review 肉眼）—— depcruise 配置 + 架构测试
3. 一组 **CI 模板**（GitHub Actions / GitLab CI，质量契约收敛在 `npm run ci:check`）
4. 一条**存量项目接入路径**（基线冻结：第 0 天防新增，旧账分期清）

核心理念一句话：**规则写进工具，文档只解释为什么**。

## 文件清单

```
frontend-architecture/
├── README.md                        # 本文：采用手册
├── ARCHITECTURE.md                  # 架构规范本体（分层模型、条款 A1–A9/B1–B5、决策树、治理流程）
├── .dependency-cruiser.cjs          # 依赖规则（清单驱动：只改顶部 MANIFEST，规则自动生成）
├── package.scripts.jsonc            # package.json 片段（ci:check 契约 + arch 脚本 + 依赖）
├── vitest.config.template.ts        # vitest 配置（含 tests/arch 与 server-only stub）
├── scripts/
│   └── arch-check.mjs               # 架构校验统一入口（自动适配基线生命周期）
├── tests/
│   ├── arch/
│   │   ├── arch.config.ts           # 架构测试的项目清单（唯一按项目改的测试文件）
│   │   ├── dependency-rules.spec.ts # 依赖图契约（调用与 CI 相同命令）
│   │   └── source-conventions.spec.ts # 源码契约（env 收口、行数 ratchet、协议字面量等）
│   └── stubs/
│       └── server-only.ts           # 测试环境毒丸 stub
└── ci/
    ├── github-actions.yml           # GitHub Actions 模板（check / baseline-ratchet / build / e2e）
    └── gitlab-ci.yml                # GitLab CI 等价模板
```

**两个"项目清单"是仅有的定制点**，其余文件跨项目逐字复用：

| 定制点 | 声明什么 |
| --- | --- |
| `.dependency-cruiser.cjs` 顶部 `MANIFEST` | 启用哪些层、切片白名单、server 旁路、孤儿豁免 |
| `tests/arch/arch.config.ts` | env 入口、服务端目录、行数 ratchet、协议字面量来源 |

## 目标骨架（完整形态）

```
src/
├── app/            # L5 路由层（框架约定文件 + route-local 私有目录）
├── widgets/        # L4 跨 feature 组合区块（可选）
├── features/       # L3 业务能力切片（每切片仅经 index.ts 对外）
├── entities/       # L2 领域内核切片（可选）
├── shared/         # L1 领域无关基础设施（ui/lib/hooks/env.client.ts）
├── contracts/      # L0 跨端契约：零依赖（推荐）
└── server/         # 旁路：服务端域逻辑，每文件首行 import 'server-only'（BFF/全栈）
tests/
├── unit/<镜像 src 路径>/
├── arch/
├── e2e/
└── stubs/
```

依赖方向：**只能向下**（app → widgets → features → entities → shared → contracts）；`server` 旁路只达 contracts 与白名单 shared 纯工具；同层切片互不可见，越界进白名单。完整规则见 `ARCHITECTURE.md` §3。

最小形态（纯 SPA）：`app / features / shared` 三层即可起步，`MANIFEST` 删掉不用的层、`server: null`，规则自动收缩。**不要为还不存在的复杂度预建层。**

## 接入步骤

### A. 新项目（greenfield，~30 分钟）

```bash
# 1) 建骨架（按需删减层）
mkdir -p src/{app,features,shared,contracts,server} \
         tests/{unit,arch,e2e,stubs}

# 2) 复制模板文件到对应路径
#    .dependency-cruiser.cjs           → 项目根
#    tests/arch/*.ts、tests/stubs/*.ts → 对应目录
#    vitest.config.template.ts         → vitest.config.ts（合并已有配置）
#    ci/github-actions.yml             → .github/workflows/ci.yml（或 gitlab-ci.yml → .gitlab-ci.yml）

# 3) 合入 package.scripts.jsonc 的 scripts 与依赖，然后
npm i -D dependency-cruiser && npm i server-only   # 纯 SPA 跳过 server-only

# 4) 按项目填两个清单：MANIFEST（层/白名单/server）+ arch.config.ts（env/字面量）

# 5) 验证
npm run ci:check
```

自检毒丸（BFF 项目）：故意在任一客户端组件 import `@/server/...`，应同时被 `arch:check`（A5/A6）与 `npm run build`（server-only）拦截；删除后恢复绿色。

### B. 存量项目（brownfield，第 0 天即获得防回归）

```bash
# 1–4) 同上；MANIFEST 按现状声明（已存在的层、已存在的跨切片依赖暂不进白名单）

# 5) 冻结旧账：已知违规写入基线文件（进版本库）
npm run arch:baseline

# 6) 验证：旧账不报、新增违规即红
npm run arch:check
```

随后按「**基线只缩不涨**」治理（CI 中 baseline-ratchet job 强制）：

1. 每个清账 PR 修一类违规 → 重跑 `arch:baseline` → 基线 diff 只有删行；
2. 典型清账顺序：**解循环**（合并纠缠切片或下沉共享部分）→ **契约下沉**（服务端入口不再 import 客户端切片）→ **barrel 收口**（深层 import 改走 index）→ **env 收口**；
3. 基线清零后：删除基线文件即可——`arch:check` 统一入口（`scripts/arch-check.mjs`）自动切换为全量校验，命令无需修改。

巨型文件不进基线，走 `arch.config.ts` 的 `lines.legacyBudget`（ratchet）：先把现状行数登记进去，触碰该文件的 PR 至少拆出相关部分并下调预算，拆完删条目。

## 日常工作流

| 场景 | 动作 |
| --- | --- |
| 写新代码不知放哪 | 查 `ARCHITECTURE.md` §4 决策树（30 秒） |
| 需要依赖另一个切片 | 先问"该下沉吗"（§6）；确实要依赖 → 改 `MANIFEST.allowedSliceDeps` 并附理由注释，PR 说明 |
| 提交前 | `npm run ci:check`（与 CI 完全一致） |
| 评审架构类 PR | 只看两个清单的 diff + `npm run arch:graph` 的 SVG |
| 触碰 ratchet 清单中的巨文件 | 拆出本次相关部分，下调 `legacyBudget` 数值 |
| 新增协议字面量（cookie/事件名…） | 常量进 `contracts/`，并在 `arch.config.ts` 的 `protocolLiterals` 登记唯一来源 |

## 防回归机制总览（三层防线）

| 防线 | 载体 | 拦截时机 | 覆盖条款 |
| --- | --- | --- | --- |
| 依赖图规则 | `.dependency-cruiser.cjs`（+基线） | `arch:check`（本地/CI） | A1–A9：方向、循环、切片隔离、白名单、barrel、孤儿、毒丸必涂 |
| 源码契约测试 | `tests/arch/**`（进 `npm test`） | 开发者日常跑测试 | B1–B5：env 收口、'use client' 边界、空目录、行数 ratchet、协议字面量 |
| 构建毒丸 | `server-only` 包 | `next build` / dev | 客户端误引服务端模块 → 编译失败 |
| 基线 ratchet | CI guard job | PR | 旧账只许缩小，禁止把新违规写进基线 |

四层互补：依赖图管「谁 import 谁」，源码测试管「文件里写了什么」，毒丸管「运行时边界」，ratchet 管「债务方向」。任何一条规则若只存在于文档而无对应防线，视为未生效（`ARCHITECTURE.md` §8 元原则）。

## 框架差异速查

| 项 | Next.js（BFF） | Vite / 纯 SPA |
| --- | --- | --- |
| MANIFEST.server | 完整启用（path/entrypoints/allowedShared） | `null`（A5–A7 自动关闭） |
| env 入口 | `server/env.ts` + `shared/env.client.ts`（`NEXT_PUBLIC_*` 字面量内联） | 仅 `shared/env.client.ts`（`import.meta.env`） |
| arch.config.ts serverPaths | server / app/api / middleware(proxy) | `[]` |
| orphanExempt | `^src/app/`（约定文件） | `^src/main\.tsx?$` + 路由约定目录 |
| CI build 产物 | `.next/` | `dist/` |
| monorepo | 层模型映射到 packages；跨包方向由 workspace 依赖图天然强制，包内本模板原样生效 | 同左 |

## FAQ

**Q：barrel（index.ts）不是对 tree-shaking 不友好吗？**
单层 barrel + 三禁（禁 `export *` 全量转发、禁嵌套 barrel、禁层级总 barrel）下，现代打包器处理良好；换来的是切片内部可自由重构。极端性能敏感的入口可以例外，但要在 MANIFEST 注释留痕。

**Q：为什么用 dependency-cruiser 而不是 ESLint boundaries / sheriff？**
不绑定 linter 选型（Biome/ESLint/oxlint 项目都能用）；且循环检测、required 规则（毒丸必涂）、`$1` 捕获组、基线冻结这套组合目前只有它一个工具全覆盖。

**Q：白名单会不会变成垃圾场？**
白名单是**债务登记簿**：每项必须附"为什么不下沉"注释；某切片白名单超过 2 项即触发 §6 的重构信号（它可能是 widget 或藏着 entity）。评审时优先质疑白名单 diff。

**Q：架构测试和 arch:check 不是重复了？**
`tests/arch/dependency-rules.spec.ts` 调用的就是同一条 CLI——目的不是重复，而是让「只跑 `npm test` 的人」也无法绕过架构校验；其余源码契约（B1–B5）则是依赖图表达不了的。
