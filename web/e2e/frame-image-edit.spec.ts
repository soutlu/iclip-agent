/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ImageGenerationIn } from '../src/shared/api/generated/types.gen'
import { login } from './login'

const openEditor = async (page: Page, width = 1335) => {
  await page.setViewportSize({ height: 934, width })
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  if (width === 390) await page.getByRole('button', { name: '打开右侧面板' }).click()
  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const group = panel.getByRole('region', { name: '镜头组 2' })
  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  // 示例 agent 会改写整个分镜，先等它完成，避免干扰真实保存语义。
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    { timeout: 20_000 },
  )
  await group.getByRole('button', { name: '编辑图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑图片', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '椭圆标注' })).toBeEnabled()
  return { dialog, group, panel }
}

const drawEllipse = async (page: Page, dialog: Locator) => {
  await dialog.getByRole('button', { name: '椭圆标注' }).click()
  const canvas = dialog.getByRole('group', { name: '图片标注画布', exact: true })
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('图片标注画布必须可见')
  // 竖图居中 contain：以中心为基准绘制，避免点到两侧留白。
  await page.mouse.move(box.x + box.width / 2 - 25, box.y + box.height * 0.35)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height * 0.6, { steps: 8 })
  await page.mouse.up()
  await expect(canvas.getByRole('button', { name: '标注 1', exact: true })).toBeVisible()
  await canvas
    .getByRole('button', { name: '标注 1', exact: true })
    .locator('[data-annotation-label] rect')
    .click()
}

const drawPoint = async (page: Page, dialog: Locator) => {
  const canvas = dialog.getByRole('group', { name: '图片标注画布', exact: true })
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('图片标注画布必须可见')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.35)
  const mark = canvas.getByRole('button', { name: '标注 1', exact: true })
  await expect(mark).toHaveAttribute('data-annotation-kind', 'point')
  await expect(mark).toHaveAttribute('aria-pressed', 'false')
  await mark.locator('[data-annotation-label] rect').click()
  return { canvas, mark }
}

