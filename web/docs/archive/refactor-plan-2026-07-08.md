# Producer 代码整理计划

> **状态：已完成（2026-07-08），本文归档留档。**
> 长期约定沉淀：分层/边界/命令 → `AGENTS.md`；cn/cva/组件规范 → `docs/frontend-implementation.md`；
> apiFetch(path, schema) zod 边界 → `AGENTS.md` §5 硬红线。遗留事项见执行记录"收尾"行。

**制定时间**：2026-07-08  
**参考标准**：`/Volumes/workspace/code/idesign/idesign_forent`  
**起始基线**：master @ 446763e（Vite 迁移已完成，工作区干净）

## 执行记录（2026-07-08）

| 阶段 | 提交 | 摘要 |
|------|------|------|
| P0 | `1c90a7b` | 85 个 'use client' 清除；Next.js 空目录群 + history/session-state/theme 空目录删除；tmp/output/downloads 清理；README 重写 |
| P1 | `4dcdb8b` | cn(clsx+tailwind-merge) 收口 82 处 className 拼接；guards.ts 收口 isRecord×23 等 30 处重复守卫；datetime.ts 收口；opaque-id 改 crypto.randomUUID（保留非安全上下文兜底）；装入 cva/lucide。RouteBootShell 骨架屏保留模板拼接（rounded-* twMerge 冲突，有意豁免） |
| P2 | `4d3828b` | 弹层体系迁 Radix（统一包 radix-ui）：PopupContent API 不变内部改 Popover 虚拟锚点；两个预览对话框迁 Dialog；PopupRoot/useDismissableLayer 删除；散装 @radix-ui/* 清零。⚠️ 待人工视觉 QA（清单见代理报告） |
| P3 | `022bce9` | agent-flow 并入 chat（唯一 feature 环消除）；4 个 feature 补 index.ts；跨 feature/routes 深层 import 34→1（HomeHero 豁免：走 chat barrel 会把 1.2MB 依赖链提进首页 chunk）；export * 清零。⚠️ 登录 UI 暂随 eager auth chunk（+18KB gzip），P4 下沉 shared/auth 后恢复 |
| P4 | `aa15dd6` | 49 个 git mv：api/ 命名统一（data/ 与平铺→api/）；artifacts→lib/+types/；chat→api/+runtime/+lib/+state/；**auth 基建（session/guards/permissions/api/navigation）下沉 shared/auth**——eager auth chunk 190→49KB，登录 UI 142KB 恢复懒加载（发现 login.tsx beforeLoad 经 barrel 拖回 eager 的机制，navigation 一并下沉解决） |
| P6a | `896105a` + `6d715df` | 工具链切换，拆两个提交：`896105a` 纯 Prettier 重排版 229 文件（已登记 .git-blame-ignore-revs）；`6d715df` npm→pnpm（含 5 个幽灵依赖补声明：rxjs/@tiptap/core/unified/@types/mdast/assistant-stream，CI 切 pnpm/node22）、biome→ESLint flat（typeChecked + **boundaries 架构守卫生效 0 违规**，源码 eslint-disable 仅 HomeHero 1 处）、husky+lint-staged、tsconfig 四项收紧全开（30 错全修，noUncheckedIndexedAccess 保留）。附带修复 ~30 处 lint 暴露的真实问题与 12 个存量 tsc 错误。boundaries 插件锁 v6（v7 配置模式与 idesign 模板不兼容）。**后续已解除**：两仓库同步迁 v7 原生配置（policies/实体选择器/src 兜底目录模式），见 Producer 与 idesign_forent 的后续提交 |
| P6b | `b7204d2` | 67 个单测 git mv 至源码旁 co-located（\*.spec→\*.test），tests/ 删除；src/testing/（setup 刻意留空 + renderWithProviders + MSW 骨架不接线）；e2e/smoke.spec.ts 3 条冒烟（1 条后端无关始终跑，2 条经 E2E_USER/E2E_PASSWORD 门控）；boundaries 增 testing 元素；verify 门禁补 test:e2e。⚠️ e2e 未实际运行（按用户要求跳过 Playwright 验证） |
| P6c | `55db961` | AGENTS.md 重写为控制面（命令/分层/硬红线/文档路由，Trellis 内容随 .trellis 删除移除）；docs/ 出 .gitignore 入库（adr/、design-system、frontend-implementation、state-management、backend_api、本计划、archive/） |
| P5 | `d9d9afc`…`51b9d92`（10 个提交，每文件一提交） | 10 个超大文件全部拆到 ≤800 行：StoryboardWorkbenchCanvasNode 2258→7 文件（入口 237）；project-assistant-messages 1863→4 域模块；ProjectConversationPanel 1631→6 文件；project-canvas-store 1608→4 文件；VideoPromptCanvasCard 1440→3 文件；ProjectChatProvider 1372→4 文件（动作簇抽 hook，依赖参数注入，唯一非纯移动差异是补齐 exhaustive-deps 的稳定引用）；AnalyticsRoute 1370→4 文件；producer-project.api 908→3 资源域；project-state.adapters 862→3 文件；masonry 布局 813→几何模块独立。**globals.css 3726→27 行纯 @import 编排器**（17 个按域文件，import 顺序与原段落一致；22 个哈希类名→sw-* 语义名）。验证：每步 ci:check 全绿（479 用例）；CSS 构建产物与拆分前基线重命名归一化后**逐字节一致**。验收：`src` 下无 >800 行**非测试**文件 ✅（修正口径 2026-07-08：7 个 co-located 测试文件超 800 行、最大 project-chat-provider.test.tsx 3034 行，参考标准 B4 的 800 行上限按生产码执行）、globals<500 ✅、无哈希类名 ✅（验收 grep 模式会误匹配 @import 路径单词，实际哈希模式已清零） |

| 收尾 | `0e7852f` + 文档提交 | 附录 A 遗留三项清算：① **apiFetch 升级 `apiFetch(path, schema)` zod 校验版**（对齐 idesign），projects/generation/analytics/presign/admin/auth/AgentOS runs/AG-UI facts+restore 全部收口，producer-project-http.ts 删除，通用 schema 原语进 `shared/api/schemas.ts`；裸 fetch 仅剩三类合法豁免（AG-UI SSE run、OSS 预签名 PUT、外链素材下载，已在 client.ts 头注释注明）。② **WS 重连统一收口改判不做**：审计时的"×4 分散"经 P4/P5 已塌缩——socket 重连仅剩 producer-generation-events 一处，project-agui-reconnect 实为 35 行一次性 run 恢复意图存储（协议级 resume 游标，非 socket 重连），为单一消费方建 shared 原语违反附录 C；AG-UI 侧 RUN_ACTIVE_ELSEWHERE 退避在并行工作流中演进，不并入。③ **cva 存量迁移改判不做**：全仓无变体组件体系（仅 4 处普通条件类），cva 保留供新组件使用，约定已写入 frontend-implementation.md。P5 验收口径同步修正（见上行）。 |

**顺序调整（2026-07-08）**：P6（工程化）提前到 P5（大文件拆分）之前执行。理由：① ESLint boundaries 尽早锁死 P3/P4 的边界成果；② P5 拆出的新文件直接在最终 lint/format 规则下产生，避免二次修整；③ 原顺序的依据（boundaries 需要最终目录结构）在 P4 完成时已满足——P5 只在 feature 内部拆文件，不影响层级结构。

---

## 审计结论摘要

### 规模与问题密度
- **总规模**：src/ 196 文件，~43,107 行
  - features: 32,549 行（11 个 feature，1 个空）
  - shared: 6,380 行
  - app: 3,765 行（几乎全是 globals.css）
  - routes: 201 行（8 个文件，薄胶水层，✅ 合规）

- **超大文件**：35 个 >300 行，其中 9 个 >800 行（参考标准 B4 上限）
  - StoryboardWorkbenchCanvasNode.tsx: 2,182 行
  - project-assistant-messages.ts: 1,810 行
  - project-canvas-store.tsx: 1,571 行
  - ProjectConversationPanel.tsx: 1,525 行
  - globals.css: 3,708 行（467 个手写 class + 13 keyframes）

### 三大核心问题

**1. 自造轮子严重**
- className 合并：23 处手写 `[...].filter(Boolean).join(' ')`（无 clsx/tailwind-merge）
- 图标：HippoIcon 手写 iconfont 240 行 + 60 处内联 SVG（无 lucide-react）
- UI 组件：手写 popup/dialog/sheet 弹层体系（shared/ui/popup/），Radix 仅 2 处使用
- 重复校验器：`isRecord` 在 22 个文件重复、`nonEmptyString` ×4、`errorFromUnknown` ×3
- WebSocket 重连：4 处分散实现，无统一抽象
- 其它：手写 UUID（可换 crypto.randomUUID()）、formatDateTime ×2、手写受控表单（无 react-hook-form）

**2. 架构边界失效**
- **242 处跨 feature 深层 import**（绕过对方 index.ts）
  - artifacts 被深挖 56 次、chat 48 次、project-canvas 43 次
- **一半 feature 无 index.ts**（admin-users/analytics/home/project-workspace/history）
- **3 处 barrel 反模式**（`export *` 全量转发）
- **shared 混入业务**：shared/composer 含 VideoGenerationSettingsControl（634 行）+ composer-attachment（770 行），明显是领域代码
- feature 内部结构不一致：api 层有的叫 `data/`、有的平铺 `.api.ts`

**3. 迁移残留**
- **85 个文件**顶部仍有 `'use client'` 指令（Vite SPA 不需要）
- **src/app 下 Next.js 空目录群**：`api/agui`、`api/chat`、`api/projects`、`(home)/_data` 等完全空目录
- **3 个业务空目录**：features/history（整个 feature 空）、chat/session-state、shared/theme
- **README.md 完全过时**：仍称"基于 Next.js App Router"，描述的文件结构与当前不符
- **tests/e2e 配置了但目录不存在**，无 MSW

---

## 整理策略与分阶段计划

### 总体原则

1. **可逆优先**：清理 > 引入工具 > 重组目录 > 拆分大文件
2. **工程化优先**：先安装成熟包替换自造轮子，再做业务层重组
3. **渐进验证**：每阶段结束后运行 `npm run ci:check`（lint + typecheck + test:unit）
4. **保持可运行**：整理过程中代码始终可构建、可测试

### 依赖关系
```
Phase 0 (清理迁移残留，零风险)
  ↓
Phase 1 (引入工具包，替换自造轮子)
  ↓
Phase 2 (统一 shared 层，下沉工具函数)
  ↓
Phase 3 (feature 边界规范化：补 index.ts、拆解 barrel、清理深层 import)
  ↓
Phase 4 (feature 内部结构标准化)
  ↓
Phase 5 (拆分超大文件，降至 800 行以下)
  ↓
Phase 6 (配置对齐：eslint-plugin-boundaries、测试基础设施、门禁增强)
```

---

## Phase 0：清理迁移残留（零风险，纯删除）

**目标**：删除所有无用文件/目录/标记，让代码库反映真实现状。

### 0.1 删除空目录
```bash
# Next.js 遗留空目录
rm -rf src/app/api
rm -rf src/app/\(home\)
rm -rf src/app/projects
rm -rf src/app/brief-rich-preview
rm -rf src/app/markdown-image-parser-preview

# 业务空目录
rm -rf src/features/history
rm -rf src/features/chat/session-state
rm -rf src/shared/theme
```

### 0.2 批量删除 'use client' 指令
85 个文件需处理，用脚本或手动逐个删除文件顶部的 `'use client'` 行。

**核心受影响文件**（示例）：
- src/features/projects/producer-generation-events.ts
- src/shared/ui/popup/*.tsx（PopupRoot/PopupContent/PopupAnchor 等）
- src/shared/hooks/*.ts
- 所有 feature 的大部分组件

**脚本方案**（推荐）：
```bash
# 先备份
git stash

# 批量删除（谨慎执行，建议先在副本上测试）
find src -name "*.ts" -o -name "*.tsx" | xargs sed -i '' "/^'use client'$/d"

# 验证
npm run ci:check
```

### 0.3 清理杂物目录
```bash
# 根部杂物（已在 .gitignore，但污染工作区）
rm -rf tmp/  # 62 个 PNG 截图
rm -rf output/  # 预览图与子目录
rm -rf downloads/  # 无关视频
```

### 0.4 更新文档
- **README.md**：删除所有 Next.js/BFF 描述，改写为 Vite SPA 架构（参考 idesign_forent 的 README 结构）
- **docs/architecture-refactor-plan.md**：标注为"已过时"或删除（当前计划取代它）

**验收标准**：
- ✅ `find src -type d -empty` 返回空
- ✅ `rg "'use client'" src` 返回空
- ✅ README 不再提及 Next.js
- ✅ `npm run ci:check` 通过

---

## Phase 1：引入成熟工具包，替换自造轮子

**目标**：用 npm 生态标准方案替换手写实现，提升代码质量与可维护性。

### 1.1 安装依赖
```bash
npm install clsx tailwind-merge class-variance-authority
npm install lucide-react
npm install sonner  # toast 通知（如需）
npm install @radix-ui/react-* # 按需补全（dialog/dropdown-menu/popover 等）
```

### 1.2 创建 cn 工具（@/shared/lib/utils.ts）
```typescript
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### 1.3 替换 className 合并（23 处）
全局搜索 `.filter(Boolean).join(' ')`，逐个替换为 `cn(...)`。

**示例**（ComposerShell.tsx:22）：
```diff
- const mergedClassName = ['composer-shell', 'glass-panel', 'relative', className]
-   .filter(Boolean).join(' ')
+ const mergedClassName = cn('composer-shell', 'glass-panel', 'relative', className)
```

### 1.4 替换图标系统
**选项 A（激进）**：完全迁移到 lucide-react
- 逐个对照 HippoIcon 的 40 个图标名找 lucide 对应图标
- 替换 `<HippoIcon name="xxx" />` 为 `<XxxIcon />`
- 删除 shared/ui/icons/HippoIcon.tsx（240 行）
- 删除 storyboard-workbench-icons.tsx（427 行）

**选项 B（保守）**：保留 HippoIcon，仅新代码用 lucide
- 新组件统一用 lucide-react
- 旧代码暂不动，标记 `// TODO: migrate to lucide`

**推荐选项 B**，等全局重组完成后再统一图标迁移（作为独立 Phase 7）。

### 1.5 UUID 生成器替换
```diff
// shared/lib/opaque-id.ts
- export function generateOpaqueId(): string {
-   const bytes = new Uint8Array(16)
-   crypto.getRandomValues(bytes)
-   // ... 58 行手写逻辑
- }
+ export function generateOpaqueId(): string {
+   return crypto.randomUUID()
+ }
```

### 1.6 合并重复的运行时校验器（@/shared/lib/guards.ts）
创建统一的类型守卫文件，把 22 处 `isRecord` 合并为一处：

```typescript
// src/shared/lib/guards.ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function errorFromUnknown(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

export function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}
```

然后全局替换 22 个文件的本地定义为 `import { isRecord } from '@/shared/lib/guards'`。

**验收标准**：
- ✅ `rg 'filter\(Boolean\).join'` 返回空
- ✅ `rg 'const isRecord' src/features` 返回空（只在 shared/lib/guards.ts 有）
- ✅ shared/lib/opaque-id.ts 改用 crypto.randomUUID()
- ✅ `npm run ci:check` 通过

## Phase 2：统一 shared 层，清理业务污染

**目标**：让 shared 只包含纯粹的横切关注点，业务领域代码移出。

### 2.1 识别业务代码（~~需下沉到 features~~ 已修正，2026-07-08）

**执行时的消费方核查推翻了原假设**：`VideoGenerationSettingsControl`、`composer-media-stack.utils`、`ComposerMentionPopup` 均被 **3 个 feature**（chat/home/project-workspace）消费，`composer-attachment.utils` 被 chat 的多个文件消费。这些是真正的跨 feature 共享能力——搬进任何单一 feature 都会制造新的跨 feature 深层依赖，比留在 shared 更糟。

**修正后的决策**：`shared/composer` **留在 shared**。这与 idesign_forent 自身实践一致（其 shared/api 下也有 materials/pdm 等领域 client，原则是"跨 feature 共享的能力下沉 shared"）。同理 `shared/ui/media`（被 5 个 feature 消费）也保留。P2 的实际工作转为 2.3 的弹层体系 Radix 化。

### 2.2 shared 目标结构（参考 idesign_forent）
```
shared/
├── api/           # API client、query-client、pagination
├── auth/          # session、guards（当前在 features/auth，需评估是否下沉）
├── config/        # env.ts 唯一环境变量入口
├── lib/           # utils(cn)、guards、datetime、opaque-id
├── ui/            # 纯 UI 组件（无业务逻辑）
└── markdown/      # RichMarkdownRenderer（通用渲染器，保留）
```

### 2.3 弹层体系 Radix 化（修正后 P2 的实际主体工作）
- 安装统一包 `radix-ui`（对齐 idesign_forent，非散装 @radix-ui/react-*）
- `PopupContent` 保持对外 API 不变（anchorRect/align/open/onDismiss），内部重建为 Popover 原语（虚拟锚点 + onOpenAutoFocus preventDefault 保持不抢焦点）；获得碰撞翻转、滚动跟随、a11y
- MediaPreviewDialog / MarkdownCanvasPreviewDialog 迁 Radix Dialog；ZoomMenu 走重建后的 PopupContent
- PopupRoot / useDismissableLayer 无消费方后删除
- StoryboardWorkbenchCanvasNode 的散装 @radix-ui/react-aspect-ratio、react-slider 统一为 radix-ui 导入并卸载散装包
- BottomSheet 先评估：含真手势逻辑则保留
- MediaPreviewDialog 留在 shared/ui/media（被 5 个 feature 消费，见 2.1 修正）

**验收标准（修正后）**：
- ✅ src/shared/ui/popup 手写定位/dismiss 逻辑被 Radix 原语替代
- ✅ 散装 @radix-ui/* 依赖清零，统一 `radix-ui`
- ✅ 相关组件 spec + `npm run ci:check` + `npm run build` 通过
- ⚠️ 弹层/对话框表面需要人工视觉 QA（记录清单）

## Phase 3：feature 边界规范化

**目标**：建立清晰的 feature 公共 API 边界，消除跨 feature 深层 import。

### 3.1 为所有 feature 创建 index.ts（4 个缺失）
- `features/admin-users/index.ts`
- `features/analytics/index.ts`
- `features/home/index.ts`
- `features/project-workspace/index.ts`

每个 index.ts 只导出：
- 页面组件（供 routes/ 引用）
- 公共 hooks/types（供其它 feature 引用）
- **禁止导出内部实现细节**（如 `*-node.types.ts`、内部 utils）

### 3.2 消除 barrel 反模式（3 处 `export *`）
- `agent-flow/index.ts`：改为具名导出（`export { ProjectToolLog, ... }`）
- `chat/index.ts`：拆解 `export * from './project-*'`
- `shared/composer/index.ts`：删除（整个目录将移走）

### 3.3 修复 242 处跨 feature 深层 import（分批进行）

**步骤**：
1. 统计当前跨 feature import（`rg "from '@/features/\w+/(?!index)" src/features`）
2. 按被深挖次数排序：artifacts(56) > chat(48) > project-canvas(43) > project-workspace(23) > projects(10)
3. 逐个 feature 处理：
   - 评估哪些符号应公开（补到 index.ts）
   - 哪些是实现细节（调用方需重构，不该跨 feature 访问）
   - 哪些应下沉到 shared（如真正的共享类型）

**典型案例**：
```typescript
// ❌ 深层 import
import { StoryboardWorkbenchCanvasNode } from '@/features/project-canvas/components/nodes/StoryboardWorkbenchCanvasNode'

// ✅ 方案 A：经 index（如确实需要公开）
import { StoryboardWorkbenchCanvasNode } from '@/features/project-canvas'

// ✅ 方案 B：合并到同一 feature（如属同一领域）
// 把调用方组件移到 project-canvas 内部
```

**优先级**：先处理高频被访问的 feature（artifacts/chat/project-canvas）。

### 3.4 统一 API 层命名
当前混乱：
- admin-users/analytics 用 `data/*.api.ts`
- projects/auth 用根平铺 `.api.ts`

**统一为**：每个 feature 内创建 `api/` 子目录，如 `features/projects/api/producer-project.api.ts`。

**验收标准**：
- ✅ 每个 feature 都有 index.ts（11 个，除空的 history）
- ✅ `rg "export \*" src/features src/shared` 返回空
- ✅ 跨 feature 深层 import 降至 <50 处（最终目标 0，但可分阶段）
- ✅ `npm run ci:check` 通过

## Phase 4：feature 内部结构标准化

**目标**：让每个 feature 内部遵循统一模板（参考 idesign_forent）。

### 4.1 标准 feature 结构模板
```
features/<name>/
├── api/              # queryOptions 工厂、mutation hooks、query keys
├── components/       # 页面与 UI 组件（带 co-located .test.tsx）
├── hooks/            # 自定义 hooks（可选）
├── lib/              # 纯函数工具（可选）
├── state/            # zustand store（可选）
├── types.ts          # zod schema + 推导类型
└── index.ts          # 唯一公共出口
```

### 4.2 逐个 feature 重组（示例：projects）
**当前**：
```
features/projects/
├── producer-generation-events.ts (341 行，WS 逻辑)
├── producer-project.api.ts (841 行，API + types 混合)
├── producer-project.types.ts
├── producer-project.utils.ts
├── producer-project.constants.ts
└── index.ts
```

**重组后**：
```
features/projects/
├── api/
│   ├── producer-project.api.ts  # API client 逻辑（从 841 行拆出）
│   └── generation-events.ts     # WS hooks（从 producer-generation-events.ts 改名）
├── lib/
│   └── project.utils.ts         # 纯函数（从 producer-project.utils.ts 改名）
├── types.ts                     # 合并 types + constants
└── index.ts
```

### 4.3 处理超大平铺文件（artifacts feature）
artifacts 当前有 18 个根文件（全是 `*.types.ts` / `*.utils.ts`），需归类：
- 8 个 `*-canvas-card.types.ts` → `types.ts`（合并或按领域拆分）
- 8 个 `*-canvas-card.utils.ts` → `lib/` 子目录
- `renderers/` 保持原样（已经是子目录）

**验收标准**：
- ✅ 每个 feature 都有 `api/`、`components/`、`types.ts`、`index.ts`
- ✅ feature 根目录不超过 5 个文件（index/types + 可选的 README/constants）
- ✅ `npm run ci:check` 通过

## Phase 5：拆分超大文件（降至 800 行以下）

**目标**：将 9 个 >800 行的文件降到参考标准 B4 上限（800 行）以下。

### 5.1 优先级列表（按行数）

| 文件 | 当前行数 | 拆分策略 |
|------|---------|---------|
| StoryboardWorkbenchCanvasNode.tsx | 2182 | 按功能区拆分子组件（toolbar/grid/cell） |
| project-assistant-messages.ts | 1810 | 按消息类型拆分 handler（tool/text/error） |
| project-canvas-store.tsx | 1571 | 按职责拆分（state/actions/selectors） |
| ProjectConversationPanel.tsx | 1525 | 拆出 message list/input/header 子组件 |
| VideoPromptCanvasCard.tsx | 1373 | 拆出 preview/controls/settings 子组件 |
| AnalyticsRoute.tsx | 1326 | 拆出 charts/filters/table 为独立组件 |
| ProjectChatProvider.tsx | 1299 | 拆分 context/hooks/runtime 到独立文件 |
| producer-project.api.ts | 841 | 按资源类型拆分（project/session/generation） |
| project-state.adapters.ts | 840 | 按适配器目标拆分文件 |

### 5.2 拆分示例：StoryboardWorkbenchCanvasNode.tsx（2182 → ~300×7）

**拆分方案**：
```
components/nodes/storyboard-workbench/
├── StoryboardWorkbenchCanvasNode.tsx    # 主组件（~200 行，组装）
├── StoryboardToolbar.tsx                # 顶部工具栏
├── StoryboardGrid.tsx                   # 网格容器
├── StoryboardCell.tsx                   # 单个格子
├── StoryboardCellMenu.tsx               # 右键菜单
├── storyboard-workbench.types.ts        # 类型定义
└── storyboard-workbench.utils.ts        # 纯函数工具
```

### 5.3 globals.css 专项处理（3708 行）

**问题**：包含 467 个手写 class + 13 keyframes，其中有从参考项目直接抄来的哈希类名（如 `shotItem-Se_piW`）。

**方案**：
1. 提取 Tailwind @import/@layer 到顶部（保留）
2. 把 467 个自定义 class 按领域分组：
   - 画布相关 → `src/features/project-canvas/canvas.css`
   - 聊天相关 → `src/features/chat/chat.css`
   - markdown 相关 → `src/shared/markdown/markdown.css`
   - 通用动画/工具 → 保留在 globals.css
3. 删除所有哈希类名（如 `shotItem-Se_piW`），替换为语义化命名或 Tailwind 组合
4. 评估是否可用 Tailwind 类替代部分自定义 CSS

**目标**：globals.css 降至 <500 行（只保留主题变量、通用重置、基础动画）。

**验收标准**：
- ✅ 所有文件 ≤800 行
- ✅ globals.css <500 行
- ✅ 无哈希类名（`rg '\w+-[A-Za-z0-9_]{6}' src/app/globals.css` 返回空）
- ✅ `npm run ci:check && npm run build` 通过

## Phase 6：配置对齐与测试基础设施

**目标**：建立架构契约自动化检测，提升测试能力。

### 6.1 引入 eslint-plugin-boundaries（架构硬约束）

**安装**：
```bash
npm install -D eslint-plugin-boundaries
```

**配置**（参考 idesign_forent 的 eslint.config.js）：
```javascript
// eslint.config.js
import boundaries from 'eslint-plugin-boundaries'

export default [
  // ... 其它配置
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'feature', pattern: 'src/features/*', mode: 'folder', capture: ['featureName'] },
        { type: 'shared', pattern: 'src/shared', mode: 'folder' },
        { type: 'app', pattern: ['src/app/**/*', 'src/routes/**/*', 'src/main.tsx'], mode: 'full' },
      ],
    },
    rules: {
      'boundaries/element-types': ['error', {
        default: 'disallow',
        rules: [
          { from: 'app', allow: ['app', 'shared', { type: 'feature', internalPath: 'index.ts' }] },
          { from: 'feature', allow: ['shared', { type: 'feature', captured: { featureName: '{{ from.featureName }}' } }] },
          { from: 'shared', allow: ['shared'] },
        ],
      }],
    },
  },
]
```

**效果**：自动检测并阻止跨 feature 深层 import、shared 依赖 feature、循环依赖。

### 6.2 lint 工具链决策：biome → ESLint + Prettier

**背景**：Producer 当前用 biome；idesign_forent 用 ESLint（flat config）+ Prettier。boundaries 分层约束、`@tanstack/eslint-plugin-query`、类型感知规则（typeChecked）都只有 ESLint 生态有，biome 无法承载参考标准的核心约束。

**决策**：切换到 ESLint + Prettier，完全对齐 idesign_forent：

```bash
npm uninstall @biomejs/biome
npm install -D eslint @eslint/js typescript-eslint globals \
  eslint-plugin-boundaries eslint-import-resolver-typescript \
  eslint-plugin-react-hooks eslint-plugin-react-refresh \
  @tanstack/eslint-plugin-query eslint-config-prettier \
  prettier prettier-plugin-tailwindcss
