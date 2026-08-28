/**
 * 契约漂移门禁：把 contract/openapi.json 重新生成一遍，和入库的生成物逐字节比。
 *
 * 只管一个方向——**入库的生成物是不是这份合同当前的产物**。另一个方向（合同本身
 * 是不是后端当前的样子）由 `make contract-check` 管，它要跑得起后端依赖，不放在
 * 前端门禁里。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED = join(WEB_ROOT, 'src/shared/api/generated')

const fail = (message) => {
  console.error(`[contract] ${message}`)
  process.exit(1)
}

/** 列出目录下的全部文件（相对路径，已排序）。 */
const listFiles = (root, prefix = '') =>
  readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? listFiles(root, join(prefix, entry.name)) : [join(prefix, entry.name)],
    )
    .sort()

// 临时目录必须在仓库里：prettier 按被格式化文件的位置找配置，放到系统 tmp
// 会退回默认风格，比出来的差异全是引号和分号。这也意味着它不能进 .prettierignore，
// 否则生成器自己的 prettier 后处理会跳过它。上一轮被杀掉留下的残留在这里清掉。
for (const entry of readdirSync(WEB_ROOT)) {
  if (entry.startsWith('.openapi-check-'))
    rmSync(join(WEB_ROOT, entry), { force: true, recursive: true })
}
const temporaryRoot = mkdtempSync(join(WEB_ROOT, '.openapi-check-'))
try {
  const generated = spawnSync('pnpm', ['exec', 'openapi-ts', '-f', 'openapi-ts.config.js'], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ICLIP_CONTRACT_OUTPUT: join(temporaryRoot, 'generated') },
  })
  if (generated.status !== 0) {
    fail(`重新生成失败：${generated.stderr || generated.stdout}`)
  }

  const expected = listFiles(join(temporaryRoot, 'generated'))
  const actual = listFiles(COMMITTED)
  const missing = expected.filter((file) => !actual.includes(file))
  const extra = actual.filter((file) => !expected.includes(file))
  if (missing.length || extra.length) {
    fail(
      `生成物文件集漂移：缺少 [${missing.join(', ')}]，多出 [${extra.join(', ')}]；跑 pnpm contract:generate`,
    )
  }

  for (const file of expected) {
    const committed = readFileSync(join(COMMITTED, file))
    const fresh = readFileSync(join(temporaryRoot, 'generated', file))
    if (!committed.equals(fresh)) {
      fail(`${relative(WEB_ROOT, join(COMMITTED, file))} 与合同不一致；跑 pnpm contract:generate`)
    }
  }

  console.log(`[contract] 通过：${expected.length} 个生成文件与 contract/openapi.json 一致`)
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
