import { expect, test } from '@playwright/test'
import { login } from './login'

test('治理者从侧栏进「全部对话」，看到别人在跑的对话，点进去是只读', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')

  await page.getByRole('button', { name: '全部对话' }).click()
  await expect(page).toHaveURL('/audit')
  await expect(page.getByRole('heading', { name: '全部对话' })).toBeVisible()

  const running = page.getByRole('link', { name: /小王 · 秋季新品短片/ })
  await expect(running).toContainText('进行中')
  await expect(running).toContainText('小王')
  await expect(page.getByRole('status', { name: '对话总数' })).toContainText('段在跑')

  await running.click()
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText('只读 · 小王 的对话')).toBeVisible()
  await expect(page.getByLabel('输入消息')).toBeHidden()

  await page.getByRole('link', { name: '回到全部对话' }).click()
  await expect(page).toHaveURL('/audit')
})

test('普通用户没有「全部对话」入口，直接访问 /audit 回首页', async ({ page }) => {
  await page.goto('/')
  await login(page, 'tester')

  await expect(page.getByRole('button', { name: '全部对话' })).toBeHidden()

  await page.goto('/audit')
  await expect(page).toHaveURL('/')
})
