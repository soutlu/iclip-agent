/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { login } from './login'

const SHOT_DIR = '../.artifacts/design-qa/task-gallery'
const MY_TITLES = [
  '画廊验收｜秋冬鞋履系列新品内容创作，保留完整需求名称以便跨团队识别与查找',
  '画廊验收｜多款通勤系列',
  '画廊验收｜周末轻运动',
  '画廊验收｜经典正装系列',
  '画廊验收｜日常穿搭系列',
  '画廊验收｜秋季新品系列',
] as const
const OTHER_TITLES = ['细带凉鞋创作任务', '方跟短靴创作任务', '乐福鞋创作任务']

test.afterEach(async ({ page }) => {
  expect(await page.pageErrors(), '页面不应出现未捕获异常').toEqual([])
})

/** 复用上传验收的本地图片；无素材时使用现有上传测试 PNG，仅验证加载与布局。 */
const productPng = async () => {
  const fixture = process.env['TASK_GALLERY_QA_IMAGE'] ?? process.env['TASK_FORM_QA_IMAGE']
  if (fixture) return readFile(fixture)
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

/** 只通过浏览器 MSW 的已有接口准备数据，不绕过任务认领或图片上传合同。 */
const openGallery = async (page: Page) => {
  await page.goto('/')
  await login(page)
  const png = await productPng()
  await page.evaluate(
    async ({ bytes, mine, others }) => {
      const post = async (path: string, body?: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) throw new Error(`测试数据准备失败：${path} (${response.status})`)
        return response.json() as Promise<unknown>
      }
      const signed = (await post('/api/uploads/sign', {
        contentType: 'image/png',
        fileName: '商品.png',
        sizeBytes: bytes.length,
      })) as { uploadId: string; upload: { url: string; headers: Record<string, string> } }
      const upload = await fetch(signed.upload.url, {
        method: 'PUT',
        headers: signed.upload.headers,
        body: new Uint8Array(bytes),
      })
      if (!upload.ok) throw new Error(`测试图片上传失败 (${upload.status})`)
      const image = (await post(`/api/uploads/${signed.uploadId}/confirm`)) as { url: string }

      const create = async (title: string, index: number, claimed: boolean) => {
        const created = (await post('/api/tasks', {
          title,
          inputs: {
            creative_requirement: '展示商品原有轮廓与细节，保留调用方填写的需求名称。',
            products: Array.from({ length: index === 1 ? 4 : 1 }, (_, productIndex) => ({
              style_no: `QA-${claimed ? 'MINE' : 'ALL'}-${index}-${productIndex}`,
              name: ['黑色乐福鞋', '细带凉鞋', '白色运动鞋'][index % 3],
              image_oss_urls: [image.url],
            })),
          },
        })) as { task: { id: string } }
        await post(`/api/tasks/${created.task.id}/publish`)
        if (claimed) await post(`/api/tasks/${created.task.id}/confirm`)
      }
      // 列表按创建时间倒序；让长标题、多款、单款出现在首排。
      for (let index = mine.length - 1; index >= 0; index -= 1) {
        await create(mine[index], index, true)
      }
      for (let index = others.length - 1; index >= 0; index -= 1) {
        await create(others[index], index, false)
      }
    },
    { bytes: [...png], mine: [...MY_TITLES], others: OTHER_TITLES },
  )
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  if ((page.viewportSize()?.width ?? 1335) < 600) {
    await page.getByRole('button', { name: '折叠侧边栏' }).click()
  }
  await expect(page.getByRole('region', { name: '我的需求单' })).toBeVisible()
}

const cardsIn = (region: Locator) => region.getByRole('button', { name: /^查看需求：/ })

const boundsOf = async (locator: Locator) => {
  const bounds = await locator.boundingBox()
  if (!bounds) throw new Error('待验收元素未参与可见布局')
  return bounds
}

