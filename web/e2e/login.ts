import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * 在首页就地登录：点侧栏登录入口 → 弹窗填账号密码 → 不跳页。
 *
 * 紧凑屏侧栏默认收起，登录入口要先把侧栏展开才点得到；先等外壳挂上，否则刷新后一瞬间两个
 * 按钮都还没有，`isVisible` 会误判成不必展开。
 *
 * @param page - 当前页面。
 */
export const login = async (page: Page) => {
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
