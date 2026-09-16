/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { login } from './login'

/** mock 受理后 3 秒出结果；切片、编辑、合成三步串起来要等三轮。 */
const STEP_TIMEOUT = 15_000
const SHOT_DIR = '../.artifacts/design-qa/video-editor'

const openEditor = async (page: Page, mobile = false) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  // 紧凑屏右侧面板默认收着，编辑器挂在面板里，得先打开它。
  if (mobile) await page.getByRole('button', { name: '打开右侧面板' }).click()
  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await panel.getByRole('button', { name: '第 2 组' }).click()
  await panel.getByRole('button', { name: '生成记录', exact: true }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await records.getByRole('button', { name: /^编辑视频/ }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频/ })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]video=/)
  return dialog
}

/** 等待浏览器完成 seek，区分精确的逻辑边界与边界内的媒体时间。 */
const expectPausedAt = async (dialog: Locator, clock: number, mediaTime = clock) => {
  await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect(dialog.getByRole('slider', { name: '时间线播放位置' })).toHaveValue(String(clock))
  await expect
    .poll(() =>
      dialog.getByLabel('视频播放器', { exact: true }).evaluate((element) => {
        const video = element as HTMLVideoElement
        return { paused: video.paused, seeking: video.seeking, time: video.currentTime }
      }),
    )
    .toMatchObject({ paused: true, seeking: false, time: expect.closeTo(mediaTime, 2) })
}

const dragBoundary = async (
  page: Page,
  dialog: Locator,
  boundary: 'start' | 'end',
  clock: number,
) => {
  const handle = dialog.getByRole('slider', {
    name: boundary === 'start' ? '选段开始时间' : '选段结束时间',
  })
  await handle.scrollIntoViewIfNeeded()
  const handleBox = await handle.boundingBox()
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const rulerBox = await ruler.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(rulerBox).not.toBeNull()
  if (handleBox === null || rulerBox === null) throw new Error('时间线尚未布局')
  const duration = Number(await ruler.getAttribute('max'))
  const y = handleBox.y + handleBox.height / 2
  await page.mouse.move(handleBox.x + handleBox.width / 2, y)
  await page.mouse.down()
  await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await page.mouse.move(rulerBox.x + (clock / duration) * rulerBox.width, y, { steps: 4 })
}

test('选段播放：到终点停止，暂停继续与结束重播保留正确起点', async ({ page }) => {
  const dialog = await openEditor(page)
  const start = dialog.getByLabel('开始时间（秒）')
  const end = dialog.getByLabel('结束时间（秒）')
  await expect(start).toBeEnabled({ timeout: STEP_TIMEOUT })
  await start.fill('1')
  await expectPausedAt(dialog, 1)
  await end.fill('2.3')
  await expectPausedAt(dialog, 2.3, 2.299)

  const video = dialog.getByLabel('视频播放器', { exact: true })
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1.15)
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
  const pausedTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime)
  expect(pausedTime).toBeLessThan(2.3)
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  expect(
    await video.evaluate((element) => (element as HTMLVideoElement).currentTime),
  ).toBeGreaterThanOrEqual(pausedTime - 0.01)
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(pausedTime + 0.1)
  await expectPausedAt(dialog, 2.3, 2.299)

  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement
        return !media.paused && media.currentTime >= 1 && media.currentTime < 1.5
      }),
    )
    .toBe(true)
  await expectPausedAt(dialog, 2.3, 2.299)
})

test('选段定位：播放中拖动两端立即暂停，边界限制、键盘和数字输入同步预览', async ({ page }) => {
  const dialog = await openEditor(page)
  const start = dialog.getByLabel('开始时间（秒）')
  const end = dialog.getByLabel('结束时间（秒）')
  await expect(start).toBeEnabled({ timeout: STEP_TIMEOUT })
  await start.fill('1')
  await end.fill('5')
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() =>
      dialog
        .getByLabel('视频播放器', { exact: true })
        .evaluate((element) => !(element as HTMLVideoElement).paused),
    )
    .toBe(true)

  await dragBoundary(page, dialog, 'start', 2)
  await expect(start).toHaveValue('2')
  await expectPausedAt(dialog, 2)
  await page.mouse.up()
  await expectPausedAt(dialog, 2)

  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() =>
      dialog
        .getByLabel('视频播放器', { exact: true })
        .evaluate((element) => !(element as HTMLVideoElement).paused),
    )
    .toBe(true)
  await dragBoundary(page, dialog, 'end', 3.5)
  await expect(end).toHaveValue('3.5')
  await expectPausedAt(dialog, 3.5, 3.499)
  await page.mouse.up()
  await expectPausedAt(dialog, 3.5, 3.499)

  // 拖过另一端时使用最终 clamp 后的位置，画面不能继续追随越界指针。
  await dragBoundary(page, dialog, 'start', 5)
  await expect(start).toHaveValue('3.4')
  await expectPausedAt(dialog, 3.4)
  await page.mouse.up()
  await start.fill('1')
  await expectPausedAt(dialog, 1)
  await dragBoundary(page, dialog, 'end', 0)
  await expect(end).toHaveValue('1.1')
  await expectPausedAt(dialog, 1.1, 1.099)
  await page.mouse.up()

  await end.fill('4')
  await expectPausedAt(dialog, 4, 3.999)
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowRight')
  await expect(start).toHaveValue('1.1')
  await expectPausedAt(dialog, 1.1)
  await dialog.getByRole('slider', { name: '选段结束时间' }).press('ArrowLeft')
  await expect(end).toHaveValue('3.9')
  await expectPausedAt(dialog, 3.9, 3.899)
})

