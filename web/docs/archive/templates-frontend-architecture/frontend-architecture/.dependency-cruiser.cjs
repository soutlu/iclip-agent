/**
 * 通用前端架构依赖规则（模板）。
 *
 * 使用方式：
 *   1. 复制本文件到项目根，只修改顶部 MANIFEST 区；规则生成器原则上不动。
 *   2. `npm run arch:check` 校验；存量项目先 `npm run arch:baseline` 冻结旧账。
 *   3. 修改 MANIFEST = 架构决策，PR 必须说明理由（见 ARCHITECTURE.md §8）。
 *
 * 条款编号（A1–A9）与 ARCHITECTURE.md §3 对应。
 */

/* ============================================================
 * MANIFEST —— 每个项目唯一需要修改的区域
 * ============================================================ */

const MANIFEST = {
  /**
   * 抽象层，自上而下排列（上层可依赖下层，反向禁止 —— A1）。
   * - name: 层名（src 下的一级目录名）
   * - sliced: 是否按业务切片管理（启用 A2 切片隔离 + A3 公共 API）
   * 不需要的层删掉即可（如纯 SPA 删 widgets/entities/contracts）。
   */
  layers: [
    { name: 'app', sliced: false },
    // { name: 'widgets', sliced: true },
    { name: 'features', sliced: true },
    // { name: 'entities', sliced: true },
    { name: 'shared', sliced: false },
    { name: 'contracts', sliced: false },
  ],

  /**
   * 同层切片依赖白名单（A2 例外，本质是债务登记簿）：
   *   '<layer>/<slice>': ['同层允许依赖的 slice', ...]
   * 未列出的切片默认零依赖；白名单不得成环（加载时自检）。
   * 每项请附"为什么不下沉"的注释。白名单内依赖仍必须经对方 index（A3）。
   */
  allowedSliceDeps: {
    // 'features/checkout': ['cart'], // checkout 读购物车状态；待评估下沉 entities/order
  },

  /**
   * 服务端旁路配置（A5–A7）。纯 SPA 项目置为 null。
   */
  server: {
    /** 服务端域代码目录（每个模块强制 server-only 毒丸 —— A7）。 */
    path: 'server',
    /** BFF/中间件入口（A6：禁止依赖任何切片层），按框架调整。 */
    entrypoints: ['^src/app/api/', '^src/middleware\\.ts$', '^src/proxy\\.ts$'],
    /** server 除自身与 contracts 外，额外允许的 shared 纯工具子路径（A5）。 */
    allowedShared: ['^src/shared/lib/'],
  },

  /** contracts 层目录名；未启用置为 null（A4 随之关闭）。 */
  contractsPath: 'contracts',

  /** A9 孤儿检测豁免：框架约定文件与声明文件。按框架增删。 */
  orphanExempt: [
    '\\.d\\.ts$',
    '\\.css$',
    '^src/app/', // Next App Router / 文件路由约定文件由框架隐式引用
    '^src/middleware\\.ts$',
    '^src/proxy\\.ts$',
    '^src/main\\.tsx?$', // Vite 入口
  ],
};

/* ============================================================
 * 规则生成器 —— 以下内容跨项目不变
 * ============================================================ */

const layerNames = MANIFEST.layers.map((layer) => layer.name);
const slicedLayers = MANIFEST.layers.filter((layer) => layer.sliced).map((layer) => layer.name);

/**
 * MANIFEST 自检：白名单 key 必须属于切片层；白名单图不得成环。
 * 配置错误在加载期直接抛出，避免静默生成错误规则。
 */
const validateManifest = () => {
  const adjacency = new Map();
  for (const [key, deps] of Object.entries(MANIFEST.allowedSliceDeps)) {
    const [layerName] = key.split('/');
    if (!slicedLayers.includes(layerName)) {
      throw new Error(`allowedSliceDeps 的 key "${key}" 不属于任何切片层（sliced: true）`);
    }
    adjacency.set(key, deps.map((dep) => `${layerName}/${dep}`));
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (node, trail) => {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      throw new Error(`allowedSliceDeps 白名单成环：${[...trail, node].join(' -> ')}`);
    }
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      visit(next, [...trail, node]);
    }
    visiting.delete(node);
    done.add(node);
  };
  for (const node of adjacency.keys()) {
    visit(node, []);
  }
};
validateManifest();

/** A1：对每一层生成"禁止依赖其上所有层"的规则。 */
const layeringRules = MANIFEST.layers.flatMap((layer, index) => {
  const upperLayers = layerNames.slice(0, index);
  if (upperLayers.length === 0) {
    return [];
  }
  return [
    {
      name: `A1-no-upward-${layer.name}`,
      comment: `A1 单向分层：${layer.name} 不得依赖上层（${upperLayers.join(', ')}）`,
      severity: 'error',
      from: { path: `^src/${layer.name}/` },
      to: { path: `^src/(${upperLayers.join('|')})/` },
    },
  ];
});

/**
 * A2：切片层内默认互相隔离。
 * 说明：dependency-cruiser 支持把 from.path 捕获组以 $1 形式代入 to 的正则。
 * 白名单放行的是"目标切片的 index"，来源合法性由 A2-whitelist-source 规则补充约束。
 */
