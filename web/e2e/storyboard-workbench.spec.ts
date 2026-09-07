/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

// 在浏览器验证 scroll-snap 翻组；视口需容纳 264px 侧栏、400px 聊天和 560px 面板。
test.use({ viewport: { height: 900, width: 1600 } })

const framePng = async (page: Page) => {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 800
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('测试图片需要 Canvas 2D')
    context.fillStyle = '#dfe8dd'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#23503e'
    context.fillRect(70, 180, 460, 440)
    context.font = '36px sans-serif'
    context.fillStyle = '#ffffff'
    context.fillText('Local frame', 180, 420)
    return canvas.toDataURL('image/png').split(',')[1] ?? ''
  })
  return Buffer.from(base64, 'base64')
}

test('点开有分镜的对话：滚轮翻到第 2 组，看生成记录，点镜头缩略图切帧', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('tab', { name: '分镜', selected: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('region', { name: '镜头组 1' }).hover()
  await page.mouse.wheel(0, 700)
  await expect(page).toHaveURL(/shot=2/)
  await expect(panel.getByRole('button', { name: '第 2 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('button', { name: '生成记录' }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await expect(records.getByRole('radio', { name: '视频生成记录 3' })).toBeVisible()
  await expect(records.getByText('生成中…')).toBeVisible()
  await records.getByRole('button', { name: '关闭生成记录' }).click()

  const page2 = panel.getByRole('region', { name: '镜头组 2' })
  await page2
    .getByRole('navigation', { name: '本组镜头' })
    .getByRole('button', { name: '镜头 2', exact: true })
    .click()
  await expect(page).toHaveURL(/frame=2/)
  await expect(page2.getByRole('img', { name: '镜头组 2 第 2 帧' })).toBeVisible()
})

test('短桌面中首帧卡片在原位展开，预览与底部导航均完整可见且可键盘切帧', async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 1600 })
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const group = panel.getByRole('region', { name: '镜头组 2' })
  const navigation = group.getByRole('navigation', { name: '本组镜头' })
  const secondSceneButton = navigation.getByRole('button', { name: '镜头 2', exact: true })
  await secondSceneButton.focus()
  await page.keyboard.press('Enter')

  const preview = group.getByRole('img', { name: '镜头组 2 第 2 帧' })
  const firstScene = navigation.getByRole('group', { name: '镜头 1', exact: true })
  const expandedScene = navigation.getByRole('group', { name: '镜头 2', exact: true })
  const firstFrame = expandedScene.getByRole('button', { name: '预览第 2 帧' })
  const lastFrame = expandedScene.getByRole('button', { name: '预览第 3 帧' })
  await expect(preview).toBeInViewport({ ratio: 1 })
  await expect(navigation).toBeInViewport({ ratio: 1 })
  await expect(firstScene).toBeInViewport({ ratio: 1 })
  await expect(lastFrame).toBeInViewport({ ratio: 1 })
  await expect(group.getByRole('button', { name: '完整提示词' })).toBeInViewport({ ratio: 1 })

  const [
    groupBox,
    previewBox,
    navigationBox,
    firstSceneBox,
    expandedBox,
    firstFrameBox,
    lastFrameBox,
  ] = await Promise.all([
    group.boundingBox(),
    preview.boundingBox(),
    navigation.boundingBox(),
    firstScene.boundingBox(),
    expandedScene.boundingBox(),
    firstFrame.boundingBox(),
    lastFrame.boundingBox(),
  ])
  if (
    groupBox === null ||
    previewBox === null ||
    navigationBox === null ||
    firstSceneBox === null ||
    expandedBox === null ||
    firstFrameBox === null ||
    lastFrameBox === null
  ) {
    throw new Error('分镜预览和底部展开导航必须有可见布局')
  }
  expect(previewBox.height).toBeGreaterThan(0)
  expect(previewBox.y).toBeGreaterThanOrEqual(groupBox.y)
  expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(navigationBox.y)
  expect(navigationBox.y + navigationBox.height).toBeLessThanOrEqual(groupBox.y + groupBox.height)
  expect(firstSceneBox.x + firstSceneBox.width).toBeLessThanOrEqual(expandedBox.x)
  expect(firstFrameBox.x + firstFrameBox.width).toBeLessThanOrEqual(lastFrameBox.x)
  expect(firstFrameBox.y).toBe(lastFrameBox.y)
  expect(lastFrameBox.x + lastFrameBox.width).toBeLessThanOrEqual(expandedBox.x + expandedBox.width)
  for (const box of [previewBox, navigationBox]) {
    expect(box.x).toBeGreaterThanOrEqual(groupBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(groupBox.x + groupBox.width)
  }

  await firstFrame.focus()
  await page.keyboard.press('Tab')
  await expect(lastFrame).toBeFocused()
  await page.keyboard.press('Space')
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
  await expect(lastFrame).toHaveAttribute('aria-pressed', 'true')

  await group.getByRole('button', { name: '看第 2 帧' }).focus()
  await page.keyboard.press('Enter')
  await expect(preview).toBeVisible()
  await expect(firstFrame).toHaveAttribute('aria-pressed', 'true')
})

test.describe('移动触屏分镜', () => {
  test.use({ hasTouch: true, isMobile: true })

  test('选中的末帧完整显示，替换图标可直接点开文件选择器', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    await page.goto('/')
    await login(page)
    await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
    await page.getByRole('button', { name: '打开右侧面板' }).click()

    const panel = page.getByRole('complementary', { name: '右侧面板' })
    await panel.getByRole('button', { name: '第 2 组' }).click()
    const group = panel.getByRole('region', { name: '镜头组 2' })
    const navigation = group.getByRole('navigation', { name: '本组镜头' })
    await navigation.getByRole('button', { name: '镜头 2', exact: true }).click()
    const lastFrame = navigation.getByRole('button', { name: '预览第 3 帧' })
    await lastFrame.click()

    await expect(lastFrame).toHaveAttribute('aria-pressed', 'true')
    await expect(lastFrame).toBeInViewport({ ratio: 1 })
    await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
    await expect(navigation).toBeInViewport({ ratio: 1 })
    await expect(group.getByRole('button', { name: '加一帧' })).toBeInViewport({ ratio: 1 })
    await expect(group.getByRole('button', { name: '完整提示词' })).toBeInViewport({ ratio: 1 })

    const replaceImage = group.getByRole('button', { name: '替换图片' })
    await expect(replaceImage).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: '../.artifacts/design-qa/storyboard-replace-touch.png' })
    const fileChooserOpened = page.waitForEvent('filechooser')
    await replaceImage.tap()
    await fileChooserOpened
  })
})

