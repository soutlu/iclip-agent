import { expect, test } from '@playwright/test'
import { login } from './login'

// 列表按建立时间倒序（合同 §3），改名这类后续操作不让条目换位。
test('侧栏改名后那一行留在原位', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const rows = sidebar.getByRole('link')
  const target = '夜景延时素材生成'
  const renamed = '夜景延时素材 · 改名'
  await expect(sidebar.getByRole('link', { name: target, exact: true })).toBeVisible()
  const before = await rows.allTextContents()
  // 不在第一行，按最近修改排的话改完会跳到顶上，换位才看得出来。
  expect(before.indexOf(target)).toBeGreaterThan(0)

  await sidebar.getByRole('link', { name: target, exact: true }).hover()
  await sidebar.getByRole('button', { name: `${target} 的更多操作` }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const input = sidebar.getByRole('textbox', { name: `重命名 ${target}` })
  await input.fill(renamed)
  await input.press('Enter')

  // 改名成功后重拉侧栏，新名字出现时顺序已是服务端给的。
  await expect(rows).toHaveText(before.map((title) => (title === target ? renamed : title)))
})
