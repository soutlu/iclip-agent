/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

const openStoryboard = async (page: Page, mobile = false) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  if (mobile) await page.getByRole('button', { name: '打开右侧面板' }).click()
  return page.getByRole('complementary', { name: '右侧面板' })
}

type StoredShot = {
  index: number
  seconds: number
  image_urls: string[]
  prompt: {
    global_settings: string
    timeline: { timestamps: [number, number]; prompt: string; image_indexes: number[] }[]
  }
}
type StoredDocument = { aspect_ratio: string; shots: StoredShot[] }

const readDocument = async (page: Page) =>
  page.evaluate(async () => {
    const conversationId = window.location.pathname.split('/').at(-1)
    const response = await fetch(
      `/api/conversations/${conversationId}/workspace/file?path=video_shot.json`,
    )
    if (!response.ok) throw new Error(`读取工作区失败：${response.status}`)
    const body = (await response.json()) as { file: { content: string; version: number } }
    return { document: JSON.parse(body.file.content) as StoredDocument, version: body.file.version }
  })

const rawGroupPrompt = (shot: StoredShot) => {
  const lines = shot.prompt.timeline.map(
    (item, position) =>
      `[${item.timestamps[0]}–${item.timestamps[1]}秒｜镜头${position + 1}] ${item.prompt}`,
  )
  return `${shot.prompt.global_settings}\n\n${lines.join('\n')}\n不要生成字幕，不要生成背景音乐。`
}
const watchGenerationPosts = (page: Page) => {
  const posts: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.startsWith('/api/generations/')
    ) {
      posts.push(request.url())
    }
  })
  return posts
}

const framePng = async (page: Page, color: string) => {
  const base64 = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 800
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('测试图片需要 Canvas 2D')
    context.fillStyle = fill
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1] ?? ''
  }, color)
  return Buffer.from(base64, 'base64')
}

test('分镜可以滚轮翻组、键盘切帧和查看记录，浏览操作不写文件或提交生成', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 700 })
  const writes: string[] = []
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/api\/(?:generations|conversations\/[^/]+\/workspace\/file)/.test(request.url())
    ) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  })
  const panel = await openStoryboard(page)
  await panel.getByRole('region', { name: '镜头组 1', exact: true }).hover()
  await page.mouse.wheel(0, 650)
  await expect(panel.getByRole('button', { name: '第 2 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )
  await expect(page).toHaveURL(/shot=2/)

  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  const filmstrip = group.getByRole('navigation', { name: '本组镜头' })
  await filmstrip.getByRole('button', { name: '镜头 2', exact: true }).focus()
  await page.keyboard.press('Enter')
  const lastFrame = filmstrip.getByRole('button', { name: '预览第 3 帧' })
  await filmstrip.getByRole('button', { name: '预览第 2 帧' }).focus()
  await page.keyboard.press('Tab')
  await expect(lastFrame).toBeFocused()
  await page.keyboard.press('Space')
  await expect(lastFrame).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/frame=3/)
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({ ratio: 1 })
  await expect(filmstrip).toBeInViewport({ ratio: 1 })
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText('低头看一眼包')
  await expect(group.getByRole('button', { name: '生成视频' })).toHaveCount(0)
  await expect(group.getByRole('button', { name: '编辑图片', exact: true })).toHaveCount(1)

  await panel.getByRole('button', { name: '生成记录', exact: true }).click()
  const records = panel.getByRole('complementary', { name: '生成记录', exact: true })
  await expect(records.getByRole('article')).toHaveCount(3)
  await records.getByRole('button', { name: '关闭生成记录' }).click()
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
  expect(writes).toEqual([])
})

