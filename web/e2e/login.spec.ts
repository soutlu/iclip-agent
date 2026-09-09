import { expect, test } from '@playwright/test'

test('未登录进首页看到游客态外壳，点登录弹窗登录后就地变成已登录', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('登录后查看对话')).toBeVisible()
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeHidden()

  await page.getByRole('button', { name: '登录', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '登录 Cue' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('用户名', { exact: true }).fill('tester')
  await dialog.getByLabel('密码', { exact: true }).fill('secret')
  await dialog.getByRole('button', { name: '登录', exact: true }).click()

  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL('/')
  await page.getByRole('button', { name: '用户菜单' }).click()
  await expect(page.getByRole('menu')).toContainText('测试用户')
})

test('未登录点发送弹出登录框', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel('输入消息').fill('做一个产品宣传片')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByRole('dialog', { name: '登录 Cue' })).toBeVisible()
})
