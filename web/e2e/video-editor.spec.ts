/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { login } from './login'

const SHOT_DIR = '../.artifacts/design-qa/video-editor'
const REFERENCE_IMAGE = 'public/images/video-editor-demo.webp'

test.use({ viewport: { width: 1600, height: 1120 }, colorScheme: 'light' })

const timeline = (page: Page) => page.getByRole('region', { name: '视频编辑时间线', exact: true })
const history = (page: Page) => page.getByRole('dialog', { name: '版本与任务', exact: true })
const versionTrigger = (page: Page) =>
  timeline(page).getByRole('button', { name: '切换版本', exact: true })
const versionMenu = (page: Page) => page.getByRole('menu', { name: '视频版本', exact: true })
const taskOf = (dialog: Locator, version: string) =>
  dialog
    .locator('details')
    .filter({ has: dialog.page().locator('summary').filter({ hasText: version }) })

async function openVersions(page: Page) {
  await versionTrigger(page).click()
  await expect(versionMenu(page)).toBeVisible()
  return versionMenu(page)
}

async function closeVersions(page: Page) {
  await page.keyboard.press('Escape')
  await expect(versionMenu(page)).toBeHidden()
  await expect(versionTrigger(page)).toBeFocused()
}

async function chooseVersion(page: Page, label: string) {
  const menu = await openVersions(page)
  await menu.getByRole('menuitemradio', { name: label, exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(versionTrigger(page)).toHaveText(label)
}

async function expectVersionCount(page: Page, count: number) {
  const menu = await openVersions(page)
  await expect(menu.getByRole('menuitemradio')).toHaveCount(count)
  await closeVersions(page)
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: '历史', exact: true }).click()
  await expect(history(page)).toBeVisible()
  return history(page)
}

async function readyTask(page: Page, version: string) {
  const dialog = await openHistory(page)
  const task = taskOf(dialog, version)
  await expect(task.locator('summary')).toContainText('待预览', { timeout: 12_000 })
  await task.locator('summary').click()
  await expect(task.getByRole('button', { name: '预览', exact: true })).toBeVisible()
  return task
}

test('完成记录进入视频编辑页，原视频与返回记录位置保留', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await panel.getByRole('button', { name: '第 2 组' }).click()
  await panel.getByRole('button', { name: '生成记录', exact: true }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  const completed = records.getByRole('article').filter({ hasText: '已完成' })
  await expect(completed.getByRole('button', { name: '编辑生成', exact: true })).toBeVisible()
  await expect(records.getByRole('button', { name: '编辑视频', exact: true })).toHaveCount(1)
  const returnUrl = page.url()
  await page.screenshot({ path: `${SHOT_DIR}/entry.png`, animations: 'disabled' })

  await completed.getByRole('button', { name: '编辑视频', exact: true }).click()
  await expect(page).toHaveURL(/\/video-editor\/[^/?]+$/)
  await expect(page.getByRole('main', { name: '视频编辑器' })).toBeVisible()
  await expect(page.getByLabel('原视频播放器')).toHaveAttribute(
    'src',
    'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
  )
  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(returnUrl)
  await expect(page.getByRole('complementary', { name: '生成记录' })).toBeVisible()
})