const sliceIsolationRules = slicedLayers.map((layerName) => {
  const allowEntries = Object.entries(MANIFEST.allowedSliceDeps)
    .filter(([key]) => key.startsWith(`${layerName}/`))
    .map(([key, deps]) => [key.slice(layerName.length + 1), deps]);

  const to = { path: `^src/${layerName}/(?!$1/)[^/]+/` };
  if (allowEntries.length > 0) {
    const allowedTargets = [...new Set(allowEntries.flatMap(([, deps]) => deps))];
    to.pathNot = [`^src/${layerName}/(${allowedTargets.join('|')})/index\\.tsx?$`];
  }

  return {
    name: `A2-slice-isolation-${layerName}`,
    comment: `A2 切片隔离：${layerName} 内切片互不依赖（白名单见 MANIFEST.allowedSliceDeps）`,
    severity: 'error',
    from: { path: `^src/${layerName}/([^/]+)/` },
    to,
  };
});

/**
 * A2 补充：白名单目标只允许被登记过的来源切片依赖。
 * （A2 主规则的 pathNot 对全层放行了目标 index，这里按目标收紧来源。）
 */
const sliceWhitelistSourceRules = slicedLayers.flatMap((layerName) => {
  const targets = new Map();
  for (const [key, deps] of Object.entries(MANIFEST.allowedSliceDeps)) {
    if (!key.startsWith(`${layerName}/`)) continue;
    const source = key.slice(layerName.length + 1);
    for (const target of deps) {
      if (!targets.has(target)) targets.set(target, new Set());
      targets.get(target).add(source);
    }
  }
  return [...targets.entries()].map(([target, sources]) => ({
    name: `A2-whitelist-source-${layerName}-${target}`,
    comment: `A2：${layerName}/${target} 只允许被 [${[...sources].join(', ')}] 依赖`,
    severity: 'error',
    from: { path: `^src/${layerName}/(?!(${[...sources, target].join('|')})/)` },
    to: { path: `^src/${layerName}/${target}/` },
  }));
});

/** A3：切片外部只能 import 该切片的 index.ts(x)。 */
const publicApiRules = slicedLayers.flatMap((layerName) => [
  {
    name: `A3-public-api-${layerName}-external`,
    comment: `A3 公共 API：${layerName} 切片外部只能 import 其 index`,
    severity: 'error',
    from: { path: '^src/', pathNot: `^src/${layerName}/` },
    to: {
      path: `^src/${layerName}/[^/]+/.`,
      pathNot: `^src/${layerName}/[^/]+/index\\.tsx?$`,
    },
  },
  {
    name: `A3-public-api-${layerName}-internal`,
    comment: `A3 公共 API：${layerName} 切片之间（含白名单内）也只能经对方 index`,
    severity: 'error',
    from: { path: `^src/${layerName}/([^/]+)/` },
    to: {
      path: `^src/${layerName}/(?!$1/)[^/]+/.`,
      pathNot: `^src/${layerName}/[^/]+/index\\.tsx?$`,
    },
  },
]);

/** A4：契约层零依赖。 */
const contractsRules = MANIFEST.contractsPath
  ? [
      {
        name: 'A4-contracts-zero-deps',
        comment: 'A4 契约层零依赖：contracts 不得 import src 内其他模块',
        severity: 'error',
        from: { path: `^src/${MANIFEST.contractsPath}/` },
        to: { path: '^src/', pathNot: `^src/${MANIFEST.contractsPath}/` },
      },
    ]
  : [];

/** A5 + A6：服务端隔离与入口净化。 */
const serverRules = MANIFEST.server
  ? [
      {
        name: 'A5-server-isolation',
        comment: 'A5 服务端隔离：server 只依赖自身、contracts、白名单 shared 子路径',
        severity: 'error',
        from: { path: `^src/${MANIFEST.server.path}/` },
        to: {
          path: '^src/',
          pathNot: [
            `^src/${MANIFEST.server.path}/`,
            ...(MANIFEST.contractsPath ? [`^src/${MANIFEST.contractsPath}/`] : []),
            ...MANIFEST.server.allowedShared,
          ],
        },
      },
      {
        name: 'A6-server-entrypoints-clean',
        comment: 'A6 入口净化：BFF/中间件不得依赖切片层，跨端共享走 contracts',
        severity: 'error',
        from: { path: MANIFEST.server.entrypoints },
        to: { path: `^src/(${slicedLayers.join('|')})/` },
      },
    ]
  : [];

/** A7：server 模块必须涂毒丸（required 规则）。 */
const requiredRules = MANIFEST.server
  ? [
      {
        name: 'A7-server-only-poison',
        comment: 'A7 毒丸必涂：server 下每个模块必须 import "server-only"',
        severity: 'error',
        module: { path: `^src/${MANIFEST.server.path}/.+\\.tsx?$` },
        to: { path: 'server-only' },
      },
    ]
  : [];

module.exports = {
  forbidden: [
    {
      name: 'A8-no-circular',
      comment: 'A8 零循环：禁止任何循环依赖（type-only 同样计入）',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    ...layeringRules,
    ...sliceIsolationRules,
    ...sliceWhitelistSourceRules,
    ...publicApiRules,
    ...contractsRules,
    ...serverRules,
    {
      name: 'A9-no-orphans',
      comment: 'A9 无孤儿：无人引用的模块视为死代码（豁免见 MANIFEST.orphanExempt）',
      severity: 'warn',
      from: { orphan: true, pathNot: MANIFEST.orphanExempt },
      to: {},
    },
  ],
  required: requiredRules,
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // type-only import 同样构成架构耦合，必须纳管（A8 的前提）
    tsPreCompilationDeps: true,
    // 基线（旧账冻结）走 CLI：arch:baseline 生成快照，arch:check --ignore-known 忽略旧账
  },
};
