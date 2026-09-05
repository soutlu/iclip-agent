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
      // 生成文件由 pnpm contract:check 校验。
      'src/shared/api/generated/**',
      // contract:check 临时输出目录。
      '.openapi-check-*',
      'node_modules',
      // 文档示例不属于项目 tsconfig，排除类型感知检查。
      'docs',
      // 外部合同保持原文，见该目录 README。
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

  // flat config 的同名规则整块覆盖；组合图标与 Radix 约束，入口例外仅解除各自的限制。
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
  // 环境变量入口允许读取 import.meta.env。
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

  // 架构边界：app → feature 公开出口 / shared；feature → 本模块 / shared。
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      // src 根目录文件归入 app；更深路径的 feature/shared/testing 匹配优先。
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

  // 测试可跨模块导入；业务代码仍禁止依赖 testing。
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

  // UI 与 state 模块同时导出组件和辅助函数，支持整页刷新。
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
