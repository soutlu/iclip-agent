#!/usr/bin/env node
/**
 * 架构校验统一入口（模板，跨项目不变）。
 *
 * npm script、CI、tests/arch 共用本脚本，保证三处行为零偏差。
 * 基线文件存在 → 自动追加 --ignore-known（brownfield 旧账冻结期）；
 * 基线文件不存在 → 全量校验（greenfield，或旧账已清零）。
 * 清账完成后删除基线文件即可，无需修改任何命令。
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASELINE_FILE = '.dependency-cruiser-known-violations.json';

const ignoreKnown = existsSync(BASELINE_FILE) ? ' --ignore-known' : '';

try {
  execSync(`npx depcruise src --config .dependency-cruiser.cjs${ignoreKnown}`, {
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}
