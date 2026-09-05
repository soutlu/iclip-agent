import { expect, test } from '@playwright/test'
import { login } from './login'

// 在浏览器验证 scroll-snap 翻组；视口需容纳 264px 侧栏、400px 聊天和 560px 面板。
test.use({ viewport: { height: 900, width: 1600 } })

test('点开有分镜的对话：滚轮翻到第 2 组，看生成记录，点镜头缩略图切帧', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('heading', { name: '分镜' })).toBeVisible()
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

  await panel.getByRole('region', { name: '镜头组 1' }).hover()
  await page.mouse.wheel(0, 700)
  await expect(page).toHaveURL(/shot=2/)
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 2 组')).toBeVisible()

  await panel.getByRole('button', { name: '生成记录' }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await expect(records.getByRole('radio', { name: '视频生成记录 3' })).toBeVisible()
  await expect(records.getByText('生成中…')).toBeVisible()
  await records.getByRole('button', { name: '关闭生成记录' }).click()

  const page2 = panel.getByRole('region', { name: '镜头组 2' })
  await page2.getByLabel('本组镜头').getByRole('button').nth(1).click()
  await expect(page).toHaveURL(/frame=2/)
  await expect(page2.getByText('@2 · 镜头 2')).toBeVisible()
})

// MSW 会话随整页加载清空，无法直接验证带参数刷新；此处验证程序化跳页不被中间滚动事件覆盖。
test('点页码点跳组：地址落在那一组不回弹，帧号照样点得动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

  await panel.getByRole('button', { name: '第 3 组' }).click()
  await expect(panel.getByRole('region', { name: '镜头组 3' })).toBeInViewport()
  await expect(page).toHaveURL(/shot=3/)

  // 防止平滑滚动的中间位置覆盖目标页查询参数。
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 3 组')).toBeVisible()

  await panel.getByRole('button', { name: '第 2 组' }).click()
  await expect(panel.getByRole('region', { name: '镜头组 2' })).toBeInViewport()
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })
  await shot2.getByRole('button', { name: '看第 3 帧' }).click()
  await expect(page).toHaveURL(/frame=3/)
  await expect(shot2.getByText('@3 · 镜头 2')).toBeVisible()
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

test('在工作台里改时长、换帧、打字：停手即存，页头出「已保存」', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()
  await panel.getByRole('button', { name: '第 2 组' }).click()
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })

  await shot2.getByRole('spinbutton', { name: '镜头组 2 的时长（秒）' }).fill('12')
  await expect(panel.getByText('3 组 · 合计 22 秒 · 第 2 组')).toBeVisible()
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })

  await shot2.getByRole('button', { name: '替换这一帧' }).click()
  const picker = page.getByRole('dialog', { name: '替换这一帧' })
  await picker.getByRole('button', { name: '选 S3-1' }).click()
  await expect(picker).toBeHidden()

  const editor = shot2.getByRole('textbox', { name: '镜头 1 的描述' })
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
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

  // 仅第 1 组没有生成任务；第 2 组运行中，第 3 组已有成片。
  const shot1 = panel.getByRole('region', { name: '镜头组 1' })
  await shot1.getByRole('button', { name: '生成视频' }).click()
  await expect(shot1.getByRole('button', { name: '正在出片…' })).toBeDisabled()
  await expect(panel.getByText('正在出片', { exact: true })).toBeVisible()

  await panel.getByRole('button', { name: '生成记录' }).click()
  const records = panel.getByRole('complementary', { name: '生成记录' })
  await expect(records.getByText('生成中…')).toBeVisible()

  await expect(records.getByText('生成完成')).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText('已出片')).toBeVisible()
})

test('「全部分镜」全选之后批量出片：确认框写清条数', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

  await panel.getByRole('button', { name: '全部分镜' }).click()
  const sheet = panel.getByRole('complementary', { name: '全部分镜' })
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

test('选中即上下文：输入框上出现芯片，× 掉不再回来，发出去的正文带前缀', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByText('3 组 · 合计 21 秒 · 第 1 组')).toBeVisible()

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

  await expect(page.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分镜' })).toBeHidden()
})
