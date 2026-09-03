import { expect, test } from '@playwright/test'
import { login } from './login'

// 宽度记在 localStorage 里，刷新还在——这条只有真浏览器验得了。

test.use({ viewport: { height: 900, width: 1600 } })

test('拖侧栏拖柄改宽，刷新之后还在', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const before = await sidebar.boundingBox()
  if (!before) throw new Error('侧栏没有可测量的位置')
  expect(before.width).toBeCloseTo(264, 0)

  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  const grip = await handle.boundingBox()
  if (!grip) throw new Error('拖柄没有可测量的位置')

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 6 })
  await page.mouse.up()

  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(324, 0)

  await page.reload()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(324, 0)
})

test('双击侧栏拖柄恢复默认宽', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  const grip = await handle.boundingBox()
  if (!grip) throw new Error('拖柄没有可测量的位置')

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(324, 0)

  await handle.dblclick()

  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(264, 0)
})

test('打开工作台之后聊天与面板之间也有一道拖柄', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel).toBeVisible()

  const before = await panel.boundingBox()
  if (!before) throw new Error('面板没有可测量的位置')
  expect(before.width).toBeCloseTo(820, 0)

  const handle = page.getByRole('button', { name: '调整面板宽度' })
  const grip = await handle.boundingBox()
  if (!grip) throw new Error('拖柄没有可测量的位置')

  // 往右拖是把面板压窄
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 80, grip.y + grip.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => (await panel.boundingBox())?.width).toBeCloseTo(740, 0)
})
