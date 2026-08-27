#!/usr/bin/env node
/**
 * 设计规范 ↔ 运行时 token 对账。
 *
 * 事实源是仓库根目录 design-system.html 第一个 <style> 里的 :root（浅色）与 .dark（深色）
 * 两块，除 --pg-*（本页装饰）外全部入账；运行时是 src/app/base.css + globals.css。
 * 两边去掉全部空格、小写后必须逐字相等，任一边多出变量都算漂移。
 *
 * 直接运行做对账；解析与比较导出成函数，供 check-design-system.node-test.mjs 注入漂移自测。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
export const SPEC_PATH = join(ROOT, '..', 'design-system.html')
export const RUNTIME_PATHS = [
  join(ROOT, 'src', 'app', 'base.css'),
  join(ROOT, 'src', 'app', 'globals.css'),
]

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** 值比较口径：去掉全部空白后小写，其余逐字相等 */
export const normalize = (value) => value.replace(/\s+/g, '').toLowerCase()

/** 取 `prelude {` 之后到配对 `}` 之间的原文（按花括号计数，容得下嵌套块） */
const blockBody = (text, openIndex) => {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }
  throw new Error('CSS 花括号不配对')
}

const readDeclarations = (body, into) => {
  // 只收顶层声明：嵌套块（如 @theme 里的 @media）整段跳过
  let depth = 0
  let buffer = ''
  for (const ch of body) {
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === ';' && depth === 0) {
      const m = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(buffer)
      if (m) into.set(m[1], m[2].trim())
      buffer = ''
      continue
    }
    if (depth === 0 && ch !== '{' && ch !== '}') buffer += ch
  }
}

/**
 * 规范侧：第一个 <style> 里第一个 :root 块与第一个 .dark 块，--pg-* 不入账。
 */
export function collectSpecTokens(html) {
  // 先去掉 HTML 注释：文件头那段说明里也写着 <style> 字样，会抢走第一个 <style> 的位置
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html.replace(/<!--[\s\S]*?-->/g, ''))
  if (!styleMatch) throw new Error('design-system.html 里找不到 <style> 块')
  const css = stripComments(styleMatch[1])

  const pick = (prelude) => {
    const at = css.indexOf(prelude)
    if (at < 0) throw new Error(`design-system.html 里找不到 ${prelude} 块`)
    const tokens = new Map()
    readDeclarations(blockBody(css, css.indexOf('{', at)), tokens)
    for (const name of tokens.keys()) if (name.startsWith('--pg-')) tokens.delete(name)
    return tokens
  }

  return { light: pick(':root'), dark: pick('.dark') }
}

/**
 * 运行时侧：只收顶层 :root / .dark / @theme 块。
 * @media 里的 :root 是响应式覆写不是 token 登记；@theme inline reference 是工具类登记，
 * 变量自引用（--color-x: var(--color-x)），两者都不入账。
 */
export function collectRuntimeTokens(css) {
  const text = stripComments(css)
  const light = new Map()
  const dark = new Map()

  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor)
    if (open < 0) break
    // 选择器只取最后一个分号之后的部分：前面可能堆着 @layer / @import 这类独立语句
    const prelude = text.slice(cursor, open).split(';').pop().trim().replace(/\s+/g, ' ')
    const body = blockBody(text, open)
    cursor = open + body.length + 2

    if (prelude === '.dark') readDeclarations(body, dark)
    else if (prelude === ':root') readDeclarations(body, light)
    else if (prelude.startsWith('@theme') && !prelude.includes('reference'))
      readDeclarations(body, light)
  }

  // @theme 里的 `--text-*: initial` 是清空 Tailwind 默认字号，不是 token 登记
  for (const [name, value] of light) if (normalize(value) === 'initial') light.delete(name)

  return { light, dark }
}

/** 返回人类可读的差异行；空数组表示对账通过 */
export function diffTokens(spec, runtime) {
  const problems = []
  for (const theme of ['light', 'dark']) {
    const where = theme === 'light' ? ':root' : '.dark'
    for (const [name, value] of spec[theme]) {
      if (!runtime[theme].has(name)) {
        problems.push(`${where} 缺失：${name}（规范有，运行时无）`)
      } else if (normalize(runtime[theme].get(name)) !== normalize(value)) {
        problems.push(
          `${where} 值不同：${name}\n    规范   ${value}\n    运行时 ${runtime[theme].get(name)}`,
        )
      }
    }
    for (const name of runtime[theme].keys()) {
      if (!spec[theme].has(name)) problems.push(`${where} 多余：${name}（运行时有，规范未登记）`)
    }
  }
  return problems
}

export function check({ specHtml, runtimeCss }) {
  const spec = collectSpecTokens(specHtml)
  const runtime = collectRuntimeTokens(runtimeCss)
  return { spec, runtime, problems: diffTokens(spec, runtime) }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const { spec, problems } = check({
    specHtml: readFileSync(SPEC_PATH, 'utf8'),
    runtimeCss: RUNTIME_PATHS.map((p) => readFileSync(p, 'utf8')).join('\n'),
  })
  if (problems.length) {
    console.error('设计规范对账失败（事实源：design-system.html）：')
    for (const line of problems) console.error(`  ✗ ${line}`)
    console.error('\n改 token 先改 design-system.html，再镜像到 base.css / globals.css。')
    process.exit(1)
  }
  console.log(`✓ 设计规范对账通过：:root ${spec.light.size} 个 · .dark ${spec.dark.size} 个`)
}