const selectInputs = async (page: Page, dialog: Locator, annotated: boolean) => {
  await dialog.getByRole('button', { name: '选择参考帧', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择参考帧', exact: true })
  await picker.getByRole('button', { name: '添加参考帧 1', exact: true }).click()
  if (annotated) await picker.getByRole('button', { name: '加入当前标注图' }).click()
  await picker.getByRole('button', { name: '完成选择' }).click()
}

const writeInstructions = async (page: Page, dialog: Locator) => {
  const editor = dialog.getByRole('textbox', { name: '修改要求' })
  await editor.fill('把')
  await dialog.getByRole('button', { name: '引用选中标注' }).click()
  await expect(editor.getByRole('button', { name: '标注 1', exact: true })).toBeVisible()
  await page.keyboard.insertText('中的颜色改成')
  await page.keyboard.type('@')
  await dialog.getByRole('option', { name: '插入参考图 1 · 帧 @1', exact: true }).click()
  await page.keyboard.insertText('的暖色，保留人物姿势和画面构图。')
  await expect(editor.getByRole('button', { name: '参考图 1 · 帧 @1' })).toBeVisible()
  return editor
}

test('标注引用与用户图片顺序提交，候选须明确采用后才替换帧，视频记录不变', async ({ page }) => {
  const { dialog, panel } = await openEditor(page)
  const originalImage = page.locator('img[alt="镜头组 2 第 2 帧"]')
  const originalUrl = await originalImage.getAttribute('src')
  await drawEllipse(page, dialog)
  await selectInputs(page, dialog, true)
  const editor = await writeInstructions(page, dialog)
  await dialog.getByRole('button', { name: '参考图 2 向前移' }).click()
  await expect(editor.getByRole('button', { name: '参考图 2 · 帧 @1' })).toBeVisible()
  await editor.getByRole('button', { name: '标注 1', exact: true }).click()
  await expect(
    dialog.getByRole('group', { name: '图片标注画布' }).getByRole('button', { name: '标注 1' }),
  ).toHaveAttribute('aria-pressed', 'true')

  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/generations',
  )
  await dialog.getByRole('button', { name: '生成编辑结果' }).click()
  const body = (await submitted).postDataJSON() as ImageGenerationIn
  expect(body.kind).toBe('image')
  expect(body.frameEdit?.frameNumber).toBe(2)
  expect(body.frameEdit?.sourceUrl).toBe(originalUrl)
  expect(body.frameEdit?.annotations).toHaveLength(1)
  expect(body.frameEdit?.references.map((reference) => reference.kind)).toEqual([
    'annotated',
    'image',
  ])
  expect(body.referenceImageUrls).toEqual(
    body.frameEdit?.references.map((reference) => reference.url),
  )
  expect(body.referenceImageUrls).toHaveLength(2)
  expect(body.referenceImageUrls?.[0]).toContain('/mock-oss/')
  expect(body.referenceImageUrls?.[1]).toContain('/mock-frames/a.png')
  await expect(dialog.getByRole('button', { name: '编辑结果', exact: true })).toBeEnabled({
    timeout: 15_000,
  })
  await expect(originalImage).toHaveAttribute('src', originalUrl ?? '')
  await expect(dialog.getByText('结果尚未应用', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '编辑结果', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '图片编辑结果' })).toHaveAttribute(
    'src',
    /\/mock-frames\/c.png$/,
  )
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/frame-image-editor/result-desktop.png',
  })
  await dialog.getByRole('button', { name: '原图', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '编辑前的原图' })).toHaveAttribute(
    'src',
    originalUrl ?? '',
  )
  await dialog.getByRole('button', { name: '编辑结果', exact: true }).click()
  const saved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/workspace/file'),
  )
  await dialog.getByRole('button', { name: '应用到当前帧' }).click()
  await saved
  await expect(dialog).toBeHidden()
  await expect(originalImage).toHaveAttribute('src', /\/mock-frames\/c.png$/)
  await expect(panel.getByText('已保存', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '生成记录', exact: true }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await expect(records.getByRole('article')).toHaveCount(3)
  await expect(records.getByRole('article').filter({ hasText: '生成完成' })).toHaveCount(1)
})