test('从生成记录打开编辑器：切段、生成、预览、合成成为新版本', async ({ page }) => {
  // 三轮后台任务外，还验证跨素材播放、附件和多尺寸布局。
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1600, height: 1120 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })

  const modelPicker = dialog.getByRole('button', { name: '编辑模型', exact: true })
  await modelPicker.click()
  await expect(page.getByRole('menuitemradio', { name: 'moyu-seedance-2-5' })).toBeChecked()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(modelPicker).toHaveText('wan3.0-video')
  await expect(modelPicker).toBeFocused()
  await modelPicker.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(modelPicker).toBeFocused()

  await dialog.getByLabel('开始时间（秒）').fill('1')
  await dialog.getByLabel('结束时间（秒）').fill('4')
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowRight')
  await expect(dialog.getByLabel('开始时间（秒）')).toHaveValue('1.1')
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowLeft')
  await dialog.getByRole('textbox', { name: '修改要求' }).fill('换成浅灰背景，保留运镜。')
  const fileChooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: '添加参考图片', exact: true }).click()
  await (await fileChooser).setFiles('public/agent-icons/editor.png')
  const reference = dialog.getByRole('img', { name: 'editor.png', exact: true })
  await expect(reference).toBeVisible()
  const referenceUrl = await reference.getAttribute('src')

  const clipRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/clips') && request.method() === 'POST',
  )
  const editRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/video') && request.method() === 'POST',
    { timeout: STEP_TIMEOUT },
  )
  await dialog.getByRole('button', { name: '生成', exact: true }).click()

  expect((await clipRequest).postDataJSON()).toMatchObject({
    purpose: 'reference',
    segments: [{ start: 1, end: 4 }],
    metadata: { editStart: 1, editEnd: 4 },
  })
  // 参考片段切好后自动发编辑任务：结果跟着片段时长走，起点按片段实际时长反算（mock 片段 3 秒，恰好等长）。
  const edit = (await editRequest).postDataJSON() as Record<string, unknown>
  expect(edit).toMatchObject({
    model: 'wan3.0-video',
    prompt: '编辑视频，换成浅灰背景，保留运镜。',
    seconds: -1,
    metadata: { editStart: 1, editEnd: 4 },
  })
  expect(edit['reference_video_urls']).toEqual([expect.stringContaining('.webm')])
  expect(edit['reference_image_urls']).toEqual([referenceUrl])

  const summary = dialog.getByRole('status', { name: '视频编辑进度' })
  await expect(summary).toHaveText(/正在生成视频/, { timeout: STEP_TIMEOUT })
  await page.screenshot({ path: `${SHOT_DIR}/generation-running.png`, animations: 'disabled' })
  const openHistory = dialog.getByRole('button', { name: '历史', exact: true })
  await expect(summary).toHaveText(/待预览/, { timeout: STEP_TIMEOUT })
  await expect(summary.getByRole('listitem', { name: '结果预览，当前阶段' })).toHaveAttribute(
    'aria-current',
    'step',
  )
  await page.screenshot({ path: `${SHOT_DIR}/generation-ready.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 900 })
  const referenceBottom = await reference.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  )
  const uploadTop = await dialog
    .getByRole('button', { name: '添加参考图片', exact: true })
    .evaluate((element) => element.getBoundingClientRect().top)
  expect(referenceBottom).toBeLessThanOrEqual(uploadTop)
  await expect(summary).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: `${SHOT_DIR}/generation-compact.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: `${SHOT_DIR}/generation-laptop.png`, animations: 'disabled' })
  await expect(summary).toBeInViewport({ ratio: 1 })
  await page.setViewportSize({ width: 1600, height: 1120 })
  await openHistory.click()
  const history = page.getByRole('dialog', { name: '版本与任务', exact: true })
  await expect(history).toBeVisible()

  // 预览拼好的整条：原片放到 1 秒就该切到编辑结果那条，时钟接着走。
  const task = history.locator('details').filter({ hasText: 'V2' })
  await task.locator('summary').click()
  await task.getByRole('button', { name: '预览', exact: true }).click()
  await expect(history).toBeHidden()
  await expect(dialog.getByRole('button', { name: '切换版本', exact: true })).toHaveText('V2')
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await expect(dialog.getByRole('slider', { name: '选段开始时间' })).toHaveCount(0)
  const previewSource = await dialog.getByLabel('视频播放器', { exact: true }).getAttribute('src')
  expect(previewSource).not.toBeNull()
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    /sample-edited/,
    { timeout: 8000 },
  )
  // 待合成的预览没有选区限制：越过原来 4 秒的终点，继续播放第三段。
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    previewSource ?? '',
    { timeout: 8000 },
  )
  await expect
    .poll(async () =>
      Number(
        await dialog
          .getByRole('slider', {
            name: '时间线播放位置',
          })
          .inputValue(),
      ),
    )
    .toBeGreaterThan(4.1)
  await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()

  await openHistory.click()
  await expect(history).toBeVisible()
  const masterRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/clips') && request.method() === 'POST',
  )
  // 待预览的任务默认收着，展开才有操作。
  await task.locator('summary').click()
  const compose = task.getByRole('button', { name: '合成成片', exact: true })
  await expect(compose).toBeEnabled({ timeout: STEP_TIMEOUT })
  await compose.click()
  const master = (await masterRequest).postDataJSON() as { purpose: string; segments: unknown[] }
  expect(master.purpose).toBe('master')
  // 基底前段、编辑结果整条、基底后段。
  expect(master.segments).toEqual([
    expect.objectContaining({ start: 0, end: 1 }),
    expect.objectContaining({ start: 0, end: 3 }),
    expect.objectContaining({ start: 4, end: 6 }),
  ])
  await expect(history).toBeHidden()

  // 成片落地后 V2 从「生成任务」挪进「版本」，基于 V1；合成中那条同名，所以认的是版本区的这一条。
  await openHistory.click()
  await expect(history.getByRole('button', { name: 'V2 基于 V1', exact: true })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await history.getByRole('button', { name: 'V2 基于 V1', exact: true }).click()
  await expect(history).toBeHidden()
  const previewTabs = dialog.getByRole('group', { name: '预览版本' })
  const versionTab = previewTabs.getByRole('button', { name: 'V2', exact: true })
  await expect(versionTab).toHaveAttribute('aria-pressed', 'true')
  const versionSource = await dialog.getByLabel('视频播放器', { exact: true }).getAttribute('src')
  expect(versionSource).not.toBeNull()
  await previewTabs.getByRole('button', { name: '原片', exact: true }).click()
  await expect(previewTabs.getByRole('button', { name: '原片', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await dragBoundary(page, dialog, 'start', 2)
  await page.mouse.up()
  await expect(versionTab).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    versionSource ?? '',
  )
  await expectPausedAt(dialog, 2)
})

test('桌面、移动与深色布局各留一张截图', async ({ page }) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await dialog.getByRole('button', { name: '编辑模型', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/model-menu-light.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${SHOT_DIR}/desktop-light.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${SHOT_DIR}/desktop-dark.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: '编辑模型', exact: true }).click()
  await page.screenshot({ path: `${SHOT_DIR}/model-menu-dark.png`, animations: 'disabled' })
})

test('移动布局：对话框内部自己滚，页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await page.screenshot({ path: `${SHOT_DIR}/mobile-light.png`, animations: 'disabled' })
  await dialog
    .getByRole('textbox', { name: '修改要求' })
    .fill('按参考图调整背景和光线，保留鞋款细节与原有运镜，避免改变商品颜色和画面主体的位置。')
  await dialog.getByRole('button', { name: '编辑模型', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/model-menu-mobile.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: '生成', exact: true }).click()
  const status = dialog.getByRole('status', { name: '视频编辑进度' })
  await expect(status).toHaveText(/待预览/, { timeout: STEP_TIMEOUT })
  await status.scrollIntoViewIfNeeded()
  await expect(status).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: `${SHOT_DIR}/generation-mobile.png`, animations: 'disabled' })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('只有生成的记录才能进编辑；关掉编辑器回到生成记录，地址里不再带 video', async ({ page }) => {
  const dialog = await openEditor(page)
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/[?&]video=/)
  const records = page.getByRole('complementary', { name: '生成记录' })
  await expect(records).toBeVisible()
  // 第 2 组只有一条完成的出片，失败的那条没有入口。
  await expect(records.getByRole('button', { name: /^编辑视频/ })).toHaveCount(1)
})