// MSW 会话随整页加载清空，无法直接验证带参数刷新；此处验证程序化跳页不被中间滚动事件覆盖。
test('点页码点跳组：地址落在那一组不回弹，帧号照样点得动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('button', { name: '第 3 组' }).click()
  await expect(panel.getByRole('region', { name: '镜头组 3' })).toBeInViewport()
  await expect(page).toHaveURL(/shot=3/)

  // 防止平滑滚动的中间位置覆盖目标页查询参数。
  await expect(panel.getByRole('button', { name: '第 3 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('button', { name: '第 2 组' }).click()
  await expect(panel.getByRole('region', { name: '镜头组 2' })).toBeInViewport()
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })
  await shot2
    .getByRole('navigation', { name: '本组镜头' })
    .getByRole('button', { name: '镜头 2', exact: true })
    .click()
  await shot2.getByRole('button', { name: '看第 3 帧' }).click()
  await expect(page).toHaveURL(/frame=3/)
  await expect(shot2.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
})

test('agent 改了文件：重读之后描述更新并标出改动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('button', { name: '第 2 组' }).click()
  await panel
    .getByRole('region', { name: '镜头组 2' })
    .getByRole('navigation', { name: '本组镜头' })
    .getByRole('button', { name: '镜头 2', exact: true })
    .click()
  await expect(panel.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    { timeout: 20_000 },
  )
  await expect(panel.getByText('agent 刚改过')).toBeVisible()
})

