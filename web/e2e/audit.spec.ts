import { expect, test } from '@playwright/test'
import { login } from './login'

test('普通用户没有「全部对话」「审计」入口，直接访问都回首页', async ({ page }) => {
  await page.goto('/')
  await login(page, 'tester')

  await expect(page.getByRole('button', { name: '全部对话' })).toBeHidden()
  await expect(page.getByRole('button', { name: '审计' })).toBeHidden()

  await page.goto('/audit')
  await expect(page).toHaveURL('/')
  await page.goto('/conversations')
  await expect(page).toHaveURL('/')
})

test('审计总览在桌面、深色与窄屏下可读，能切到异常标签', async ({ page }) => {
  const screenshotDir = '../.artifacts/design-qa/audit-dashboard'
  await page.setViewportSize({ width: 1524, height: 1032 })
  await page.clock.setFixedTime(new Date('2026-09-13T20:00:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()

  const main = page.getByRole('main', { name: '审计' })
  await expect(main.getByRole('article', { name: '成片件数' })).toBeVisible()
  await expect(main.getByRole('region', { name: '按人' })).toBeVisible()
  await expect(main.getByRole('region', { name: '异常概览' })).toBeVisible()
  await page.screenshot({
    path: `${screenshotDir}/desktop-light.png`,
    animations: 'disabled',
    fullPage: true,
  })

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({
    path: `${screenshotDir}/desktop-dark.png`,
    animations: 'disabled',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '折叠侧边栏' })
  if (await collapse.isVisible()) await collapse.click()
  await page.screenshot({
    path: `${screenshotDir}/mobile-dark.png`,
    animations: 'disabled',
    fullPage: true,
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1524, height: 1032 })

  await page.getByRole('tab', { name: '异常' }).click()
  await expect(page).toHaveURL('/audit?tab=anomalies')
  await expect(main.getByRole('region', { name: '异常列表' })).toBeVisible()
  await page.screenshot({
    path: `${screenshotDir}/anomalies-light.png`,
    animations: 'disabled',
    fullPage: true,
  })

  await page.getByRole('tab', { name: '对话明细' }).click()
  await main.getByRole('button', { name: '展开镜头明细' }).first().click()
  await expect(main.getByRole('list', { name: '镜头出片次数' })).toBeVisible()
  await page.screenshot({
    path: `${screenshotDir}/conversations-light.png`,
    animations: 'disabled',
    fullPage: true,
  })
})