```

- `eslint.config.js`、`prettier.config.js` 直接从 idesign_forent 复制后按本仓路径微调
- Prettier 规则：单引号、无分号、printWidth 100、tailwind 类名排序（识别 `cn`/`cva`）
- 9 处 `biome-ignore` a11y 豁免注释改写为对应的 `eslint-disable-next-line`（保留中文理由）
- 迁移期先把 boundaries 设为 `warn`，Phase 3 完成后升为 `error`

### 6.3 husky + lint-staged 门禁

```bash
npm install -D husky lint-staged
npx husky init
```

- `.husky/pre-commit`：`npx lint-staged`
- `.husky/pre-push`：`npm run typecheck && npm run test:unit`
- lint-staged：`*.{ts,tsx}` → `eslint --fix` + `prettier --write`；其它 → `prettier --write`
- package.json 增加 `verify` 完整门禁：`format:check && lint && typecheck && test && build && test:e2e`

### 6.4 tsconfig 收紧（对齐 idesign_forent）

在 `tsconfig.app.json` 增加：
```jsonc
{
  "noUncheckedIndexedAccess": true,   // 主要增量，预计暴露一批索引访问问题
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedSideEffectImports": true
}
```

`noUncheckedIndexedAccess` 影响面大，单独一个 commit 处理其暴露的类型错误。

### 6.5 测试基础设施（对齐 idesign_forent 的 src/testing 模式）

**现状**：70 个 spec 集中在 `tests/unit/`（未镜像 src 层级）；`tests/e2e` 配置了但目录不存在；无 MSW。

**改造**：
1. **单测 co-located**：`tests/unit/xxx.spec.ts` 逐步移到被测文件旁改名 `xxx.test.ts(x)`；vitest include 改为 `src/**/*.test.{ts,tsx}`。可按 feature 分批搬，搬完删除 `tests/unit/`
2. **建立 `src/testing/`**：
   - `setup.ts`（jsdom stub：ResizeObserver/IntersectionObserver/scrollIntoView 等）
   - `test-utils.tsx`（`renderWithProviders`：新建 QueryClient(retry:false) 包裹）
3. **MSW 契约镜像**（独立投入，可后置）：
   - `src/testing/mocks/handlers.ts` 镜像 iclip_agent 后端 REST 契约
   - dev/单测/e2e 三场景共用一套 handlers（参考 idesign ADR-0002）
   - 注意：WS（generation events）与 AG-UI 流式端点 MSW 支持有限，先只镜像 REST，WS 用注入 stub
4. **e2e 起步**：建 `e2e/` 目录（对齐 idesign 的目录名，替代不存在的 `tests/e2e`），先写 3 条冒烟用例（登录 → 首页 → 打开项目工作台），webServer 用 `vite build && vite preview` 验证真实构建产物

### 6.6 包管理器：npm → pnpm（可选，建议做）

对齐 idesign_forent：`packageManager: "pnpm@9.x"` + `engines.node >= 22`，删除 package-lock.json 生成 pnpm-lock.yaml。CI/部署脚本（scripts/start-*.sh）同步更新。

### 6.7 AGENTS.md 补写编码约定

当前 AGENTS.md 只有 Trellis 工作流，无任何编码/架构约定。补写（参考 idesign_forent AGENTS.md）：
- 分层依赖方向与 boundaries 约束说明
- feature 竖切 + index.ts 唯一出口
- `apiFetch(path, schema)` zod 边界约定
- queryOptions 工厂 + `xxxKeys` query key 命名
- 环境变量只从 `@/shared/config/env` 读取
- 文件名 kebab-case、组件具名导出、UI 文案中文
- 验证矩阵（每个 surface 绑定命令）

同时把 docs/ 从 .gitignore 移出（至少 ADR 与本计划应入库）。

**验收标准**：
- ✅ `npm run lint` 含 boundaries 检查且为 error 级
- ✅ pre-commit/pre-push 钩子生效
- ✅ 单测全部 co-located，`tests/unit/` 删除
- ✅ e2e 冒烟用例 ≥3 条可跑通
- ✅ `verify` 全链路通过

---

## 附录 A：自造轮子 → 标准方案映射总表

| 自造轮子 | 位置/规模 | 替换方案 | 阶段 |
|---------|----------|---------|------|
| 手拼 className | 23 处 21 文件 | `cn()` = clsx + tailwind-merge | P1 |
| 手写 UUID | opaque-id.ts 58 行 | `crypto.randomUUID()`（平台内置） | P1 |
| `isRecord` 等重复守卫 | 22+4+3+2 处 | 收口 `shared/lib/guards.ts` 单一实现 | P1 |
| formatDateTime ×2 | admin-users / analytics | 收口 `shared/lib/datetime.ts`（Intl，对齐 idesign） | P1 |
| HippoIcon iconfont | 240 行 + 60 处内联 SVG | lucide-react（通用图标）；品牌专属图标保留为 SVG 资产 | P1/P7 |
| 手写弹层体系 | shared/ui/popup + sheet + 各处手搓 dialog/menu | radix-ui + shadcn（dialog/dropdown-menu/popover/sheet/tooltip） | P2 |
| 组件变体三元拼接 | 全仓 | class-variance-authority（cva） | P2 |
| 手写 WS 重连 ×4 | producer-generation-events / project-agui-reconnect 等 | 统一收口 shared/api 单一重连原语（评估 partysocket） | P4 |
| 裸 fetch 绕过 client | 3 处（analytics/file-upload/project.api） | 统一走 `apiFetch(path, schema)`（升级为 zod 校验版，对齐 idesign） | P3 |
| 手写受控表单 | LoginForm 293 行 | 保持手写 + zod 校验（仅 1 个表单，不引 react-hook-form） | — |

注：`apiFetch` 本身**不是**要删的轮子——idesign_forent 同样手写 apiFetch，这是标准模式；要做的是升级为 `apiFetch(path, schema)` zod 边界版并消灭绕过它的裸 fetch。

## 附录 B：关键决策点（已确认，2026-07-08）

1. **biome → ESLint + Prettier**（P6.2）：✅ 切换。boundaries 约束只有 ESLint 有；9 处豁免注释同步改写。
2. **npm → pnpm**（P6.6）：✅ 切换，同步更新 scripts/start-*.sh。
3. **project 域 feature 是否合并**：✅ 先按 Phase 3 逐条治理（补 index.ts 出口、下沉共享类型），治理成本过高时再评估合并为 `features/project/` 大 feature。
4. **文件名 kebab-case**：✅ 只约束新文件（写入 AGENTS.md），存量 PascalCase 文件不批量改名；后续如做 P7 图标迁移可顺带处理。
5. **MSW 投入时机**：✅ P6 只搭 `src/testing/mocks/` 骨架 + 认证/项目列表等核心接口，其余逐接口补齐。

## 附录 C：明确不做的事（防过度工程）

- **不引 react-hook-form**：全仓只有 1 个登录表单，手写 + zod 足够
- **不引 date-fns/dayjs**：只有 2 处格式化，收口到 shared/lib/datetime.ts（idesign 同样手写此文件）
- **不删 markdown 自定义插件**：rehype/remark 插件是合理的领域定制，只做归位与瘦身
- **不动 routes/ 层**：8 个路由文件已合规（薄胶水层）
- **不做一次性大爆炸重写**：每 Phase 独立提交、独立可验证、可随时中断

## 附录 D：风险与前置条件

1. **迁移人工验证未完成**（见 vite-migration 记忆）：账密登录/SSO/WS/SSE/上传的全链路人工验证因本机 Postgres 不可用尚未做。大规模重组前建议先完成一轮人工验证，或至少确认 vitest 464 用例 + build 作为回归基线。
2. **P3（242 处深层 import）是最大工作量**，且涉及"哪些符号该公开"的领域判断，不可全自动化；建议按 feature 分批、每批一个 commit。
3. **globals.css 拆分有视觉回归风险**：建议配合截图对比（Playwright screenshot）验证。
4. **每个 Phase 一个分支/PR**，避免长期分支漂移；P0/P1 可合并为一个 PR。
