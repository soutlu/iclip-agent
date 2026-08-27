import js from '@eslint/js'
import pluginQuery from '@tanstack/eslint-plugin-query'
import configPrettier from 'eslint-config-prettier'
import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'public',
      'src/routeTree.gen.ts',
      'node_modules',
      // docs/ 里有脱离本项目 tsconfig 的示例代码，类型感知规则跑不动
      'docs',
    ],
  },

  // ── TypeScript / React 基础规则（类型感知） ──────────────────────────────
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...pluginQuery.configs['flat/recommended'],
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler 尚未启用，以下编译器诊断命中的是存量 ref 镜像/effect 同步模式，
      // 属行为敏感重构，随 React Compiler 接入另行治理（见工具链迁移报告）。
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // disallowTypeAnnotations:false 允许 vi.importActual<typeof import('...')> 的 vitest 官方写法
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false, fixStyle: 'inline-type-imports' },
      ],
      // throw redirect(...) 是 TanStack Router 的路由守卫约定
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'package', name: 'Redirect', package: '@tanstack/router-core' }] },
      ],
      // zod schema、React.lazy 等场景的误报较多，关闭；其余类型安全规则保持
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // ── 架构边界（依赖方向硬约束，违反即报错） ──────────────────────────────
  //
  //   app(app/、routes/、main.tsx) → 可用 feature 公开出口(index.ts)、shared
  //   features/<name>              → 本 feature 内部随意 + shared + 其它 feature 仅经 index.ts
  //   shared                       → 只能用 shared
  //   testing(src/testing)         → 测试基建；业务代码（app/feature/shared）不得 import，
  //                                  只有测试文件可用（测试文件整体豁免 boundaries，见下方测试块）
  //
  //   跨 feature 依赖是允许的，但只准走对方的 index.ts 公开出口；深层 import 一律禁止。
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      // v7 元素描述符只有目录语义（v6 的 mode: 'full' 已弃用）：app/、routes/ 直接按
      // 目录归类；兜底的 'src' 让 main.tsx、routeTree.gen.ts 等 src 根部散文件也归入
      // app 元素（feature/shared/testing 在更深路径命中，优先级不受兜底影响）。
      'boundaries/elements': [
        { type: 'feature', pattern: 'src/features/*', capture: ['featureName'] },
        { type: 'shared', pattern: 'src/shared' },
        { type: 'testing', pattern: 'src/testing' },
        { type: 'app', pattern: ['src/app', 'src/routes', 'src'] },
      ],
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            '依赖方向违规：请遵守 CLAUDE.md 的架构规则（feature 对外只经 index.ts、跨 feature 仅可用对方公开出口、shared 不依赖业务层）',
          policies: [
            {
              from: { element: { type: 'app' } },
              allow: {
                to: [
                  { element: { type: 'app' } },
                  { element: { type: 'shared' } },
                  { element: { type: 'feature', fileInternalPath: 'index.ts' } },
                ],
              },
            },
            {
              from: { element: { type: 'feature' } },
              allow: {
                to: [
                  { element: { type: 'shared' } },
                  {
                    element: {
                      type: 'feature',
                      captured: { featureName: '{{ from.element.captured.featureName }}' },
                    },
                  },
                  { element: { type: 'feature', fileInternalPath: 'index.ts' } },
                ],
              },
            },
            {
              from: { element: { type: 'shared' } },
              allow: { to: { element: { type: 'shared' } } },
            },
          ],
        },
      ],
    },
  },

  // ── 测试文件与测试基建豁免边界规则，并提供 node 环境 ─────────────────────
  //    测试跨 feature 深入任何模块 import 都是合法的（含 src/testing 基建本身）；
  //    业务代码 import src/testing 仍会被上方 boundaries 默认 disallow 拦截。
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/testing/**/*'],
    plugins: { boundaries },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'boundaries/dependencies': 'off',
      // fetch/adapter mock 习惯写成 async () => value 以保持 Promise 返回类型
      '@typescript-eslint/require-await': 'off',
      // 对 vi.fn/mock 上的方法引用断言（toHaveBeenCalled 等）会误报 unbound-method
      '@typescript-eslint/unbound-method': 'off',
      // 测试用 mock 组件通过模块级变量向断言回传状态，不适用组件纯度检查
      'react-hooks/globals': 'off',
    },
  },

  // ── 组件与 hooks/工具混合导出的存量文件：HMR 退化为整页刷新，可接受 ────────
  //    store/provider 文件按约定同时导出 Provider 组件与 hooks；其余为逐文件豁免。
  {
    files: [
      'src/**/state/**/*',
      // ProjectConversationPanel 拆分出的会话时间线子模块：按域内聚组件与判定/转换工具
      'src/features/chat/components/sidebar/ProjectAgentIdentity.tsx',
      'src/features/chat/components/sidebar/ProjectAskUserQuestionTimelineCard.tsx',
      'src/features/chat/components/sidebar/ProjectMessageMarkdown.tsx',
      'src/features/chat/components/sidebar/ProjectSubagentFlowCards.tsx',
      'src/features/chat/components/sidebar/ProjectToolRunLog.tsx',
      'src/features/project-canvas/components/nodes/video-generation-status-ui.tsx',
      'src/shared/composer/VideoGenerationSettingsControl.tsx',
      'src/shared/markdown/components/RichMarkdownCodeBlock.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // ── 路由文件按 TanStack 约定导出 Route 常量，HMR 由 router 插件接管 ─────
  {
    files: ['src/routes/**/*'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // ── Node 环境文件（构建配置与 Playwright e2e） ──────────────────────────
  {
    files: ['e2e/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },

  configPrettier,
)
