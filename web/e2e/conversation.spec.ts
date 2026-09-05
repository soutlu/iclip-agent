import { expect, test } from '@playwright/test'
import { login } from './login'

// MSW 同时提供 REST 历史与 WebSocket 流式批次，用于验证浏览器中的合并渲染。

test('点开一段对话：历史铺开，回复逐字长出来', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByRole('heading', { name: '夜景延时素材生成' })).toBeVisible()

  await expect(page.getByText('第 1 个问题')).toBeVisible()
  await expect(page.getByText('这是第 2 轮的回复。')).toBeVisible()
  await expect(page.getByText('读文件')).toBeVisible()
  await expect(page.getByText('shots/storyboard.md')).toBeVisible()

  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('listitem').filter({ hasText: '拆出 3 个镜头' })).toBeVisible()
  // 路径同时出现在工具行，按 code 标签定位行内代码。
  await expect(page.locator('code', { hasText: 'shots/storyboard.md' })).toBeVisible()
})

test('点派活卡的「查看」：右侧打开子代理的过程，地址记住这张卡', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByText('第 1 个问题')).toBeVisible()

  await page.getByRole('button', { name: '查看子代理过程' }).first().click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('heading', { name: '派活 · shot-writer' })).toBeVisible()
  await expect(panel.getByText('shot-writer', { exact: true })).toBeVisible()
  await expect(panel.getByText('写第 3 组的三个镜头')).toBeVisible()
  await expect(panel.getByText(/S3-1 特写/)).toBeVisible()
  await expect(page).toHaveURL(/artifact=frame(%3A|:)call_t2_delegate/)
})

test('长对话可以在中间消息区滚动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })

  const scroller = page.locator('.chat-scroller')
  await scroller.hover()
  await page.mouse.wheel(0, -10_000)
  const firstTurn = page.getByRole('article', { name: '第 1 轮' })
  await expect(firstTurn).toBeInViewport()
  const before = await firstTurn.boundingBox()
  if (!before) throw new Error('首轮消息没有可测量的位置')

  await page.mouse.wheel(0, 320)
  await expect
    .poll(async () => (await firstTurn.boundingBox())?.y ?? before.y)
    .toBeLessThan(before.y)
  await expect(page.getByLabel('输入消息')).toBeInViewport()
})

test('在会话页发一条：气泡先出来，回复跟着长出来', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByText('第 1 个问题')).toBeVisible()

  await page.getByLabel('输入消息').fill('再补两个镜头')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('再补两个镜头')).toBeVisible()
  await expect(page.getByLabel('输入消息')).toHaveText('')

  await expect(page.getByText('再补两个镜头')).toHaveCount(1)
  await expect(page.getByText('镜头表已经更新。').last()).toBeVisible({ timeout: 15_000 })
})

test('首页发一条：新建对话并跳进会话页', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByLabel('输入消息').fill('做一个亚麻衬衫的短片')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('做一个亚麻衬衫的短片')).toBeVisible({ timeout: 15_000 })
})

test('在跑的时候再发一条：排队、追加、停止', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByText('第 1 个问题')).toBeVisible()

  // 等待运行开始后按 Enter 发送；运行中发送按钮已替换为停止。
  await page.getByRole('button', { name: '停止' }).waitFor()
  await page.getByLabel('输入消息').fill('顺便配个音')
  await page.getByLabel('输入消息').press('Enter')

  await expect(page.getByText('1 个任务等待发送')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible()

  await page.getByRole('button', { name: '立即发送到当前回合' }).click()
  await expect(page.getByText('1 个任务等待发送')).toBeHidden()
  await expect(page.getByText('收到，一起做。')).toBeVisible({ timeout: 15_000 })
})

test('点停止：这一轮收成取消，发送钮回来', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '亚麻衬衫二剪', exact: true }).click()

  await page.getByRole('button', { name: '停止' }).click()

  await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止' })).toBeHidden()
})
