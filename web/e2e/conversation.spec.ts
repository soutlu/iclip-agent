import { expect, test } from '@playwright/test'
import { login } from './login'

// 会话页要在真浏览器里验：内容一半来自 REST 一页历史，一半来自 WebSocket 逐字推送，
// 浏览器里那份 MSW 连上就演一轮流式回复（src/testing/mocks/transcript.ts）。

test('点开一段对话：历史铺开，回复逐字长出来', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByRole('heading', { name: '夜景延时素材生成' })).toBeVisible()

  // 历史那两轮：用户那条、模型那条，第二轮里还有一张工具卡（卡面来自服务端的 display）
  await expect(page.getByText('第 1 个问题')).toBeVisible()
  await expect(page.getByText('这是第 2 轮的回复。')).toBeVisible()
  await expect(page.getByText('读文件')).toBeVisible()
  await expect(page.getByText('shots/storyboard.md')).toBeVisible()

  // 逐字来的那一轮：三段追加接在同一块上，最终是一整句
  await expect(page.getByText('好的，我先看一下这段素材，再把镜头表补齐。')).toBeVisible({
    timeout: 15_000,
  })
})

test('在会话页发一条：气泡先出来，回复跟着长出来', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByText('第 1 个问题')).toBeVisible()

  await page.getByLabel('输入消息').fill('再补两个镜头')
  await page.getByRole('button', { name: '发送' }).click()

  // 气泡先挂出来（服务端还没记下），输入框清空
  await expect(page.getByText('再补两个镜头')).toBeVisible()
  await expect(page.getByLabel('输入消息')).toHaveValue('')

  // 服务端认下这条之后本地气泡撤掉，同一句只剩时间线上那一条
  await expect(page.getByText('再补两个镜头')).toHaveCount(1)
  await expect(page.getByText('好的，我先看一下这段素材，再把镜头表补齐。').last()).toBeVisible({
    timeout: 15_000,
  })
})

test('首页发一条：新建对话并跳进会话页', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByLabel('输入消息').fill('做一个亚麻衬衫的短片')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('做一个亚麻衬衫的短片')).toBeVisible({ timeout: 15_000 })
})
