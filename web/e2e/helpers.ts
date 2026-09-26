/// <reference lib="dom" />

import { expect, type Page } from '@playwright/test'
import { login } from './login'

/** 登录后从侧栏进一段演示对话，返回右侧面板；紧凑屏的面板默认收着，mobile 时先打开。 */
export const openConversation = async (page: Page, title: string, { mobile = false } = {}) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: title, exact: true }).click()
  if (mobile) await page.getByRole('button', { name: '打开右侧面板' }).click()
  return page.getByRole('complementary', { name: '右侧面板' })
}

/** 把当前界面按浅色、深色各截一张验收图，存为 `${pathPrefix}-light.png` 与 `${pathPrefix}-dark.png`，截完切回浅色。 */
export const screenshotBothThemes = async (page: Page, pathPrefix: string) => {
  const apply = async (colorScheme: 'light' | 'dark') => {
    await page.emulateMedia({ colorScheme })
    // .dark 类由 matchMedia 的 change 监听异步切换，等它落定再截。
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(colorScheme === 'dark')
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await apply(colorScheme)
    // 冻结动画，切主题引起的颜色过渡不会拍在中途。
    await page.screenshot({ animations: 'disabled', path: `${pathPrefix}-${colorScheme}.png` })
  }
  await apply('light')
}

/**
 * 在页面里用 Canvas 画一张 600×800 的 PNG 当本地上传文件（上传前会校验短边至少 300）。
 * fill 是底色；给 label 时在中间画一块深色标签，截图里认得出这是测试图。
 */
export const canvasPng = async (
  page: Page,
  { fill = '#000000', label }: { fill?: string; label?: string } = {},
) => {
  const base64 = await page.evaluate(
    ({ fill, label }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 600
      canvas.height = 800
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('测试图片需要 Canvas 2D')
      context.fillStyle = fill
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (label !== undefined) {
        context.fillStyle = '#23503e'
        context.fillRect(70, 180, 460, 440)
        context.font = '36px sans-serif'
        context.fillStyle = '#ffffff'
        context.fillText(label, 180, 420)
      }
      return canvas.toDataURL('image/png').split(',')[1] ?? ''
    },
    { fill, label },
  )
  return Buffer.from(base64, 'base64')
}

/** video_shot.json 的一组镜头；分镜与复刻共用这份形状。 */
export type VideoShot = {
  index: number
  seconds: number
  image_urls: string[]
  prompt: {
    global_settings: string
    timeline: { timestamps: [number, number]; prompt: string; image_indexes: number[] }[]
  }
}

export type VideoShotDocument = { aspect_ratio: string; shots: VideoShot[] }

/** 读当前会话页工作区里的 video_shot.json 与版本号，断言写回结果；failure 是读取失败时报错的前缀。 */
export const readVideoShots = (page: Page, failure: string) =>
  page.evaluate(async (failure) => {
    const conversationId = window.location.pathname.split('/').at(-1)
    const response = await fetch(
      `/api/conversations/${conversationId}/workspace/file?path=video_shot.json`,
    )
    if (!response.ok) throw new Error(`${failure}：${response.status}`)
    const body = (await response.json()) as { file: { content: string; version: number } }
    return {
      document: JSON.parse(body.file.content) as VideoShotDocument,
      version: body.file.version,
    }
  }, failure)
