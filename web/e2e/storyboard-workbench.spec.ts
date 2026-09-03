import { expect, test } from '@playwright/test'
import { login } from './login'

// 分镜工作台要在真浏览器里验：右面板是路由声明的槽位，翻组靠 scroll-snap（jsdom 里没有真实滚动，
// 只能在这里验），生成记录来自 GET /generations（src/testing/mocks/workspace.ts）。

// 并排要放得下侧栏 264 + 聊天 400 + 面板 560。
test.use({ viewport: { height: 900, width: 1600 } })

test('点开有分镜的对话：滚轮翻到第 2 组，看生成记录，点镜头缩略图切帧', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('heading', { name: '分镜' })).toBeVisible()
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

  // 滚轮向下翻一页：scroll-snap 吸到第 2 组，当前页同步进地址
  await panel.getByRole('region', { name: '镜头组 1' }).hover()
  await page.mouse.wheel(0, 700)
  await expect(page).toHaveURL(/shot=2/)
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 2 组')).toBeVisible()

  // 第 2 组名下三条视频任务（完成 / 失败 / 还在飞）
  await panel.getByRole('button', { name: '生成记录' }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await expect(records.getByRole('radio', { name: '视频生成记录 3' })).toBeVisible()
  await expect(records.getByText('生成中…')).toBeVisible()
  await records.getByRole('button', { name: '关闭生成记录' }).click()

  // 底部第二个镜头缩略图 → 中间大画面切到该镜第一帧（@2）
  const page2 = panel.getByRole('region', { name: '镜头组 2' })
  await page2.getByLabel('本组镜头').getByRole('button').nth(1).click()
  await expect(page).toHaveURL(/frame=2/)
  await expect(page2.getByText('@2 · 镜头 2')).toBeVisible()
})

test('agent 改了文件：重读之后描述更新并标出改动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

  await expect(panel.getByText(/台词并成一句/)).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('agent 刚改过')).toBeVisible()
})

test('没有工作区文件的对话仍是折叠空态', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '亚麻衬衫二剪', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  await expect(page.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分镜' })).toBeHidden()
})
