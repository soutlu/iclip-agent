import { expect, test } from '@playwright/test'

test('账号密码登录后进入首页，用户菜单显示当前用户', async ({ page }) => {
  await page.goto('/login')

  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码', { exact: true }).fill('secret')
  await page.getByRole('button', { name: '登录', exact: true }).click()

  await expect(page).toHaveURL('/')
  await page.getByRole('button', { name: '用户菜单' }).click()
  await expect(page.getByRole('menu')).toContainText('测试用户')
})

test('未登录访问受保护页面会被送到登录页并带上回跳地址', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/login\?redirect=/)
  await expect(page.getByRole('form', { name: 'Producer 登录表单' })).toBeVisible()
})
