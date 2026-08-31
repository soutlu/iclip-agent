import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { login } from './login'

// 拖拽只能在真浏览器里验：jsdom 量不出元素位置，dnd-kit 的碰撞检测就无从谈起。
// 跑在 dev:mock 上，浏览器里那份 MSW 预置了一个「夏季亚麻系列」（2 段），其余对话在任务区。

/**
 * 按住源、挪到目标上方、松手。dnd-kit 起手要越过 5px 阈值，所以分两步移动。
 *
 * 源是对话行（链接，点开会进会话页），目标是合集或分区标题（按钮）。
 */
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

  // 拖完还留在首页：对话行是链接，拖拽被误判成点击就会跳进会话页
  await expect(page).toHaveURL('/')

  // 落地后整块重拉：合集条数 +1，任务区 -1
  await expect(page.getByRole('button', { name: '夏季亚麻系列 (3)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^任务 \(\d+\)$/ })).not.toHaveText(ungroupedBefore)

  // 拖回任务区：展开合集拿到那一行，拖到「任务」标题上。
  // 展开这一下要重试：搬完家侧栏在整块重拉，正赶上那一刻的点击会落在被换掉的那棵树上。
  const row = page.getByRole('link', { name: '夜景延时素材生成', exact: true })
  await expect(async () => {
    await page.getByRole('button', { name: '夏季亚麻系列 (3)' }).click()
    await expect(row).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await dragOnto(page, '夜景延时素材生成', /^任务 \(\d+\)$/)

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (2)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^任务 \(\d+\)$/ })).toHaveText(ungroupedBefore)
})
