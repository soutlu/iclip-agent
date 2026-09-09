import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { login } from './login'

// jsdom 缺少布局几何，dnd-kit 碰撞检测在浏览器测试中验证。

/** 分两步移动以越过 dnd-kit 的 5px 激活阈值；源为对话链接，目标为分区或合集按钮。 */
const dragOnto = async (page: Page, source: string, target: string | RegExp) => {
  const from = page.getByRole('link', { name: source, exact: true })
  const to = page.getByRole('button', { name: target })
  const start = await from.boundingBox()
  const end = await to.boundingBox()
  if (!start || !end) throw new Error('拖拽的两端要先在页面上')

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 12, { steps: 4 })
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 })
  await page.mouse.up()
}

test('把对话拖进合集，再拖回任务区', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (2)' })).toBeVisible()
  const ungroupedBefore = await page.getByRole('button', { name: /^任务 \(\d+\)$/ }).innerText()

  await dragOnto(page, '夜景延时素材生成', '夏季亚麻系列 (2)')

  // 拖拽不得触发对话链接的点击跳转。
  await expect(page).toHaveURL('/')

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (3)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^任务 \(\d+\)$/ })).not.toHaveText(ungroupedBefore)

  // 移动后侧栏会重建，重试展开操作以避免点击旧节点。
  const row = page.getByRole('link', { name: '夜景延时素材生成', exact: true })
  await expect(async () => {
    await page.getByRole('button', { name: '夏季亚麻系列 (3)' }).click()
    await expect(row).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await dragOnto(page, '夜景延时素材生成', /^任务 \(\d+\)$/)

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (2)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^任务 \(\d+\)$/ })).toHaveText(ungroupedBefore)
})
