#!/usr/bin/env node
/**
 * 对账脚本自测：真文件必须通过，注入漂移必须被抓出来。
 *
 * 只断言「通过」是没有意义的——对账逻辑要是把某一类差异漏了，正常用例照样绿。
 * 所以这里往运行时 CSS 里各塞一处浅色 / 深色漂移，验证两条路都报得出来。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { check, RUNTIME_PATHS, SPEC_PATH } from './check-design-system.mjs'
import { cn } from '../src/shared/lib/utils.ts'

const specHtml = readFileSync(SPEC_PATH, 'utf8')
const runtimeCss = RUNTIME_PATHS.map((p) => readFileSync(p, 'utf8')).join('\n')

test('真实规范与运行时逐名逐值一致', () => {
  const { spec, problems } = check({ specHtml, runtimeCss })
  assert.deepEqual(problems, [])
  assert.ok(spec.light.size > 400, '浅色契约 token 数不应突然缩水')
  assert.ok(spec.dark.size > 0, '深色契约不应为空')
})

test('浅色色值被改动即报「值不同」', () => {
  const drifted = runtimeCss.replace(
    '--color-canvas-card-border: var(--p60)',
    '--color-canvas-card-border: var(--p50)',
  )
  assert.notEqual(drifted, runtimeCss, '注入漂移失败：目标声明没找到')
  const { problems } = check({ specHtml, runtimeCss: drifted })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /:root 值不同：--color-canvas-card-border/)
})

test('深色映射被改动即报 .dark 值不同', () => {
  const drifted = runtimeCss.replace('--color-surface: var(--n6)', '--color-surface: var(--n10)')
  assert.notEqual(drifted, runtimeCss, '注入漂移失败：目标声明没找到')
  const { problems } = check({ specHtml, runtimeCss: drifted })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /\.dark 值不同：--color-surface/)
})

test('颜色 token 没登记成工具类即报「工具类未登记」', () => {
  const drifted = runtimeCss.replace(
    '  --color-canvas-card-border: var(--color-canvas-card-border);\n',
    '',
  )
  assert.notEqual(drifted, runtimeCss, '注入漂移失败：目标登记行没找到')
  const { problems } = check({ specHtml, runtimeCss: drifted })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /工具类未登记：--color-canvas-card-border/)
})

// 类名写成变量再传：prettier 的 tailwind 插件会重排 cn(...) 字面量里的类名顺序，
// 直接写进调用里的话，断言的先后关系会被格式化悄悄改掉。
const merge = (classes) => cn(classes)

test('cn() 不把字阶类与颜色类当冲突', () => {
  // 两者分属 font-size 与 text-color 两组，同时出现时都要留下
  assert.equal(merge('text-body text-on-surface'), 'text-body text-on-surface')
  assert.equal(
    merge('text-canvas-label text-canvas-label-text'),
    'text-canvas-label text-canvas-label-text',
  )
  // 两个文字颜色仍然互斥，后写的胜出
  assert.equal(merge('text-on-surface text-primary'), 'text-primary')
})