test('认领画廊可展开、搜索全部已加载需求，并保留详情与重命名入口', async ({ page }) => {
  await page.setViewportSize({ width: 1335, height: 1197 })
  await openGallery(page)
  const mine = page.getByRole('region', { name: '我的需求单' })
  const all = page.getByRole('region', { name: '全部需求单' })
  await expect(cardsIn(mine)).toHaveCount(3)
  await expect(cardsIn(all)).toHaveCount(9)
  await expect(mine.getByRole('button', { name: `查看需求：${MY_TITLES[4]}` })).toHaveCount(0)

  const expand = mine.getByRole('button', { name: '展开更多', exact: true })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expand.click()
  await expect(cardsIn(mine)).toHaveCount(6)
  const collapse = mine.getByRole('button', { name: '收起', exact: true })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await expect(all.getByRole('heading', { name: '全部需求单' })).toBeVisible()
  await page.mouse.move(0, 0)
  await page.screenshot({
    animations: 'disabled',
    path: `${SHOT_DIR}/desktop-expanded.png`,
  })
  await collapse.click()
  await expect(cardsIn(mine)).toHaveCount(3)
  await expect(expand).toHaveAttribute('aria-expanded', 'false')

  // 关键字只在原需求单 title 中；匹配范围不能被首页的三张预览截断。
  const search = page.getByRole('textbox', { name: '搜索需求单' })
  await search.fill('画廊验收')
  await expect(cardsIn(mine)).toHaveCount(6)
  await expect(cardsIn(all)).toHaveCount(6)
  await expect(expand).toHaveCount(0)
  await expect(collapse).toHaveCount(0)
  await search.fill(MY_TITLES[4])
  await expect(cardsIn(mine)).toHaveCount(1)
  await expect(cardsIn(all)).toHaveCount(1)

  const matchedCard = cardsIn(mine).first()
  await matchedCard.focus()
  await page.keyboard.press('Enter')
  const detail = page.getByRole('dialog', { name: MY_TITLES[4], exact: true })
  await expect(detail.getByLabel('需求单名称', { exact: true })).toHaveValue(MY_TITLES[4])
  await expect(detail.getByRole('button', { name: '开始创作', exact: true })).toBeVisible()
  await detail.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(detail).toBeHidden()
  await search.clear()
  await expect(cardsIn(mine)).toHaveCount(3)
  await expect(expand).toHaveAttribute('aria-expanded', 'false')

  await mine.getByRole('button', { name: '更多操作', exact: true }).first().click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog', { name: '重命名需求单', exact: true })
  await expect(rename.getByRole('textbox', { name: '新的需求单名称' })).toHaveValue(MY_TITLES[0])
  const updatedTitle = '画廊验收｜已更新的秋冬系列'
  await rename.getByRole('textbox', { name: '新的需求单名称' }).fill(updatedTitle)
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(rename).toBeHidden()
  await expect(mine.getByRole('button', { name: `查看需求：${updatedTitle}` })).toBeVisible()
  await expect(all.getByRole('button', { name: `查看需求：${updatedTitle}` })).toBeVisible()
  await expect(page).toHaveURL('/tasks')
})

for (const viewport of [
  { name: 'desktop', width: 1335, height: 1197 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`画廊视觉验收：${viewport.name} 浅深主题与长标题`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openGallery(page)
    const mine = page.getByRole('region', { name: '我的需求单' })
    const all = page.getByRole('region', { name: '全部需求单' })
    const cards = cardsIn(mine)
    await expect(cards).toHaveCount(3)
    await expect(cardsIn(all)).toHaveCount(9)
    await expect(page.getByRole('heading', { name: '需求单', exact: true })).toBeVisible()
    await expect(page.getByText('多人协同，打造超级团队', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建需求单', exact: true })).toBeVisible()
    await expect(cards.first()).toHaveAccessibleName(`查看需求：${MY_TITLES[0]}`)
    const first = await boundsOf(cards.nth(0))
    const second = await boundsOf(cards.nth(1))
    const third = await boundsOf(cards.nth(2))
    const cover = await boundsOf(cards.first().getByRole('img').first())
    // 方形商品原图贴合主图区域，避免 contain 在宽容器里留下深色边框。
    expect(Math.abs(cover.width - first.width)).toBeLessThan(1)
    expect(Math.abs(cover.width - cover.height)).toBeLessThan(1)

    if (viewport.name === 'desktop') {
      expect(Math.abs(first.y - second.y)).toBeLessThan(1)
      expect(Math.abs(first.y - third.y)).toBeLessThan(1)
      expect(first.x + first.width).toBeLessThan(second.x)
      expect(second.x + second.width).toBeLessThan(third.x)
      await expect(all.getByRole('heading', { name: '全部需求单' })).toBeInViewport()
      for (const card of (await cardsIn(all).all()).slice(0, 3)) {
        const image = card.getByRole('img').first()
        await expect(image).toBeInViewport()
        await expect
          .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
          .toBeGreaterThan(0)
      }
    } else {
      expect(Math.abs(first.x - second.x)).toBeLessThan(1)
      expect(Math.abs(first.x - third.x)).toBeLessThan(1)
      expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
      expect(third.y).toBeGreaterThanOrEqual(second.y + second.height)
      expect(first.x).toBeGreaterThanOrEqual(0)
      expect(first.x + first.width).toBeLessThanOrEqual(viewport.width)
      expect(
        await page.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth),
      ).toBe(true)
    }

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(colorScheme === 'dark')
      await page.getByRole('main').evaluate((main) => main.scrollTo(0, 0))
      await expect
        .poll(() =>
          cards
            .first()
            .getByRole('img')
            .first()
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0)
      await page.mouse.move(0, 0)
      await page.screenshot({
        animations: 'disabled',
        path: `${SHOT_DIR}/${viewport.name}-${colorScheme}.png`,
      })
      if (viewport.name === 'mobile') {
        await all.getByRole('heading', { name: '全部需求单' }).scrollIntoViewIfNeeded()
        await expect(cardsIn(all).first().getByRole('img').first()).toBeInViewport()
        await page.screenshot({
          animations: 'disabled',
          path: `${SHOT_DIR}/mobile-all-${colorScheme}.png`,
        })
      }
    }
  })
}
