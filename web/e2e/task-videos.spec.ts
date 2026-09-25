/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

const SHOT_DIR = '../.artifacts/design-qa/task-videos'
const TASK_TITLE = '通勤背包 · 城市宣传片'

const openTask = async (page: Page, username: 'tester' | 'governor' = 'tester') => {
  await page.goto('/')
  await login(page, username)
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  if ((page.viewportSize()?.width ?? 1374) < 600) {
    await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click()
  }
  const expand = page.getByRole('button', { name: '展开更多', exact: true })
  if (await expand.isVisible()) await expand.click()
  await page
    .getByRole('button', { name: `查看需求：${TASK_TITLE}`, exact: true })
    .first()
    .click()
  return page.getByRole('dialog', { name: TASK_TITLE, exact: true })
}

/** 通过浏览器 MSW 提交，既覆盖生成帧推动发现新产物，也避免向真实后端发起生成。 */
const submitMockVideo = (page: Page, conversationId: string) =>
  page.evaluate(async (id) => {
    const response = await fetch('/api/generations/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: id,
        shot_index: 2,
        model: 'wan3.0-video',
        prompt: '测试镜头组第二次生成',
        aspect_ratio: '9:16',
        seconds: 6,
        resolution: '720p',
        reference_image_urls: [],
      }),
    })
    return response.status
  }, conversationId)

test('需求详情可直接播放、切版、下载和放大，关闭预览保留表单', async ({ page }) => {
  await page.setViewportSize({ width: 1374, height: 1145 })
  const dialog = await openTask(page)
  const related = dialog.getByRole('complementary', { name: '关联对话与视频' })
  await expect(related.getByText('3 个对话', { exact: true })).toBeVisible()
  await expect(related.getByText('暂无视频产物', { exact: true })).toHaveCount(2)
  const conversation = related.getByRole('region', { name: '夜景延时素材生成', exact: true })
  const group = conversation.getByRole('region', { name: '镜头组 2', exact: true })
  const video = group.getByLabel('镜头组 2视频', { exact: true })
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThan(0)

  const link = conversation.getByRole('link', { name: /打开对话/ })
  const href = await link.getAttribute('href')
  if (!href) throw new Error('关联对话缺少打开地址')
  await expect(link).toHaveAttribute('target', '_blank')
  const conversationId = href.split('/').at(-1)
  if (!conversationId) throw new Error('缺少对话编号')
  // 在隔离的浏览器 MSW 环境提交一次出片，验证面板发现新结果并形成版本切换。
  const submitted = await submitMockVideo(page, conversationId)
  expect(submitted).toBe(202)
  const latest = group.getByRole('button', { name: '镜头组 2 V2', exact: true })
  await expect(latest).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  const earlier = group.getByRole('button', { name: '镜头组 2 V1', exact: true })
  await earlier.click()
  await expect(earlier).toHaveAttribute('aria-pressed', 'true')
  await latest.click()

  // 原生播放控件可用，视频开始前进；切到另一版会停止并卸载旧播放器。
  await video.focus()
  await video.press('Space')
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(0)
  await earlier.click()
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true)
  await dialog.getByLabel('需求单名称', { exact: true }).fill('尚未保存的需求单名称')
  await group.getByRole('button', { name: '放大镜头组 2', exact: true }).click()
  const preview = page.getByRole('dialog', { name: '镜头组 2', exact: true })
  await expect(preview).toBeVisible()
  await expect(preview.locator('video')).toHaveAttribute('autoplay', '')
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
  await expect(dialog.getByLabel('需求单名称', { exact: true })).toHaveValue('尚未保存的需求单名称')

  await group.getByRole('button', { name: '下载视频', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '下载原片', exact: true }).click()
  expect((await download).suggestedFilename()).toMatch(/\.webm$/)
  await group.getByRole('button', { name: '下载视频', exact: true }).click()
  const watermarkDownload = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '下载水印版', exact: true }).click()
  expect((await watermarkDownload).suggestedFilename()).toMatch(/\.webm$/)

  await dialog.getByLabel('需求单名称', { exact: true }).fill(TASK_TITLE)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({
      path: `${SHOT_DIR}/desktop-${colorScheme}.png`,
      animations: 'disabled',
    })
  }
  await page.setViewportSize({ width: 1210, height: 1324 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: `${SHOT_DIR}/desktop-tall.png`, animations: 'disabled' })
})

test('手机单列可滚动查看视频、长标题和操作，面板重开不丢表单', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openTask(page)
  const related = dialog.getByRole('complementary', { name: '关联对话与视频' })
  await related.scrollIntoViewIfNeeded()
  await expect(related.getByRole('heading', { name: '关联对话与视频' })).toBeVisible()
  const player = related.getByLabel('镜头组 2视频', { exact: true })
  await player.scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  await expect
    .poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(() =>
      related
        .getByLabel('镜头组 3视频', { exact: true })
        .evaluate((el: HTMLVideoElement) => el.readyState),
    )
    .toBeGreaterThanOrEqual(2)
  const bounds = await player.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds?.width).toBeLessThanOrEqual(390)
  expect(bounds?.height).toBeLessThanOrEqual(240)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: `${SHOT_DIR}/mobile-${colorScheme}.png`, animations: 'disabled' })
  }
  await related.getByRole('button', { name: '收起关联对话与视频' }).click()
  await expect(related).toBeHidden()
  await dialog
    .getByLabel('需求单名称', { exact: true })
    .fill('这是一份包含很长中文名称的商品口播视频创作需求单')
  await dialog.getByRole('button', { name: '打开关联对话与视频' }).click()
  await expect(related).toBeVisible()
  await expect(dialog.getByLabel('需求单名称', { exact: true })).toHaveValue(
    '这是一份包含很长中文名称的商品口播视频创作需求单',
  )
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('不同关联对话的内联播放与放大播放互斥', async ({ page }) => {
  const dialog = await openTask(page)
  const related = dialog.getByRole('complementary', { name: '关联对话与视频' })
  const first = related.getByRole('region', { name: '夜景延时素材生成', exact: true })
  const second = related.getByRole('region', { name: '通勤背包短视频', exact: true })
  const href = await second.getByRole('link', { name: /打开对话/ }).getAttribute('href')
  const id = href?.split('/').at(-1)
  if (!id) throw new Error('缺少第二段对话编号')
  expect(await submitMockVideo(page, id)).toBe(202)
  const secondVideo = second.getByLabel('镜头组 2视频', { exact: true })
  await expect(secondVideo).toBeVisible({ timeout: 15_000 })
  const firstVideo = first.getByLabel('镜头组 2视频', { exact: true })
  await firstVideo.focus()
  await firstVideo.press('Space')
  await expect.poll(() => firstVideo.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
  await secondVideo.focus()
  await secondVideo.press('Space')
  await expect.poll(() => secondVideo.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
  await expect.poll(() => firstVideo.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true)
  await first.getByRole('button', { name: '放大镜头组 2', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '镜头组 2', exact: true })).toBeVisible()
  // 放大后 Radix 会将底层需求单从可访问树隐藏，用已知播放器属性检查底层媒体状态。
  await expect
    .poll(() =>
      page
        .locator('video[aria-label="镜头组 2视频"]')
        .evaluateAll((videos: HTMLVideoElement[]) => videos.every((video) => video.paused)),
    )
    .toBe(true)
})