test('标注引用缺少标注图时阻止提交，删除标注后引用明确失效', async ({ page }) => {
  const { dialog } = await openEditor(page)
  let submitted = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/generations')
      submitted += 1
  })
  await drawEllipse(page, dialog)
  await selectInputs(page, dialog, false)
  const editor = await writeInstructions(page, dialog)
  await dialog.getByRole('button', { name: '生成编辑结果' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('引用标注时，请在图片列表中加入标注图')
  await expect(
    dialog.getByRole('list', { name: '提交图片顺序' }).getByRole('listitem'),
  ).toHaveCount(1)
  expect(submitted).toBe(0)
  await dialog.getByRole('button', { name: '删除标注' }).click()
  await expect(editor.getByRole('button', { name: '标注已失效' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await dialog.getByRole('button', { name: '生成编辑结果' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('修改要求中有已删除的标注，请处理失效引用')
  expect(submitted).toBe(0)
})

for (const width of [1335, 390]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`图片编辑 ${width}px ${colorScheme}：画布、引用输入和操作可用`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      const { dialog } = await openEditor(page, width)
      await drawPoint(page, dialog)
      await selectInputs(page, dialog, true)
      await writeInstructions(page, dialog)
      await expect(dialog).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByRole('button', { name: '生成编辑结果' })).toBeInViewport({
        ratio: 1,
      })
      await expect(dialog.getByRole('button', { name: '关闭图片编辑' })).toBeInViewport({
        ratio: 1,
      })
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/annotation-tools/editor-${width}-${colorScheme}.png`,
      })
      if (width === 390) {
        await dialog.getByRole('group', { name: '图片标注编辑器' }).scrollIntoViewIfNeeded()
        await page.screenshot({
          animations: 'disabled',
          path: `../.artifacts/design-qa/annotation-tools/canvas-${width}-${colorScheme}.png`,
        })
      }
      await dialog.getByRole('button', { name: '关闭图片编辑' }).focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()
    })
  }
}

test('点标注支持编号引用和拖动，取消选择不新增，连续点击保持点工具', async ({ page }) => {
  const { dialog } = await openEditor(page)
  const toolbar = dialog.getByRole('toolbar', { name: '标注工具' })
  await expect(toolbar.getByRole('button').first()).toHaveAccessibleName('点标注')
  await expect(toolbar.getByRole('button', { name: '点标注', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(toolbar.getByRole('button', { name: '引用选中标注' })).toHaveCount(0)
  const { canvas, mark } = await drawPoint(page, dialog)
  await expect(mark.locator('[data-handle]')).toHaveCount(0)
  const target = mark.locator('[data-annotation-outline] circle')
  const before = await target.boundingBox()
  const badge = await mark.locator('[data-annotation-label] rect').boundingBox()
  if (before === null || badge === null) throw new Error('定位点和编号必须可见')
  await page.mouse.move(badge.x + badge.width / 2, badge.y + badge.height / 2)
  await page.mouse.down()
  await page.mouse.move(badge.x + badge.width / 2 + 30, badge.y + badge.height / 2 + 24, {
    steps: 5,
  })
  await page.mouse.up()
  const after = await target.boundingBox()
  if (after === null) throw new Error('移动后定位点必须可见')
  expect(after.x - before.x).toBeCloseTo(30, 0)
  expect(after.y - before.y).toBeCloseTo(24, 0)
  // 靶心中心也必须命中标注，不能穿透成取消选择或新增重叠点。
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2)
  await page.mouse.down()
  await page.mouse.move(after.x + after.width / 2 + 12, after.y + after.height / 2 + 10, {
    steps: 4,
  })
  await page.mouse.up()
  const movedFromCenter = await target.boundingBox()
  if (movedFromCenter === null) throw new Error('从中心拖动后定位点必须可见')
  expect(movedFromCenter.x - after.x).toBeCloseTo(12, 0)
  expect(movedFromCenter.y - after.y).toBeCloseTo(10, 0)
  await expect(canvas.getByRole('button')).toHaveCount(1)
  await expect(mark).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: '引用选中标注' }).click()
  await expect(
    dialog.getByRole('textbox', { name: '修改要求' }).getByRole('button', { name: '标注 1' }),
  ).toBeVisible()
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('图片标注画布必须可见')
  const empty = { x: box.x + box.width / 2, y: box.y + box.height * 0.7 }
  await page.mouse.click(empty.x, empty.y)
  await expect(canvas.getByRole('button')).toHaveCount(1)
  await expect(mark).toHaveAttribute('aria-pressed', 'false')
  await expect(dialog.getByRole('button', { name: '引用选中标注' })).toHaveCount(0)
  await page.mouse.click(empty.x, empty.y)
  await expect(canvas.getByRole('button')).toHaveCount(2)
  await page.mouse.click(empty.x + 45, empty.y - 60)
  await expect(canvas.getByRole('button')).toHaveCount(3)
  await expect(toolbar.getByRole('button', { name: '点标注', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await mark.locator('[data-annotation-label] rect').click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(mark).toHaveAttribute('aria-pressed', 'false')
  await expect(canvas.getByRole('button')).toHaveCount(3)
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height * 0.85)
  await page.mouse.down()
  await expect(canvas.locator('[data-annotation-kind="point"]')).toHaveCount(4)
  await expect(canvas.getByRole('button', { name: '标注 4', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(dialog).toBeVisible()
  await expect(canvas.locator('[data-annotation-kind="point"]')).toHaveCount(3)
  await expect(canvas.getByRole('button')).toHaveCount(3)
  await selectInputs(page, dialog, true)
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/generations',
  )
  await dialog.getByRole('button', { name: '生成编辑结果' }).click()
  const body = (await submitted).postDataJSON() as ImageGenerationIn
  expect(body.frameEdit?.annotations).toHaveLength(3)
  for (const annotation of body.frameEdit?.annotations ?? []) {
    expect(annotation.kind).toBe('point')
    expect(annotation.points).toHaveLength(1)
    expect(annotation.points[0]?.x).toBeGreaterThanOrEqual(0)
    expect(annotation.points[0]?.x).toBeLessThanOrEqual(1)
    expect(annotation.points[0]?.y).toBeGreaterThanOrEqual(0)
    expect(annotation.points[0]?.y).toBeLessThanOrEqual(1)
  }
  expect(body.frameEdit?.instructions).toContainEqual({
    kind: 'annotation',
    id: body.frameEdit?.annotations?.[0]?.id,
  })
})

test('画笔连续绘制平滑笔迹，松手后出现编号，选中时没有四角手柄', async ({ page }) => {
  const { dialog } = await openEditor(page)
  await dialog.getByRole('button', { name: '自由画笔', exact: true }).click()
  const canvas = dialog.getByRole('group', { name: '图片标注画布', exact: true })
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('图片标注画布必须可见')
  for (const number of [1, 2]) {
    const start = { x: box.x + box.width / 2 - 55, y: box.y + box.height * (0.2 * number) }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 30, start.y - 10, { steps: 4 })
    await page.mouse.move(start.x + 65, start.y + 20, { steps: 4 })
    await page.mouse.move(start.x + 110, start.y + 15, { steps: 4 })
    await expect(canvas.getByRole('button', { name: `标注 ${number}`, exact: true })).toHaveCount(0)
    await page.mouse.up()
    await expect(canvas.getByRole('button', { name: `标注 ${number}`, exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '自由画笔', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }
  const first = canvas.getByRole('button', { name: '标注 1', exact: true })
  await first.locator('[data-annotation-label] rect').click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(first.locator('[data-handle]')).toHaveCount(0)
  await expect(first.locator('[data-annotation-outline] path')).toHaveAttribute('d', /Q/)
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/annotation-tools/pen-desktop.png',
  })
})

test('参考图区支持点击上传、拖放上传和键盘排序，移除图片会使原引用失效', async ({ page }) => {
  const { dialog } = await openEditor(page, 390)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 360
    canvas.height = 640
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('图片夹具需要 Canvas 2D')
    context.fillStyle = '#dfe8dd'
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1] ?? ''
  })
  const buffer = Buffer.from(png, 'base64')
  const pickerOpened = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: /拖放图片到这里/ }).click()
  await (await pickerOpened).setFiles({ buffer, mimeType: 'image/png', name: '衣服参考.png' })
  const order = dialog.getByRole('list', { name: '提交图片顺序' })
  await expect(order.getByRole('listitem')).toHaveCount(1)
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(bytes)], '背景参考.png', { type: 'image/png' }))
    return data
  }, Array.from(buffer))
  await dialog.locator('.image-edit-dropzone').dispatchEvent('drop', { dataTransfer: transfer })
  await transfer.dispose()
  await expect(order.getByRole('listitem')).toHaveCount(2)
  const editor = dialog.getByRole('textbox', { name: '修改要求' })
  await editor.fill('参考这张图片的服装颜色：')
  await order.getByRole('button', { name: '参考图 1 · 衣服参考.png', exact: true }).click()
  await expect(editor.getByRole('button', { name: '参考图 1 · 衣服参考.png' })).toBeVisible()
  await order.getByRole('button', { name: '参考图 2 向前移' }).focus()
  await page.keyboard.press('Enter')
  await expect(editor.getByRole('button', { name: '参考图 2 · 衣服参考.png' })).toBeVisible()
  await order.scrollIntoViewIfNeeded()
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/frame-image-editor/upload-mobile.png',
  })
  await order.getByRole('button', { name: '移除参考图 2' }).click()
  await expect(editor.getByRole('button', { name: '参考图已失效' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await dialog.getByRole('button', { name: '生成编辑结果' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('修改要求中有已移除的图片，请处理失效引用')
})
