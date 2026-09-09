/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

const SHOT_DIR = '../.artifacts/design-qa/task-form'

const productPng = async (page: Page) => {
  const fixture = process.env['TASK_FORM_QA_IMAGE']
  if (fixture) return readFile(fixture)
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 800
    const context = canvas.getContext('2d')
    if (!context) throw new Error('需要 Canvas 生成上传测试文件')
    context.fillStyle = '#eeeeee'
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1] ?? ''
  })
  return Buffer.from(base64, 'base64')
}

const openCreate = async (page: Page) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  if ((page.viewportSize()?.width ?? 1363) < 600) {
    await page.getByRole('button', { name: '折叠侧边栏' }).click()
  }
  await page.getByRole('button', { name: '新建需求单' }).click()
  return page.getByRole('dialog', { name: '新建需求单' })
}

test('需求单完整创建回读：规格、商品图库、分类参考图和单视频', async ({ page }) => {
  await page.setViewportSize({ height: 1154, width: 1363 })
  const dialog = await openCreate(page)
  await dialog.getByLabel('需求单名称', { exact: true }).fill('黑色短靴宣传视频')
  await dialog.getByLabel('截止时间', { exact: true }).fill('2026-10-01T18:30')
  await dialog.getByLabel('发布平台', { exact: true }).fill('douyin')
  await dialog.getByLabel('视频类型', { exact: true }).fill('product_showcase')
  await dialog.getByLabel('内容类型', { exact: true }).fill('short_video')
  await dialog.getByLabel('分辨率', { exact: true }).fill('1080p')
  await dialog.getByLabel('比例', { exact: true }).selectOption('9:16')
  await dialog.getByLabel('目标时长（秒）', { exact: true }).fill('15')
  await dialog.getByLabel('商品 1 款号', { exact: true }).fill('QA-BOOTS-001')
  await dialog.getByLabel('商品 1 名称', { exact: true }).fill('黑色短靴')
  await dialog.getByLabel('商品 1 品牌', { exact: true }).fill('品牌甲')
  await dialog.getByLabel('商品 1 品类', { exact: true }).fill('鞋靴')
  await dialog.getByLabel('商品 1 颜色', { exact: true }).fill('黑色')
  await dialog.getByRole('button', { name: '添加商品', exact: true }).click()
  await dialog.getByLabel('商品 2 款号', { exact: true }).fill('QA-BOOTS-002')
  await dialog.getByLabel('商品 2 颜色', { exact: true }).fill('棕色')
  await dialog
    .getByLabel('创作要求', { exact: true })
    .fill('展示短靴轮廓与皮革纹理，呈现简洁自然的日常穿搭。')

  const png = await productPng(page)
  const imageInput = dialog.getByLabel('选择商品 1 图片文件', { exact: true })
  await expect(imageInput).toHaveAttribute('multiple', '')
  await imageInput.setInputFiles([
    { buffer: png, mimeType: 'image/png', name: '商品正面.png' },
    { buffer: png, mimeType: 'image/png', name: '商品细节.png' },
  ])
  await expect(dialog.getByRole('button', { name: '预览商品 1 图片 2', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      dialog
        .getByAltText('商品 1 图片 1', { exact: true })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0)
  await expect(dialog.getByRole('button', { name: '添加商品 2 图片', exact: true })).toBeVisible()
  await expect(dialog.getByLabel('选择参考视频文件', { exact: true })).not.toHaveAttribute(
    'multiple',
    '',
  )
  for (const label of ['模特参考图', '穿搭参考图', '道具参考图']) {
    await expect(dialog.getByRole('button', { name: `添加${label}`, exact: true })).toBeVisible()
  }

  await dialog.getByLabel('创作要求', { exact: true }).focus()
  await page.screenshot({
    path: `${SHOT_DIR}/creative-focus.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await dialog.getByLabel('需求单名称', { exact: true }).scrollIntoViewIfNeeded()
  await dialog.getByRole('heading', { name: '新建需求单', exact: true }).click()
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: `${SHOT_DIR}/desktop-light.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({
    path: `${SHOT_DIR}/desktop-dark.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.emulateMedia({ colorScheme: 'light' })

  const createdResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/tasks') && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: '创建需求单', exact: true }).click()
  expect((await createdResponse).status()).toBe(201)
  await expect(dialog).toBeHidden()
  const card = page.getByRole('button', { name: /黑色短靴宣传视频/ })
  await expect(card).toContainText('QA-BOOTS-001 等 2 款')
  await card.click()
  const reopened = page.getByRole('dialog', { name: '黑色短靴宣传视频' })
  await expect(reopened.getByLabel('分辨率', { exact: true })).toHaveValue('1080p')
  await expect(reopened.getByLabel('比例', { exact: true })).toHaveValue('9:16')
  await expect(reopened.getByLabel('目标时长（秒）', { exact: true })).toHaveValue('15')
  await expect(reopened.getByLabel('商品 1 款号', { exact: true })).toBeDisabled()
  await expect(reopened.getByLabel('商品 2 款号', { exact: true })).toBeDisabled()
  await expect(reopened.getByLabel('商品 1 名称', { exact: true })).toHaveValue('黑色短靴')
  await expect(reopened.getByLabel('商品 2 颜色', { exact: true })).toHaveValue('棕色')
  await expect(
    reopened.getByRole('button', { name: '预览商品 1 图片 2', exact: true }),
  ).toBeVisible()
  await expect(reopened.getByRole('button', { name: '添加商品', exact: true })).toHaveCount(0)
  await expect(reopened.getByRole('button', { name: '移除商品 2', exact: true })).toHaveCount(0)
})

test('手机需求单正文可滚动，长创作要求与固定操作栏可用', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  const dialog = await openCreate(page)
  await dialog.getByLabel('需求单名称', { exact: true }).fill('夏季系列长内容需求单')
  await dialog.getByLabel('商品 1 款号', { exact: true }).fill('QA-MOBILE-001')
  const requirement = '保留原始创作要求与参考信息。'.repeat(100)
  await dialog.getByLabel('创作要求', { exact: true }).fill(requirement)
  await expect(dialog.getByText(`${requirement.length}/4000`, { exact: true })).toBeVisible()
  const submit = dialog.getByRole('button', { name: '创建需求单', exact: true })
  await expect(submit).toBeInViewport()
  await dialog.getByRole('heading', { name: '新建需求单', exact: true }).click()
  await page.screenshot({
    path: `${SHOT_DIR}/mobile-bottom.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await dialog.getByLabel('需求单名称', { exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByLabel('需求单名称', { exact: true })).toBeInViewport()
  await expect(submit).toBeInViewport()
  await page.screenshot({
    path: `${SHOT_DIR}/mobile-top.png`,
    fullPage: true,
    animations: 'disabled',
  })
  const bounds = await dialog.boundingBox()
  expect(bounds?.width).toBeLessThanOrEqual(390)
  await submit.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: /夏季系列长内容需求单/ })).toBeVisible()
})

test('认领需求后预览单段文字与图片，创建关联对话并发送首次消息', async ({ page }) => {
  await page.goto('/')
  await login(page)
  const png = await productPng(page)
  const original = '保留这段创作要求。\n人物不露脸，保持原文换行。'
  const task = await page.evaluate(async (requirement) => {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '需求单发起创作验收',
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        inputs: {
          creative_requirement: requirement,
          products: [
            {
              style_no: 'NOT-SENT-SKU',
              name: '不发送商品名称',
              brand: '不发送品牌',
              image_oss_urls: [],
            },
          ],
          video_spec: {
            aspect_ratio: '9:16',
            duration_seconds: 25,
            resolution: '1080p',
            platform: '不发送平台',
          },
          reference_image_oss_urls: {
            model: [],
            outfit: [],
            prop: [],
          },
          reference_video_oss_url: null,
        },
      }),
    })
    if (!response.ok) throw new Error('创建测试需求失败')
    const payload = (await response.json()) as { task: { id: string; title: string } }
    return payload.task
  }, original)
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  await page.getByRole('button', { name: /需求单发起创作验收/ }).click()
  let dialog = page.getByRole('dialog', { name: task.title })
  await dialog
    .getByLabel('选择商品 1 图片文件', { exact: true })
    .setInputFiles({ buffer: png, mimeType: 'image/png', name: '商品.png' })
  await expect(dialog.getByRole('button', { name: '预览商品 1 图片 1', exact: true })).toBeVisible()
  await dialog
    .getByLabel('选择模特参考图文件', { exact: true })
    .setInputFiles({ buffer: png, mimeType: 'image/png', name: '模特.png' })
  await expect(dialog.getByRole('button', { name: '预览模特参考图 1', exact: true })).toBeVisible()
  const productUrl = await dialog.getByAltText('商品 1 图片 1', { exact: true }).getAttribute('src')
  const modelUrl = await dialog.getByAltText('模特参考图 1', { exact: true }).getAttribute('src')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: /需求单发起创作验收/ }).click()
  await dialog.getByRole('button', { name: '发布', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: /需求单发起创作验收/ }).click()
  await expect(dialog.getByRole('button', { name: '开始创作', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '认领', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page
    .getByRole('region', { name: '我的需求单' })
    .getByRole('button', { name: /需求单发起创作验收/ })
    .click()
  dialog = page.getByRole('dialog', { name: task.title })
  await dialog.getByRole('button', { name: '开始创作', exact: true }).click()
  const preview = page.getByRole('dialog', { name: '发起创作' })
  const previewText = await preview.getByLabel('发送文字预览').inputValue()
  expect(previewText).toContain(original)
  expect(previewText).not.toContain('素材说明')
  expect(previewText).not.toContain('不发送平台')
  expect(previewText).not.toContain('不发送品牌')
  await expect
    .poll(() =>
      preview
        .getByAltText('图片 1', { exact: true })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({
    path: '../.artifacts/design-qa/task-creation/mock-preview-dark.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.emulateMedia({ colorScheme: 'light' })

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/conversations') && response.request().method() === 'POST',
  )
  const submittedRequest = page.waitForRequest(
    (request) =>
      /\/api\/conversations\/[^/]+\/prompts$/.test(request.url()) && request.method() === 'POST',
  )
  await preview.getByRole('button', { name: '确认并开始' }).click()
  const created = await createdResponse
  expect(created.request().postDataJSON()).toEqual({
    agentId: 'storyboard',
    taskId: task.id,
    title: task.title,
  })
  const { conversation } = (await created.json()) as {
    conversation: { id: string; taskId: string }
  }
  expect(conversation.taskId).toBe(task.id)
  const submitted = (await submittedRequest).postDataJSON() as {
    prompt_id: string
    content: unknown[]
  }
  expect(submitted.prompt_id).toBeTruthy()
  expect(submitted.content).toEqual([
    { type: 'text', text: previewText },
    { type: 'image', source: { kind: 'url', url: productUrl } },
    { type: 'image', source: { kind: 'url', url: modelUrl } },
  ])
  await expect(page).toHaveURL(`/c/${conversation.id}`)
})
