import { expect, test } from '@playwright/test'
import { login } from './login'

// 在 dev:mock 中生成视觉验收截图，输出到忽略入库的 .artifacts/design-qa/。
const SHOT_DIR = '../.artifacts/design-qa'

test('会话页视觉验收：浅色 / 深色 / 运行中', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  await page.getByRole('button', { name: '停止' }).waitFor()
  await page.getByLabel('输入消息').fill('顺便把配音也排上')
  await page.getByLabel('输入消息').press('Enter')
  await expect(page.getByText('1 个任务等待发送')).toBeVisible()
  // 等待流式活动组可见再截图，避免捕获批次尚未到达的空态。
  await expect(page.getByRole('button', { name: /进行中：/ })).toBeVisible()
  // 移开指针并等待 hover 过渡结束，保证截图稳定。
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/conversation-busy.png`, fullPage: true })

  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  await page.getByText('看设定').click()
  await expect(page.getByRole('table')).toBeVisible()

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
  // 等待 Lottie JSON 加载和入场动画完成。
  await page.waitForTimeout(1200)

  await page.screenshot({ path: `${SHOT_DIR}/home-light.png`, fullPage: true })

  await page.emulateMedia({ colorScheme: 'dark' })
  // 等待主题切换与交互色过渡完成。
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-dark.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })

  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-sidebar-collapsed.png`, fullPage: true })
  await page.getByRole('button', { name: '展开侧边栏' }).click()

  await page.getByLabel('输入消息').fill('做一个产品宣传片')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-filled.png`, fullPage: true })

  await page.setViewportSize({ height: 844, width: 390 })
  // 折叠初态只在挂载时读取断点，调整视口后重载；MSW 会话会随重载清空，需重新登录。
  await page.reload()
  await login(page)
  await expect(page.getByRole('heading', { name: 'Cue' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/home-mobile.png`, fullPage: true })
})

test('首页 composer 附件视觉验收：内联 pill 与悬停卡', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Cue' })).toBeAttached()

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await page
    .locator('input[type="file"]')
    .setInputFiles({ buffer: png, mimeType: 'image/png', name: '夜景参考图.png' })

  const pill = page.getByText('夜景参考图.png')
  await expect(pill).toBeVisible()
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-attachment.png`, fullPage: true })

  await pill.hover()
  // 传完后卡上第二行报大小；mock 的公网地址加载不出图，所以没有像素尺寸。
  await expect(page.getByText('70 B')).toBeVisible()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-attachment-tip.png`, fullPage: true })
})
