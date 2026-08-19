import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * vitest 配置模板。
 *
 * 要点：
 *   1. include 必须含 tests/arch/**——架构契约随 `npm test` 默认运行。
 *   2. server-only 毒丸在测试环境替换为空 stub（vitest 无 react-server 条件），
 *      使 BFF/服务端模块可被单测加载；真正的毒丸校验由 `npm run build` 承担。
 *   3. 别名只保留一个 `@ → src`：路径边界交给 dependency-cruiser，
 *      别名越少心智越简单（不要为每层建别名）。
 */
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
