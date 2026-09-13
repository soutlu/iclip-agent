import { expect, test } from '@playwright/test'
import { login } from './login'

test('治理者从侧栏进「全部对话」，看到别人在跑的对话，点进去是只读', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')

  await page.getByRole('button', { name: '全部对话' }).click()
  await expect(page).toHaveURL('/audit')
  await expect(page.getByRole('main', { name: '全部对话' })).toBeVisible()

  const running = page.getByRole('link', { name: /小王 · 秋季新品短片/ })
  await expect(running).toContainText('进行中')
  await expect(running).toContainText('小王')
  await expect(page.getByRole('status', { name: '对话总数' })).toContainText('进行中')

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

test('全部对话的筛选在窄屏和深色主题下可用，关闭后保留键盘焦点', async ({ page }) => {
  const screenshotDir = '../.artifacts/design-qa/audit-polish'
  await page.setViewportSize({ width: 1524, height: 1032 })
  await page.clock.setFixedTime(new Date('2026-09-13T20:00:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '全部对话', exact: true }).click()
  const audit = page.getByRole('main', { name: '全部对话' })
  await expect(audit.getByRole('link')).toHaveCount(9)
  await page.screenshot({ path: `${screenshotDir}/desktop-light.png`, animations: 'disabled' })

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${screenshotDir}/desktop-dark.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '折叠侧边栏' })
  if (await collapse.isVisible()) await collapse.click()
  await page.screenshot({ path: `${screenshotDir}/mobile-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })

  const userTrigger = page.getByRole('button', { name: '用户：用户', exact: true })
  await userTrigger.click()
  const search = page.getByRole('combobox', { name: '搜索用户' })
  await search.fill('小王')
  await search.press('ArrowDown')
  await search.press('Enter')
  const selectedUser = page.getByRole('button', { name: '用户：小王', exact: true })
  await expect(selectedUser).toBeFocused()
  await expect(audit.getByRole('link')).toHaveCount(2)
  await selectedUser.click()
  await page.getByRole('option', { name: '小王', exact: true }).click()
  await expect(audit.getByRole('link')).toHaveCount(9)

  const timeTrigger = page.getByRole('button', { name: '时间：时间', exact: true })
  await timeTrigger.click()
  await page.getByRole('radio', { name: '自定义', exact: true }).click()
  await page.getByRole('button', { name: '2026年9月8日', exact: true }).click()
  await expect(audit.getByRole('link')).toHaveCount(9)
  await page.getByRole('button', { name: '2026年9月12日', exact: true }).click()
  const selectedTime = page.getByRole('button', { name: '时间：9月8日 — 9月12日', exact: true })
  await selectedTime.click()
  const calendar = page.getByRole('dialog', { name: '选择时间范围' })
  await expect(calendar.getByRole('gridcell', { selected: true })).toHaveCount(5)
  await page.screenshot({ path: `${screenshotDir}/mobile-calendar.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(selectedTime).toBeFocused()
  await selectedTime.click()
  await page.getByRole('radio', { name: '自定义', exact: true }).click()
  await expect(timeTrigger).toBeFocused()
  await expect(audit.getByRole('link')).toHaveCount(9)
  await page.screenshot({ path: `${screenshotDir}/mobile-light.png`, animations: 'disabled' })
})