test('原片与累计版本对齐，选段、键盘调整、缩放、版本切换与参考图片可操作', async ({ page }) => {
  await page.goto('/video-editor/demo')
  const editorTimeline = timeline(page)
  const version = versionTrigger(page)
  const playhead = editorTimeline.getByRole('slider', { name: '时间线播放位置' })
  await expect(version).toHaveText('V3')
  await expect(playhead).toHaveAttribute('max', '17')
  await expect(
    editorTimeline.getByRole('button', { name: '修改 00:04.00 至 00:08.00，来源 V2' }),
  ).toBeVisible()
  await expect(
    editorTimeline.getByRole('button', { name: '+2s 00:08.00 至 00:10.00，来源 V3' }),
  ).toBeVisible()
  await expect(
    editorTimeline.getByRole('button', { name: '修改 00:13.00 至 00:15.00，来源 V3' }),
  ).toBeVisible()
  await chooseVersion(page, 'V2')
  await expect(playhead).toHaveAttribute('max', '15')
  await expect(editorTimeline.getByText('无对应原片', { exact: true })).toHaveCount(0)
  await chooseVersion(page, 'V3')
  await expect(editorTimeline.getByText('无对应原片', { exact: true })).toBeVisible()

  await page.getByRole('spinbutton', { name: '开始时间（秒）' }).fill('11')
  await page.getByRole('spinbutton', { name: '结束时间（秒）' }).fill('14')
  const rangeStart = editorTimeline.getByRole('slider', { name: '选段开始时间' })
  await expect(rangeStart).toHaveAttribute('aria-valuenow', '11')
  await rangeStart.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('spinbutton', { name: '开始时间（秒）' })).toHaveValue('11.1')
  await editorTimeline.getByRole('button', { name: '放大时间线' }).click({ clickCount: 3 })
  await expect(editorTimeline.getByRole('button', { name: '缩小时间线' })).toBeEnabled()
  const track = editorTimeline.getByRole('region', { name: '时间线轨道，放大后可横向滚动' })
  await expect
    .poll(() => track.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true)
  await editorTimeline.getByRole('button', { name: '时间线适应宽度' }).click()
  await expect(editorTimeline.getByRole('button', { name: '缩小时间线' })).toBeDisabled()
  // 当前选段结束手柄位于 14 秒，点击缩略片段左侧避开可拖动手柄。
  await editorTimeline
    .getByRole('button', { name: '修改 00:13.00 至 00:15.00，来源 V3' })
    .click({ position: { x: 20, y: 30 } })
  await expect(page.getByRole('spinbutton', { name: '开始时间（秒）' })).toHaveValue('13')

  await page.getByLabel('选择参考图片').setInputFiles(REFERENCE_IMAGE)
  const references = page.getByRole('group', { name: '参考图片', exact: true })
  await expect(references.getByRole('img', { name: 'video-editor-demo.webp' })).toBeVisible()
  await references.getByRole('button', { name: '预览参考图 video-editor-demo.webp' }).click()
  const preview = page.getByRole('dialog', { name: 'video-editor-demo.webp', exact: true })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  await page.screenshot({ path: `${SHOT_DIR}/desktop.png`, animations: 'disabled' })
  await chooseVersion(page, 'V2')
  const menu = await openVersions(page)
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3)
  await expect(menu.getByRole('menuitemradio', { name: '原片', exact: true })).toContainText('15s')
  await expect(menu.getByRole('menuitemradio', { name: 'V2', exact: true })).toContainText(
    '基于原片 · 15s',
  )
  await expect(menu.getByRole('menuitemradio', { name: 'V3', exact: true })).toContainText(
    '基于 V2 · 17s',
  )
  await expect(menu.getByRole('menuitemradio', { name: 'V2', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(menu.getByRole('menuitemradio', { name: 'V3', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await page.screenshot({ path: `${SHOT_DIR}/version-menu.png`, animations: 'disabled' })
  await closeVersions(page)
  await openVersions(page)
  await menu.getByRole('menuitem', { name: '历史', exact: true }).click()
  await expect(history(page)).toBeVisible()
  await history(page).getByRole('button', { name: '关闭版本与任务' }).click()
  await references.getByRole('button', { name: '移除参考图 video-editor-demo.webp' }).click()
  await expect(references.getByRole('img')).toHaveCount(0)
})

test('生成任务从排队到预览与采用，继续延长继承此前全部修改', async ({ page }) => {
  test.setTimeout(45_000)
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/(uploads|generations)/.test(request.url()))
      writes.push(request.url())
  })
  await page.goto('/video-editor/demo')
  await page.getByRole('combobox', { name: '编辑模型' }).selectOption('demo')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const task = await readyTask(page, 'V4')
  await page.screenshot({ path: `${SHOT_DIR}/history.png`, animations: 'disabled' })
  await task.getByRole('button', { name: '预览', exact: true }).click()
  await expect(versionTrigger(page)).toHaveText('V4')
  await expect(
    page.getByRole('group', { name: '预览版本' }).getByRole('button', { name: 'V4', exact: true }),
  ).toBeVisible()
  const dialog = await openHistory(page)
  const completed = taskOf(dialog, 'V4')
  await completed.locator('summary').click()
  await completed.getByRole('button', { name: '采用新版本', exact: true }).click()
  await expect(dialog).toBeHidden()

  await page
    .getByRole('group', { name: '编辑方式' })
    .getByRole('button', { name: '延长', exact: true })
    .click()
  await page.getByRole('combobox', { name: '延长时长' }).selectOption('2')
  await page.getByRole('textbox', { name: '修改要求' }).fill('延续当前镜头，展示鞋底细节。')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const extended = await readyTask(page, 'V5')
  await extended.getByRole('button', { name: '采用新版本', exact: true }).click()
  await expect(timeline(page).getByRole('slider', { name: '时间线播放位置' })).toHaveAttribute(
    'max',
    '19',
  )
  await expect(timeline(page).getByRole('button', { name: /修改 .*来源 V2/ })).toBeVisible()
  await expect(timeline(page).getByRole('button', { name: /\+2s .*来源 V3/ })).toBeVisible()
  await expect(timeline(page).getByRole('button', { name: /\+2s .*来源 V5/ })).toBeVisible()
  await expect(
    timeline(page)
      .getByRole('navigation', { name: '当前版本来源' })
      .getByRole('button', { name: 'V4', exact: true }),
  ).toBeVisible()
  expect(writes).toEqual([])
})

test('失败及取消不会增加可用版本，原片和已有版本保留', async ({ page }) => {
  await page.goto('/video-editor/demo')
  await page.getByRole('combobox', { name: '编辑模型' }).selectOption('demo-failure')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const dialog = await openHistory(page)
  const failed = taskOf(dialog, 'V4')
  await expect(failed.locator('summary')).toContainText('失败', { timeout: 10_000 })
  await failed.locator('summary').click()
  await expect(failed.getByText(/模拟生成失败/)).toBeVisible()
  await dialog.getByRole('button', { name: '关闭版本与任务' }).click()
  await expectVersionCount(page, 3)

  await page.getByRole('combobox', { name: '编辑模型' }).selectOption('demo')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const cancelDialog = await openHistory(page)
  const active = taskOf(cancelDialog, 'V5')
  await active.getByRole('button', { name: '取消模拟任务' }).click()
  await expect(active.locator('summary')).toContainText('已取消')
  await cancelDialog.getByRole('button', { name: '关闭版本与任务' }).click()
  await expectVersionCount(page, 3)
  await expect(timeline(page).getByRole('slider', { name: '时间线播放位置' })).toHaveAttribute(
    'max',
    '17',
  )
})

test('移动布局只允许时间线内部滚动，深色与桌面布局完整', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/video-editor/demo')
  await expect(page.getByRole('main', { name: '视频编辑器' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)
  await page
    .getByRole('textbox', { name: '修改要求' })
    .fill('保留鞋款，在光线柔和的浅灰色背景中自然转动，保持连续运镜和材质细节。')
  await page.screenshot({ path: `${SHOT_DIR}/mobile.png`, fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({
    path: `${SHOT_DIR}/mobile-dark.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1600, height: 1120 })
  await page.screenshot({ path: `${SHOT_DIR}/dark.png`, animations: 'disabled' })
})

test('新增区间可切回版本，离页生成继续，采用较短原片后选段与播放位置保持有效', async ({ page }) => {
  await page.goto('/video-editor/demo')
  const editorTimeline = timeline(page)
  await editorTimeline.getByRole('button', { name: '+2s 00:08.00 至 00:10.00，来源 V3' }).click()
  const previewTabs = page.getByRole('group', { name: '预览版本' })
  await previewTabs.getByRole('button', { name: '原片', exact: true }).click()
  await expect(page.getByText('此处为新增片段，无对应原片', { exact: true })).toBeVisible()
  await previewTabs.getByRole('button', { name: 'V3', exact: true }).click()
  await expect(page.getByText('此处为新增片段，无对应原片', { exact: true })).toBeHidden()
  await expect(previewTabs.getByRole('button', { name: 'V3', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page
    .getByRole('group', { name: '编辑方式' })
    .getByRole('button', { name: '延长', exact: true })
    .click()
  await page.getByRole('combobox', { name: '编辑模型' }).selectOption('demo')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  await expect(page.getByRole('button', { name: /V4 · (排队中|生成中|结果处理中)/ })).toBeVisible()
  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL('/')
  await page.goBack()
  await expect(page).toHaveURL('/video-editor/demo')
  await expect(versionTrigger(page)).toHaveText('V3')
  await expect(page.getByRole('spinbutton', { name: '开始时间（秒）' })).toHaveValue('8')
  const readySummary = page.getByRole('button', { name: 'V4 · 待预览', exact: true })
  await expect(readySummary).toBeVisible({ timeout: 12_000 })
  const versions = await openVersions(page)
  await expect(versions.getByRole('menuitemradio', { name: 'V4', exact: true })).toBeVisible()
  await closeVersions(page)

  await readySummary.click()
  const task = taskOf(history(page), 'V4')
  await task.locator('summary').click()
  await task.getByRole('button', { name: '采用新版本', exact: true }).click()
  await expect(page.getByRole('button', { name: 'V4 · 已采用', exact: true })).toBeVisible()
  const playhead = editorTimeline.getByRole('slider', { name: '时间线播放位置' })
  await expect(playhead).toHaveAttribute('max', '19')
  await page.getByRole('spinbutton', { name: '结束时间（秒）' }).fill('19')
  await page.getByRole('spinbutton', { name: '开始时间（秒）' }).fill('18')
  await playhead.focus()
  await page.keyboard.press('End')
  await expect(playhead).toHaveValue('19')

  const dialog = await openHistory(page)
  const originalRow = dialog
    .getByRole('button', { name: '原片 原始视频', exact: true })
    .locator('..')
  await originalRow.getByRole('button', { name: '采用', exact: true }).click()
  await expect(versionTrigger(page)).toHaveText('原片')
  await expect(playhead).toHaveAttribute('max', '15')
  await expect(playhead).toHaveValue('15')
  const start = Number(await page.getByRole('spinbutton', { name: '开始时间（秒）' }).inputValue())
  const end = Number(await page.getByRole('spinbutton', { name: '结束时间（秒）' }).inputValue())
  expect(start).toBeGreaterThanOrEqual(0)
  expect(start).toBeLessThan(end)
  expect(end).toBeLessThanOrEqual(15)
})
