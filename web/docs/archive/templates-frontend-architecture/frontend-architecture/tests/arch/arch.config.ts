/**
 * 架构契约测试的项目清单（模板）。
 *
 * 这是 tests/arch 下唯一允许按项目修改的文件——测试本体跨项目不变。
 * 所有"存量豁免"集中在这里，带 TODO(清账) 注释，清一笔删一行（ARCHITECTURE.md §8）。
 */

export const archConfig = {
  /** 源码根目录（相对项目根）。 */
  srcRoot: 'src',

  /** 切片层目录名（与 .dependency-cruiser.cjs MANIFEST 中 sliced: true 的层一致）。 */
  slicedLayers: ['features'],

  /**
   * B1：环境变量唯一入口。匹配到 envPattern 的文件必须在 allowlist 内。
   * 纯 SPA 项目把 pattern 改为 /import\.meta\.env/ 并只保留客户端入口。
   */
  env: {
    pattern: /\bprocess\.env\b|\bimport\.meta\.env\b/,
    allowlist: [
      'src/server/env.ts',
      'src/shared/env.client.ts',
      // TODO(清账)：存量散点逐个迁移后删除
    ],
  },

  /**
   * B2：服务端目录禁止 'use client'。
   * 纯 SPA 项目置为 []（规则自动跳过）。
   */
  serverPaths: ['src/server/', 'src/app/api/', 'src/middleware.ts', 'src/proxy.ts'],

  /**
   * B4：单文件行数预算。
   * maxLines 约束所有新文件；legacyBudget 是存量巨文件的 ratchet——
   * 只许变小不许变大，拆完一个删一行。
   */
  lines: {
    maxLines: 800,
    legacyBudget: {
      // 'src/features/foo/components/HugeComponent.tsx': 2169, // TODO(清账)
    } as Record<string, number>,
  },

  /**
   * B5：协议字面量唯一来源。key 是字面量，value 是允许出现它的文件列表。
   * 典型条目：cookie 名、localStorage key、跨端事件名、WS 消息类型。
   */
  protocolLiterals: {
    // access_token_cookie_name: { literal: 'my_access_token', files: ['src/contracts/auth.ts'] },
  } as Record<string, { literal: string; files: string[] }>,
};
