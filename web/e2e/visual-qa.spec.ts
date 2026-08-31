import { expect, test } from '@playwright/test'
import { login } from './login'

// 视觉验收截图专用：跑在 dev:mock 上，先登录再走首页。产物落仓库根 .artifacts/design-qa/（gitignore，不入库）。
const SHOT_DIR = '../.artifacts/design-qa'

test('会话页视觉验收：浅色 / 深色 / 运行中', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  // 那一轮还在跑：截停止钮与排队气泡
  await page.getByLabel('输入消息').fill('顺便把配音也排上')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('排队中')).toBeVisible()
  // 指针挪开再截：停止钮的 hover 过渡要落定，不然截到的是变色中间那一帧
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/conversation-busy.png`, fullPage: true })

  // 等演出来那一轮跑完（三段追加各 600ms），截到的就是完整一句
  await expect(page.getByText('好的，我先看一下这段素材，再把镜头表补齐。')).toBeVisible({
    timeout: 15_000,
  })

  await page.screenshot({ path: `${SHOT_DIR}/conversation-light.png`, fullPage: true })

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/conversation-dark.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
})

test('首页视觉验收：浅色 / 深色 / 移动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Cue' })).toBeAttached()
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
  await expect(page.getByRole('heading', { name: 'Cue' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/home-mobile.png`, fullPage: true })
})
