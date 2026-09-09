/** 从合同重新生成客户端，逐字节校验入库产物；后端合同由 make contract-check 校验。 */
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

// 临时目录须位于仓库内且不被 .prettierignore 排除，确保生成器使用项目的格式配置。
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
