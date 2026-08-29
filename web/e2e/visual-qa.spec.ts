import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

// 视觉验收截图专用：跑在 dev:mock 上，先登录再走首页。产物落仓库根 .artifacts/design-qa/（gitignore，不入库）。
const SHOT_DIR = '../.artifacts/design-qa'

// 登录改成首页弹窗：点侧栏登录入口 → 弹窗填账号密码 → 就地登录，不跳页。
// 紧凑屏侧栏默认收起，登录入口要先把侧栏展开才点得到。
const login = async (page: Page) => {
  const expandSidebar = page.getByRole('button', { name: '展开侧边栏' })
  const loginTrigger = page.getByRole('button', { name: '登录', exact: true })
  // 先等外壳挂上，否则刷新后一瞬间两个按钮都还没有，isVisible 会误判成不必展开
  await expect(expandSidebar.or(loginTrigger).first()).toBeVisible()

  if (await expandSidebar.isVisible()) {
    await expandSidebar.click()
  }

  await loginTrigger.click()
  const dialog = page.getByRole('dialog', { name: '登录 Producer' })
  await dialog.getByLabel('用户名', { exact: true }).fill('tester')
  await dialog.getByLabel('密码', { exact: true }).fill('secret')
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('首页视觉验收：浅色 / 深色 / 移动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Producer' })).toBeAttached()
  // hero 是 Lottie，要等 JSON 拉完 + fade-in 进场落定再截
  await page.waitForTimeout(1200)

  await page.screenshot({ path: `${SHOT_DIR}/home-light.png`, fullPage: true })

  await page.emulateMedia({ colorScheme: 'dark' })
  // 主题跟随系统 + ui-state / transition-colors 有 150ms 过渡，等它落定再截
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-dark.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })

  // 侧栏折叠态
  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-sidebar-collapsed.png`, fullPage: true })
  await page.getByRole('button', { name: '展开侧边栏' }).click()

  // 输入后发送钮态（背景色有 150ms 过渡，等它落定）
  await page.getByLabel('输入消息').fill('做一个产品宣传片')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-filled.png`, fullPage: true })

  await page.setViewportSize({ height: 844, width: 390 })
  // 初始折叠态按断点在挂载时取（matchMedia），改窗口后重载页面才能看到真实移动首屏；
  // mock 会话态随刷新归零，需要重新登录
  await page.reload()
  await login(page)
  await expect(page.getByRole('heading', { name: 'Producer' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/home-mobile.png`, fullPage: true })
})