for (const width of [1335, 390]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`分镜 ${width}px ${colorScheme}：原文、参考图和总览可读，关闭后恢复选择与焦点`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 880 })
      await page.emulateMedia({ colorScheme })
      const panel = await openStoryboard(page, width === 390)
      await panel.getByRole('button', { name: '第 2 组' }).click()
      const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
      const filmstrip = group.getByRole('navigation', { name: '本组镜头' })
      await filmstrip.getByRole('button', { name: '镜头 2', exact: true }).click()
      const lastFrame = filmstrip.getByRole('button', { name: '预览第 3 帧' })
      await lastFrame.click()
      await expect(lastFrame).toBeInViewport({ ratio: 1 })
      await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({
        ratio: 1,
      })
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/storyboard-reader/main-${width}-${colorScheme}.png`,
      })

      const trigger = group.getByRole('button', { name: '完整提示词', exact: true })
      await trigger.focus()
      await page.keyboard.press('Enter')
      const sheet = panel.getByRole('complementary', { name: '镜头组完整提示词', exact: true })
      const original = sheet.getByRole('region', { name: '镜头组原文', exact: true })
      await expect(original).toBeFocused()
      const settings = sheet.getByRole('textbox', { name: '全局设定', exact: true })
      await expect(settings).toContainText('参考锁定：模特的服装与发型跟住')
      await expect(settings.getByRole('button', { name: '看第 1 帧', exact: true })).toBeVisible()
      await expect(original).toContainText('[0–4秒｜镜头1]')
      await expect(original).toContainText('[4–11秒｜镜头2]')
      await expect(sheet.getByRole('button', { name: '复制完整提示词' })).toBeInViewport({
        ratio: 1,
      })
      await expect(sheet.getByRole('button', { name: '生成视频' })).toHaveCount(0)
      await expect(sheet).toBeInViewport({ ratio: 1 })
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/storyboard-reader/prompt-${width}-${colorScheme}.png`,
      })

      const reference = sheet.getByRole('button', { name: '查看参考图 @Image3', exact: true })
      await reference.scrollIntoViewIfNeeded()
      await reference.click()
      const preview = page.getByRole('dialog', { name: '参考图 @Image3', exact: true })
      await expect(preview).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(preview).toBeHidden()
      await expect(reference).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(lastFrame).toHaveAttribute('aria-pressed', 'true')
      const search = new URL(page.url()).searchParams
      expect(search.get('shot')).toBe('2')
      expect(search.get('frame')).toBe('3')
      expect(search.has('sheet')).toBe(false)

      await panel.getByRole('button', { name: '全部镜头组', exact: true }).click()
      const overview = panel.getByRole('complementary', { name: '全部镜头组', exact: true })
      await expect(overview.getByRole('button', { name: /查看镜头组/ })).toHaveCount(3)
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/storyboard-reader/overview-${width}-${colorScheme}.png`,
      })
      await overview.getByRole('button', { name: '查看镜头组 3', exact: true }).click()
      await expect(overview).toBeHidden()
      await expect(panel.getByRole('region', { name: '镜头组 3', exact: true })).toBeInViewport()
      await expect(page).toHaveURL(/shot=3/)
    })
  }
}

test('agent 更新工作区后重读结构化正文，保留当前组和帧', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const panel = await openStoryboard(page)
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await group.getByRole('button', { name: '预览第 3 帧' }).click()
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    {
      timeout: 20_000,
    },
  )
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
  await expect(page).toHaveURL(/shot=2/)
  await expect(page).toHaveURL(/frame=3/)
})

test('编辑一镜后保存并读回，复制整组保留 raw 图片标记与空白', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const generationPosts = watchGenerationPosts(page)
  const panel = await openStoryboard(page)
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    {
      timeout: 20_000,
    },
  )
  const before = await readDocument(page)
  const expected = structuredClone(before.document)
  const secondGroup = expected.shots[1]
  const firstScene = secondGroup?.prompt.timeline[0]
  if (secondGroup === undefined || firstScene === undefined) throw new Error('缺少第二组第一镜')
  const changed = '她从长椅间走向镜头 @Image01，脚步放慢。\n  镜头缓慢推进。  '
  firstScene.prompt = changed
  firstScene.image_indexes = [1]
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await group.getByRole('textbox', { name: '镜头 1 的描述' }).fill(changed)

  await expect.poll(async () => (await readDocument(page)).document).toEqual(expected)
  expect((await readDocument(page)).version).toBeGreaterThan(before.version)
  await expect(panel.getByText('已保存', { exact: true })).toBeVisible()
  await group.getByRole('button', { name: '复制镜头正文', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(changed)

  await group.getByRole('button', { name: '完整提示词', exact: true }).click()
  const sheet = panel.getByRole('complementary', { name: '镜头组完整提示词', exact: true })
  await sheet.getByRole('button', { name: '复制完整提示词', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(rawGroupPrompt(secondGroup))
  expect(generationPosts).toEqual([])
})

test('编辑生成把历史记录里的镜头组回填到当前组并落盘，图片不跟历史走', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const generationPosts = watchGenerationPosts(page)
  const panel = await openStoryboard(page)
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 1 的描述' })).toContainText('走向镜头', {
    timeout: 20_000,
  })
  const before = await readDocument(page)

  await panel.getByRole('button', { name: '生成记录', exact: true }).click()
  const records = panel.getByRole('complementary', { name: '生成记录', exact: true })
  const editable = records
    .getByRole('article')
    .filter({ hasText: '第一版：她从长椅间走向镜头' })
    .getByRole('button', { name: '编辑生成' })
  await editable.click()
  await expect(page.getByText('历史提示词已回填到当前镜头组')).toBeVisible()

  await expect
    .poll(async () => (await readDocument(page)).document.shots[1]?.prompt, { timeout: 20_000 })
    .toEqual({
      global_settings: before.document.shots[1]?.prompt.global_settings,
      timeline: [
        {
          timestamps: [0, 4],
          prompt: '第一版：她从长椅间走向镜头 @Image1。',
          image_indexes: [1],
        },
        {
          timestamps: [4, 11],
          prompt: '第一版：走到近处停下微笑 @Image2。',
          image_indexes: [2],
        },
      ],
    })
  expect((await readDocument(page)).document.shots[1]?.image_urls).toEqual(
    before.document.shots[1]?.image_urls,
  )
  expect(generationPosts).toEqual([])
})

test('总览按文件顺序复制选中的多个镜头组，保留各组 raw 图片标记', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const generationPosts = watchGenerationPosts(page)
  const workspaceWrites: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/workspace/file')) {
      workspaceWrites.push(request.url())
    }
  })
  const panel = await openStoryboard(page)
  const initial = await readDocument(page)
  const first = initial.document.shots[0]
  const third = initial.document.shots[2]
  if (first === undefined || third === undefined) throw new Error('需要第一组和第三组')
  await panel.getByRole('button', { name: '全部镜头组', exact: true }).click()
  const overview = panel.getByRole('complementary', { name: '全部镜头组', exact: true })
  await overview.getByRole('button', { name: '选中镜头组 3', exact: true }).click()
  await overview.getByRole('button', { name: '选中镜头组 1', exact: true }).click()
  await overview.getByRole('button', { name: '复制选中镜头组', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`镜头组 1\n${rawGroupPrompt(first)}\n\n镜头组 3\n${rawGroupPrompt(third)}`)
  expect(workspaceWrites).toEqual([])
  expect(generationPosts).toEqual([])
})

test('无图分镜上传首图后关联到另一镜，替换共享图片只改变同一 URL 槽位', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const generationPosts = watchGenerationPosts(page)
  const uploadRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/(?:uploads\/sign|assets\/[^/]+)$/.test(new URL(request.url()).pathname)
    ) {
      uploadRequests.push(new URL(request.url()).pathname)
    }
  })
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '无图分镜草稿', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '右侧面板' })
  const group = panel.getByRole('region', { name: '镜头组 1', exact: true })
  const initial = await readDocument(page)
  expect(initial.document.shots[0]?.image_urls).toEqual([])
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 1 的描述' })).toContainText('展示正面')
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-reader/no-images-desktop.png',
  })
  await group.getByRole('button', { name: '添加图片', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '添加图片', exact: true })
  await picker.getByLabel('选择要上传的图片', { exact: true }).setInputFiles({
    buffer: await framePng(page, '#23503e'),
    mimeType: 'image/png',
    name: '第一张图.png',
  })
  await expect(picker).toBeHidden()
  await expect
    .poll(async () => (await readDocument(page)).document.shots[0]?.image_urls.length)
    .toBe(1)
  const uploaded = await readDocument(page)
  const uploadedShot = uploaded.document.shots[0]
  if (uploadedShot === undefined) throw new Error('缺少上传后的镜头组')
  const firstUrl = uploadedShot.image_urls[0]
  expect(firstUrl).toMatch(/^http:\/\/localhost\/mock-oss\//)
  expect(uploadedShot.prompt.timeline[0]?.image_indexes).toEqual([1])
  expect(uploadedShot.prompt.timeline[0]?.prompt).toContain('@Image1')
  expect(uploadedShot.prompt.timeline[1]).toEqual(initial.document.shots[0]?.prompt.timeline[1])
  expect(uploadRequests.filter((path) => path === '/api/uploads/sign')).toHaveLength(1)
  expect(uploadRequests.filter((path) => path.startsWith('/api/assets/'))).toHaveLength(1)

  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await group.getByRole('button', { name: '添加图片', exact: true }).click()
  await picker.getByRole('button', { name: '关联第 1 张图片', exact: true }).click()
  await expect(picker).toBeHidden()
  await expect
    .poll(
      async () => (await readDocument(page)).document.shots[0]?.prompt.timeline[1]?.image_indexes,
    )
    .toEqual([1])
  const shared = await readDocument(page)
  const sharedShot = shared.document.shots[0]
  if (sharedShot === undefined) throw new Error('缺少共享图片后的镜头组')
  expect(sharedShot.image_urls).toEqual([firstUrl])
  expect(sharedShot.prompt.timeline[0]).toEqual(uploadedShot.prompt.timeline[0])
  expect(sharedShot.prompt.timeline[1]?.prompt).toContain('@Image1')

  await group.getByLabel('选择替换图片', { exact: true }).setInputFiles({
    buffer: await framePng(page, '#be6838'),
    mimeType: 'image/png',
    name: '替换共享图.png',
  })
  await expect
    .poll(async () => (await readDocument(page)).document.shots[0]?.image_urls[0])
    .not.toBe(firstUrl)
  const replaced = await readDocument(page)
  const replacementUrl = replaced.document.shots[0]?.image_urls[0]
  expect(replacementUrl).toMatch(/^http:\/\/localhost\/mock-oss\//)
  expect(replaced.document).toEqual({
    ...shared.document,
    shots: [{ ...sharedShot, image_urls: [replacementUrl] }],
  })
  await expect(group.getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
    'src',
    replacementUrl ?? '',
  )
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
    'src',
    replacementUrl ?? '',
  )
  await expect(group.getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveJSProperty(
    'naturalWidth',
    600,
  )
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-reader/first-image-shared-replaced-desktop.png',
  })
  expect(generationPosts).toEqual([])
})

test('选模型出片：请求照上游形状取当前组，记录先生成中后完成，下载分原片与水印版', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const panel = await openStoryboard(page)
  await panel.getByRole('button', { name: '第 3 组' }).click()
  const group = panel.getByRole('region', { name: '镜头组 3', exact: true })
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 1 的描述' })).toContainText('低角度拍鞋面')
  const before = await readDocument(page)
  const third = before.document.shots[2]
  if (third === undefined) throw new Error('需要第三组')

  await panel
    .getByRole('button', { name: '生成设置：moyu-seedance-2-5，音频开启', exact: true })
    .click()
  const settings = page.getByRole('dialog', { name: '生成设置', exact: true })
  await settings.getByRole('radio', { name: 'wan3.0-video', exact: true }).click()
  await settings.getByRole('switch', { name: '生成音频', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  const posted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/generations/video',
  )
  await panel.getByRole('button', { name: '生成视频', exact: true }).click()
  const request = await posted
  expect(request.postDataJSON()).toEqual({
    aspect_ratio: before.document.aspect_ratio,
    conversation_id: new URL(page.url()).pathname.split('/').at(-1),
    generate_audio: false,
    model: 'wan3.0-video',
    reference_image_urls: third.image_urls,
    seconds: third.seconds,
    shot: third.prompt,
    shot_index: 3,
  })
  await expect(panel.getByText('生成中 1', { exact: true })).toBeVisible()

  await panel.getByRole('button', { name: '生成记录', exact: true }).click()
  const records = panel.getByRole('complementary', { name: '生成记录', exact: true })
  await expect(records.getByRole('article')).toHaveCount(2)
  await expect(records.getByText('生成中…')).toBeVisible()
  // mock 三秒后出片，前端每五秒问一次。
  await expect(records.getByText('生成中…')).toBeHidden({ timeout: 15_000 })
  await expect(records.getByRole('button', { name: '下载视频' })).toHaveCount(2)
  await records.getByRole('button', { name: '下载视频' }).first().click()
  await expect(page.getByRole('menuitem', { name: '下载原片' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '下载水印版' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem', { name: '下载原片' })).toBeHidden()
})

test('帧工具里的编辑图片打开编辑器，关闭后焦点回到入口', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const panel = await openStoryboard(page)
  const group = panel.getByRole('region', { name: '镜头组 1', exact: true })
  await group.getByRole('img', { name: '镜头组 1 第 1 帧' }).hover()
  const entry = group.getByRole('button', { name: '编辑图片', exact: true })
  await entry.click()
  const editor = page.getByRole('dialog', { name: '编辑图片', exact: true })
  await expect(editor).toBeVisible()
  await expect(editor.getByText('镜头组 1 · 帧 @1')).toBeVisible()
  await expect(editor.getByLabel('图片模型', { exact: true })).toBeVisible()
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-reader/image-edit-entry-desktop.png',
  })
  await editor.getByRole('button', { name: '关闭图片编辑', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(entry).toBeFocused()
})
