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
