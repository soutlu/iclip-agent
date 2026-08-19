import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { archConfig } from './arch.config';

/**
 * 源码级架构契约（通用模板，跨项目不变；项目差异全部收敛在 arch.config.ts）。
 *
 * 覆盖依赖图表达不了的约定：env 收口（B1）、server/client 指令边界（B2）、
 * 切片公共出口与空目录（B3）、行数 ratchet（B4）、协议字面量唯一来源（B5）。
 * 条款编号见 ARCHITECTURE.md §3。
 */

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(PROJECT_ROOT, archConfig.srcRoot);

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
    return [path.relative(PROJECT_ROOT, dir).split(path.sep).join('/')];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => collectEmptyDirs(path.join(dir, entry.name)));
};

/**
 * 读取相对路径对应的源码文本。
 *
 * @param relative - 相对项目根的文件路径。
 * @returns 文件内容字符串。
 */
const readSource = (relative: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');

const sourceFiles = collectSourceFiles(SRC_ROOT);

describe('源码级架构契约', () => {
  it('B1：环境变量只出现在 env 入口模块（豁免清单见 arch.config.ts）', () => {
    const allowlist = new Set(archConfig.env.allowlist);
    const violations = sourceFiles.filter(
      (file) => !allowlist.has(file) && archConfig.env.pattern.test(readSource(file)),
    );
    expect(violations, 'env 访问必须收敛到入口模块，新增配置请在入口声明').toEqual([]);
  });

  it("B2：服务端目录不得出现 'use client' 指令", () => {
    const serverFiles = sourceFiles.filter((file) =>
      archConfig.serverPaths.some((prefix) =>
        prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix,
      ),
    );
    const violations = serverFiles.filter((file) => /['"]use client['"]/.test(readSource(file)));
    expect(violations).toEqual([]);
  });

  it('B3a：切片层下每个切片必须有 index.ts(x) 公共出口', () => {
    const missing = archConfig.slicedLayers.flatMap((layerName) => {
      const layerRoot = path.join(SRC_ROOT, layerName);
      if (!fs.existsSync(layerRoot)) {
        return [];
      }
      return fs
        .readdirSync(layerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter(
          (entry) =>
            !fs.existsSync(path.join(layerRoot, entry.name, 'index.ts')) &&
            !fs.existsSync(path.join(layerRoot, entry.name, 'index.tsx')),
        )
        .map((entry) => `${layerName}/${entry.name}`);
    });
    expect(missing).toEqual([]);
  });

  it('B3b：src 下不允许存在空目录（死目录立即清理）', () => {
    expect(collectEmptyDirs(SRC_ROOT)).toEqual([]);
  });

  it('B4：文件行数 —— 新文件 ≤ 上限；遗留巨文件只许缩小（ratchet）', () => {
    const violations = sourceFiles.flatMap((file) => {
      const lines = readSource(file).split('\n').length;
      const budget = archConfig.lines.legacyBudget[file] ?? archConfig.lines.maxLines;
      return lines > budget ? [`${file}: ${lines} 行（上限 ${budget}）`] : [];
    });
    expect(
      violations,
      '超限请拆分文件；触碰 ratchet 清单文件时至少拆出本次相关部分并下调预算值',
    ).toEqual([]);
  });

  it('B4-ratchet 卫生：清单中的文件必须仍然存在（拆完/改名要同步删条目）', () => {
    const stale = Object.keys(archConfig.lines.legacyBudget).filter(
      (file) => !fs.existsSync(path.join(PROJECT_ROOT, file)),
    );
    expect(stale).toEqual([]);
  });

  it('B5：协议字面量只出现在声明的唯一来源文件', () => {
    const violations = Object.entries(archConfig.protocolLiterals).flatMap(
      ([name, { literal, files }]) => {
        const allowed = new Set(files);
        return sourceFiles
          .filter((file) => !allowed.has(file) && readSource(file).includes(literal))
          .map((file) => `${name}（"${literal}"）泄漏到 ${file}`);
      },
    );
    expect(violations, '协议字面量请从契约层导入常量，不要复制字符串').toEqual([]);
  });
});
