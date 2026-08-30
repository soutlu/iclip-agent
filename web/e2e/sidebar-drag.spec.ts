import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

// 拖拽只能在真浏览器里验：jsdom 量不出元素位置，dnd-kit 的碰撞检测就无从谈起。
// 跑在 dev:mock 上，浏览器里那份 MSW 预置了「夏季亚麻系列」（2 段）与「待归档」（空）。

const login = async (page: Page) => {
  const expandSidebar = page.getByRole('button', { name: '展开侧边栏' })
  const loginTrigger = page.getByRole('button', { name: '登录', exact: true })
  await expect(expandSidebar.or(loginTrigger).first()).toBeVisible()
  if (await expandSidebar.isVisible()) {
    await expandSidebar.click()
  }
  await loginTrigger.click()
  const dialog = page.getByRole('dialog', { name: '登录 Cue' })
  await dialog.getByLabel('用户名', { exact: true }).fill('tester')
  await dialog.getByLabel('密码', { exact: true }).fill('secret')
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** 按住源、挪到目标上方、松手。dnd-kit 起手要越过 5px 阈值，所以分两步移动。 */
const dragOnto = async (page: Page, source: string, target: string | RegExp) => {
  const from = page.getByRole('button', { name: source, exact: true })
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

  const emptyCollection = page.getByRole('button', { name: '待归档 (0)' })
  await expect(emptyCollection).toBeVisible()
  const ungroupedBefore = await page.getByRole('button', { name: /^任务 \(\d+\)$/ }).innerText()

  await dragOnto(page, '夜景延时素材生成', '待归档 (0)')

  // 落地后整块重拉：合集条数 +1，任务区 -1
  await expect(page.getByRole('button', { name: '待归档 (1)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^任务 \(\d+\)$/ })).not.toHaveText(ungroupedBefore)

  // 拖回任务区：展开合集拿到那一行，拖到「任务」标题上
  await page.getByRole('button', { name: '待归档 (1)' }).click()
  await dragOnto(page, '夜景延时素材生成', /^任务 \(\d+\)$/)

  await expect(page.getByRole('button', { name: '待归档 (0)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^任务 \(\d+\)$/ })).toHaveText(ungroupedBefore)
})
