import eslintReact from '@eslint-react/eslint-plugin'
import js from '@eslint/js'
import pluginQuery from '@tanstack/eslint-plugin-query'
import configPrettier from 'eslint-config-prettier'
import jsxA11y from 'eslint-plugin-jsx-a11y-x'
import boundaries from 'eslint-plugin-boundaries'
import checkFile from 'eslint-plugin-check-file'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const LUCIDE_LOCK = {
  name: 'lucide-react',
  message:
    '图标只经 @/shared/icons 的 Icon 使用语义名称；新图形先加进 src/shared/icons/icon.tsx 的注册表',
}
const LUCIDE_DEEP = ['lucide-react/*']

const RADIX_LOCK = {
  name: 'radix-ui',
  importNames: ['Dialog', 'DropdownMenu', 'Popover', 'ToggleGroup'],
  message:
    '这些 primitive 已有契约组件：Dialog → @/shared/ui/dialog，DropdownMenu → @/shared/ui/menu，ToggleGroup → @/shared/ui/chip，Popover → @/shared/ui/popup',
}

// 语法级禁令（no-restricted-syntax 同名规则整块覆盖，所以各处按需拼这几条）
const NO_DEFAULT_EXPORT = {
  selector: 'ExportDefaultDeclaration',
  message: '只用具名导出：default 导出让每个调用点各起各的名字，rg 找不全用例',
}
const NO_RAW_IMPORT_META_ENV = {
  selector: 'MemberExpression[object.type="MetaProperty"][property.name="env"]',
  message: '环境变量只经 src/shared/config/env.ts 的 zod schema 读取，新变量先在那里声明',
}
const NO_MOCK_LOCAL_MODULE = {
  selector:
    'CallExpression[callee.object.name="vi"][callee.property.name="mock"] > Literal[value=/^(@\\/|\\.)/]',
  message:
    '不 vi.mock 同仓模块：渲染真实子树，网络走 MSW（docs/frontend-implementation.md 测试要求）',
}

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'public',
      'src/routeTree.gen.ts',
      // 生成物：改不了的代码不该卡门禁，形状由 pnpm contract:check 保证
      'src/shared/api/generated/**',
      // contract:check 的临时输出目录（崩溃残留也不该卡门禁）
      '.openapi-check-*',
      'node_modules',
      // docs/ 里有脱离本项目 tsconfig 的示例代码，类型感知规则跑不动
      'docs',
      // 照抄来的外部合同：逐字节保留，改动只允许出现在这个目录外面（见其 README）
      'src/shared/transcript/vendor/**',
    ],
  },

  // ── TypeScript / React 基础规则（类型感知） ──────────────────────────────
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...pluginQuery.configs['flat/recommended'],
      jsxA11y.configs.recommended,
      eslintReact.configs['recommended-typescript'],
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
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
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

  // ── 设计系统唯一入口（图标与已封装的 radix primitive 不得在业务层直连） ──
  //    flat config 里同名规则后者整块覆盖前者，所以两条禁令写在一起，
  //    下面两块只各自放行自己那一半。
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [LUCIDE_LOCK, RADIX_LOCK], patterns: LUCIDE_DEEP },
      ],
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT, NO_RAW_IMPORT_META_ENV],
    },
  },
  // 环境变量入口本体：可以读 import.meta.env（文件当前不存在，需要变量时按这个路径建）
  {
    files: ['src/shared/config/env.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_DEFAULT_EXPORT],
    },
  },
  // ── 文件名 kebab-case（routes/ 按 TanStack 约定用 _ 前缀与 . 分段，不在此列） ──
  {
    files: ['src/{app,features,shared,testing}/**/*.{ts,tsx}'],
    plugins: { 'check-file': checkFile },
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{ts,tsx}': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
    },
  },
  // 图标注册表本体：可以直连 lucide
  {
    files: ['src/shared/icons/icon.tsx'],
    rules: {
      'no-restricted-imports': ['error', { paths: [RADIX_LOCK] }],
    },
  },
  // 契约组件本体：可以直连 radix
  {
    files: ['src/shared/ui/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [LUCIDE_LOCK], patterns: LUCIDE_DEEP }],
    },
  },

  // ── 架构边界（依赖方向硬约束，违反即报错） ──────────────────────────────
  //
  //   app(app/、routes/、main.tsx) → 可用 feature 公开出口(index.ts)、shared
  //   features/<name>              → 本 feature 内部随意 + shared；跨 feature 一律禁止
  //   shared                       → 只能用 shared
  //   testing(src/testing)         → 测试基建；业务代码（app/feature/shared）不得 import，
  //                                  只有测试文件可用（测试文件整体豁免 boundaries，见下方测试块）
  //
  //   跨 feature 不留口子——包括对方的 index.ts。两个 feature 要共用东西只有两条路：
  //   下沉到 shared，或者在 routes / app 层把它们组装起来。旧前端就是靠「只走 index.ts」
  //   这个口子长出 69 条跨 feature 边、把 index.ts 撑成事实上的公共层的。
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
            '依赖方向违规：app 只能用 shared 与 feature 的 index.ts；feature 只能用本 feature 与 shared（跨 feature 一律禁止）；shared 只能用 shared',
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
      'no-restricted-syntax': [
        'error',
        NO_DEFAULT_EXPORT,
        NO_RAW_IMPORT_META_ENV,
        NO_MOCK_LOCAL_MODULE,
      ],
      // fetch/adapter mock 习惯写成 async () => value 以保持 Promise 返回类型
      '@typescript-eslint/require-await': 'off',
      // 对 vi.fn/mock 上的方法引用断言（toHaveBeenCalled 等）会误报 unbound-method
      '@typescript-eslint/unbound-method': 'off',
      // 测试用 mock 组件通过模块级变量向断言回传状态，不适用组件纯度检查
      'react-hooks/globals': 'off',
    },
  },

  // ── 契约组件同时导出组件与 cva variants：HMR 退化为整页刷新，可接受 ────────
  //    store/provider 文件按约定同时导出 Provider 组件与 hooks，同理。
  {
    files: ['src/**/state/**/*', 'src/shared/ui/**'],
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

  // ── Node 环境文件（构建配置、vite/ 下的配置助手、Playwright e2e） ────────
  {
    files: ['vite/**/*.ts', 'e2e/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },

  configPrettier,
)
