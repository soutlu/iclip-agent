import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** 先等待应用壳挂载，再按需展开紧凑屏侧栏，避免 isVisible 在首屏未就绪时误判。 */
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
