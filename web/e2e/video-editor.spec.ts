/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
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

test('从生成记录打开编辑器：切段、生成、预览、合成成为新版本', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1120 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })

  await dialog.getByLabel('开始时间（秒）').fill('1')
  await dialog.getByLabel('结束时间（秒）').fill('4')
  await dialog.getByRole('textbox', { name: '修改要求' }).fill('换成浅灰背景，保留运镜。')

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
    model: 'moyu-seedance-2-5',
    prompt: '换成浅灰背景，保留运镜。',
    seconds: -1,
    provider_options: { omni_reference_task_type: 'edit' },
    metadata: { editStart: 1, editEnd: 4 },
  })
  expect(edit['reference_video_urls']).toEqual([expect.stringContaining('.webm')])

  const summary = dialog.getByRole('button', { name: /V2 · / })
  await expect(summary).toHaveText(/待预览/, { timeout: STEP_TIMEOUT })
  await summary.click()
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
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    /sample-edited/,
    { timeout: 8000 },
  )
  await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()

  await summary.click()
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
  await dialog.getByRole('button', { name: /V2 · / }).click()
  await expect(history.getByRole('button', { name: 'V2 基于 V1', exact: true })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await page.keyboard.press('Escape')
  await expect(history).toBeHidden()
})

test('桌面、移动与深色布局各留一张截图', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1120 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await page.screenshot({ path: `${SHOT_DIR}/desktop-light.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${SHOT_DIR}/desktop-dark.png`, animations: 'disabled' })
})

test('移动布局：对话框内部自己滚，页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await page.screenshot({ path: `${SHOT_DIR}/mobile-light.png`, animations: 'disabled' })
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
