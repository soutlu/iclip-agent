import { expect, test } from '@playwright/test'
import { login } from './login'

test('从侧栏进资料库，按画幅与关键词筛，筛选留在地址里，退回还原', async ({ page }) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()

  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByRole('article', { name: '跑鞋手持展示 · 镜头组 1' })).toBeVisible()
  await expect(main.getByText('共 7 条')).toBeVisible()

  await main.getByRole('radio', { name: '横版' }).click()
  await expect(main.getByText('找到 2 条')).toBeVisible()
  await expect(page).toHaveURL(/orientation=landscape/)

  await main.getByRole('radio', { name: '全部' }).click()
  await main.getByRole('textbox', { name: '搜索脚本' }).fill('滑板')
  await expect(main.getByRole('article')).toHaveCount(1)
  await expect(page).toHaveURL(/q=/)

  // mock 会话不跨刷新保存，用离开再退回验证筛选从地址还原。
  await page.getByRole('button', { name: '需求单' }).click()
  await expect(page).toHaveURL('/tasks')
  await page.goBack()
  await expect(main.getByRole('textbox', { name: '搜索脚本' })).toHaveValue('滑板')
  await expect(
    main.getByRole('article', { name: '滑板女孩 · 厚底靴街拍 · 镜头组 1' }),
  ).toBeVisible()
})
