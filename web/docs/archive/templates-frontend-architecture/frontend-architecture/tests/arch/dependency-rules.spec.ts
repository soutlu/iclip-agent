import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 架构依赖契约（通用模板，跨项目不变）。
 *
 * 让 `npm test` 同样覆盖依赖图规则：开发者日常跑测试即校验架构，
 * 不依赖"记得单独跑 arch:check"。直接调用与 npm script / CI 完全相同的
 * 统一入口脚本（scripts/arch-check.mjs），保证三处行为零偏差。
 */

const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('架构依赖契约（dependency-cruiser）', () => {
  it('src 依赖图符合 .dependency-cruiser.cjs 全部规则（基线内旧账除外）', () => {
    try {
      execSync('node scripts/arch-check.mjs', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    } catch (error) {
      const report =
        error instanceof Error && 'stdout' in error
          ? String((error as { stdout: Buffer }).stdout)
          : String(error);
      expect.fail(
        `依赖规则违规（条款编号见 ARCHITECTURE.md §3；新增跨层/跨切片依赖需修改 MANIFEST 并在 PR 说明）：\n${report}`,
      );
    }
  });
});