test('替换图标与拖放都可上传本地图片，保持当前帧并可继续编辑', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })

  await shot2
    .getByRole('navigation', { name: '本组镜头' })
    .getByRole('button', { name: '镜头 2', exact: true })
    .click()
  await expect(page).toHaveURL(/frame=2/)
  const preview = shot2.getByRole('img', { name: '镜头组 2 第 2 帧' })
  const imageArea = shot2.getByRole('group', { name: '当前帧图片' })
  const png = await framePng(page)
  await page.context().route('http://localhost/mock-oss/**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ body: png, contentType: 'image/png' })
    } else {
      await route.continue()
    }
  })
  await preview.hover()
  const replaceImage = shot2.getByRole('button', { name: '替换图片' })
  await expect(replaceImage).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: '../.artifacts/design-qa/storyboard-replace-hover.png' })
  await replaceImage.focus()
  await expect(replaceImage).toBeFocused()
  const fileChooserOpened = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  const fileChooser = await fileChooserOpened
  await fileChooser.setFiles({ buffer: png, mimeType: 'image/png', name: '新帧.png' })
  await expect(page).toHaveURL(/frame=2/)
  await expect(preview).toHaveAttribute('src', /\/mock-oss\//)
  await expect(preview).toHaveJSProperty('naturalWidth', 600)
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
  const uploadedUrl = await preview.getAttribute('src')

  const dataTransfer = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], '拖入帧.png', { type: 'image/png' }))
    return transfer
  }, Array.from(png))
  await imageArea.dispatchEvent('dragenter', { dataTransfer })
  await expect(imageArea.getByText('松开替换当前图片')).toBeVisible()
  await expect(page.getByText('松开鼠标添加附件')).toBeHidden()
  await page.screenshot({ path: '../.artifacts/design-qa/storyboard-replace-drop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-replace-drop-dark.png',
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await imageArea.dispatchEvent('drop', { dataTransfer })
  await expect(preview).not.toHaveAttribute('src', uploadedUrl ?? '')
  await expect(preview).toHaveAttribute('src', /\/mock-oss\//)
  await expect(preview).toHaveJSProperty('naturalWidth', 600)
  await expect(page).toHaveURL(/frame=2/)
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('拖入帧.png', { exact: true })).toBeHidden()
  await dataTransfer.dispose()

  const editor = shot2.getByRole('textbox', { name: '镜头 2 的描述' })
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('镜头缓慢推进。')
  await expect(editor).toContainText('镜头缓慢推进。')
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
})

test('点「生成视频」：状态走到出片完成，生成记录里多一条', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  // 仅第 1 组没有生成任务；第 2 组运行中，第 3 组已有成片。
  const shot1 = panel.getByRole('region', { name: '镜头组 1' })
  await shot1.getByRole('button', { name: '生成视频' }).click()
  await expect(shot1.getByRole('button', { name: '正在出片…' })).toBeDisabled()

  await panel.getByRole('button', { name: '生成记录' }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await expect(records.getByText('生成中…')).toBeVisible()

  await expect(records.getByText('生成完成')).toBeVisible({ timeout: 15_000 })
  await records.getByRole('button', { name: '关闭生成记录' }).click()
  await expect(shot1.getByRole('button', { name: '生成视频' })).toBeEnabled()
})

test('「全部镜头组」全选之后批量出片：确认框写清条数', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('button', { name: '全部镜头组' }).click()
  const sheet = panel.getByRole('complementary', { name: '全部镜头组' })
  await sheet.getByRole('button', { name: '全选' }).click()
  await expect(sheet.getByText('已选 3 个')).toBeVisible()

  await sheet.getByRole('button', { name: '生成选中的 3 组' }).click()
  const confirm = page.getByRole('dialog', { name: '确认批量出片' })
  await expect(confirm.getByText(/3 组/)).toBeVisible()
  await confirm.getByRole('button', { name: '发出去' }).click()

  // 第 1 组新生成、第 3 组原有成片；运行中的第 2 组跳过提交。
  await expect(sheet.getByRole('img', { name: '已出片' })).toHaveCount(2, { timeout: 20_000 })
  await expect(sheet.getByRole('img', { name: '正在出片' })).toHaveCount(1)
})

