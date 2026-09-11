/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

type ReplicaDocument = {
  aspect_ratio: string
  shots: {
    index: number
    seconds: number
    image_urls: string[]
    prompt: {
      global_settings: string
      timeline: { timestamps: [number, number]; prompt: string; image_indexes: number[] }[]
    }
  }[]
}

const openReplica = async (page: Page, mobile = false) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '乐福鞋 · 完全复刻', exact: true }).click()
  if (mobile) await page.getByRole('button', { name: '打开右侧面板' }).click()
  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('textbox', { name: '全局设定', exact: true })).toBeVisible()
  return panel
}

const readReplica = (page: Page) =>
  page.evaluate(async () => {
    const conversationId = window.location.pathname.split('/').at(-1)
    const response = await fetch(
      `/api/conversations/${conversationId}/workspace/file?path=video_shot.json`,
    )
    if (!response.ok) throw new Error(`读取复刻文件失败：${response.status}`)
    const body = (await response.json()) as { file: { content: string; version: number } }
    return {
      document: JSON.parse(body.file.content) as ReplicaDocument,
      version: body.file.version,
    }
  })

test('共用文件按路径打开：全局参考图原位展开，只有编辑才保存', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const writes: string[] = []
  const generations: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'PUT' && path.endsWith('/workspace/file')) writes.push(request.url())
    if (request.method() === 'POST' && path.startsWith('/api/generations/')) {
      generations.push(request.url())
    }
  })
  const panel = await openReplica(page)
  const initial = await readReplica(page)
  const shot = initial.document.shots[0]
  if (shot === undefined) throw new Error('缺少复刻镜头组')
  expect(shot.prompt.timeline).toHaveLength(3)
  expect(shot.image_urls).toHaveLength(30)
  const references = panel.getByRole('navigation', { name: '本组镜头', exact: true })
  const global = references.getByRole('group', { name: '全局设定', exact: true })
  await expect(global.getByRole('button')).toHaveCount(30)
  for (const index of [30, 2, 1]) {
    const reference = references.getByRole('button', {
      name: `预览第 ${index} 帧`,
      exact: true,
    })
    await reference.focus()
    await page.keyboard.press('Enter')
    await expect(
      panel.getByRole('img', { name: `镜头组 1 第 ${index} 帧`, exact: true }),
    ).toHaveAttribute('src', shot.image_urls[index - 1] ?? '')
    await expect(panel.getByRole('textbox', { name: '全局设定', exact: true })).toBeVisible()
  }
  await references.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(global.getByRole('button')).toHaveCount(1)
  await expect(panel.getByRole('textbox', { name: '镜头 1 的描述', exact: true })).toBeVisible()
  await global.getByRole('button').click()

  expect(await readReplica(page)).toEqual(initial)
  expect(writes).toEqual([])
  expect(generations).toEqual([])

  const updated = `${shot.prompt.global_settings}\n产品始终完整入画，保持鞋面纹理清晰。`
  await panel.getByRole('textbox', { name: '全局设定', exact: true }).fill(updated)
  const expected = structuredClone(initial.document)
  const changedShot = expected.shots[0]
  if (changedShot === undefined) throw new Error('缺少待编辑镜头组')
  changedShot.prompt.global_settings = updated
  await expect.poll(async () => (await readReplica(page)).document).toEqual(expected)
  expect((await readReplica(page)).version).toBeGreaterThan(initial.version)
  await expect(panel.getByText('已保存', { exact: true })).toBeVisible()
  expect(writes.length).toBeGreaterThan(0)
  expect(generations).toEqual([])
})

for (const viewport of [
  { name: 'desktop', width: 1600, height: 1000, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]) {
  test(`完全复刻 ${viewport.name} 浅深主题布局`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const panel = await openReplica(page, viewport.mobile)
    const references = panel.getByRole('navigation', { name: '本组镜头', exact: true })
    for (const theme of ['light', 'dark'] as const) {
      await references.getByRole('button', { name: '预览第 1 帧', exact: true }).click()
      await page.emulateMedia({ colorScheme: theme })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark')
      await expect(references).toBeVisible()
      await expect(panel.getByRole('textbox', { name: '全局设定', exact: true })).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true)
      await expect(
        panel.getByRole('img', { name: '镜头组 1 第 1 帧', exact: true }),
      ).toHaveJSProperty('naturalWidth', 360)
      const lastReference = references.getByRole('button', { name: '预览第 30 帧', exact: true })
      await lastReference.focus()
      await page.keyboard.press('Enter')
      await expect(lastReference).toBeInViewport({ ratio: 1 })
      await expect(references.getByText('全局设定', { exact: true })).toBeInViewport({ ratio: 1 })
      await expect(panel.getByRole('button', { name: '添加图片', exact: true })).toBeInViewport({
        ratio: 1,
      })
      await page.mouse.move(0, 0)
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/replica/${viewport.name}-${theme}.png`,
        fullPage: true,
      })
    }
  })
}