for (const viewport of [
  { height: 700, width: 1600 },
  { height: 844, width: 390 },
]) {
  test(`完整提示词面板 ${viewport.width}px：原文与参考图可读，收起保留帧与焦点`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: viewport.width < 600 ? 'light' : 'dark' })
    await page.goto('/')
    await login(page)
    await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
    if (viewport.width < 600) {
      await page.getByRole('button', { name: '打开右侧面板' }).click()
    }

    const panel = page.getByRole('complementary', { name: '右侧面板' })
    await panel.getByRole('button', { name: '第 2 组' }).click()
    const group = panel.getByRole('region', { name: '镜头组 2' })
    await group
      .getByRole('navigation', { name: '本组镜头' })
      .getByRole('button', { name: '镜头 2', exact: true })
      .click()
    await group.getByRole('button', { name: '预览第 3 帧' }).click()
    const trigger = group.getByRole('button', { name: '完整提示词', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')

    const sheet = panel.getByRole('complementary', { name: '镜头组完整提示词' })
    const original = sheet.getByRole('region', { name: '镜头组原文' })
    await expect(sheet).toBeVisible()
    await expect(original).toBeFocused()
    await expect(original).toContainText('参考锁定：模特的服装与发型跟住 @Image1。')
    await expect(original).toContainText('剪辑形式：硬切。')
    await expect(original).toContainText('[0–4秒｜镜头1]')
    await expect(original).toContainText('[4–11秒｜镜头2]')
    await expect(sheet.getByRole('button', { name: '复制完整提示词' })).toBeInViewport({
      ratio: 1,
    })
    await page.screenshot({
      path: `../.artifacts/design-qa/shot-group-prompt/${viewport.width < 600 ? 'mobile' : 'desktop-dark'}-mock.png`,
    })
    const lastReference = sheet.getByRole('button', { name: '查看参考图 @Image3', exact: true })
    await lastReference.scrollIntoViewIfNeeded()
    await expect(lastReference).toBeInViewport({ ratio: 1 })
    await lastReference.click()
    const preview = page.getByRole('dialog', { name: '参考图 @Image3', exact: true })
    await expect(preview).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview).toBeHidden()
    await expect(sheet).toBeVisible()
    await expect(lastReference).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(trigger).toBeFocused()
    const search = new URL(page.url()).searchParams
    expect(search.get('shot')).toBe('2')
    expect(search.get('frame')).toBe('3')
    expect(search.has('sheet')).toBe(false)
    await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport()
  })
}

test('选中即上下文：输入框上出现芯片，× 掉不再回来，发出去的正文带前缀', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('button', { name: '第 1 组' })).toHaveAttribute(
    'aria-current',
    'true',
  )

  await panel.getByRole('button', { name: '第 2 组' }).click()
  const chip = page.getByText('镜头组 2', { exact: true })
  await expect(chip).toBeVisible()

  await page.getByRole('button', { name: '不再引用 镜头组 2' }).click()
  await expect(chip).toBeHidden()

  await panel.getByRole('button', { name: '第 1 组' }).click()
  await panel.getByRole('button', { name: '第 2 组' }).click()
  await expect(chip).toBeVisible()

  const composer = page.getByLabel('输入消息')
  await composer.click()
  await page.keyboard.type('把这一组的节奏放慢')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('针对镜头组 2：').first()).toBeVisible()
})

test('没有工作区文件的对话仍是折叠空态', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '亚麻衬衫二剪', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  await expect(page.getByRole('button', { name: '打开右侧面板' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '分镜' })).toBeHidden()
})
