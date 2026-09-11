/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import { login } from './login'

for (const prefix of ['', '把']) {
  for (const method of ['鼠标', '回车'] as const) {
    test(`${prefix ? '文字后' : '空行'}用 @ ${method}选择标注后仍在原行继续输入`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 1000 })
      await page.goto('/')
      await login(page)
      await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
      const group = page.getByRole('region', { name: '镜头组 1', exact: true })
      await group.getByRole('button', { name: '镜头 1', exact: true }).click()
      await group.getByRole('img', { name: '镜头组 1 第 1 帧' }).hover()
      await group.getByRole('button', { name: '编辑图片', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '编辑图片', exact: true })
      await dialog.getByRole('button', { name: '点标注', exact: true }).click()
      await dialog.getByRole('group', { name: '图片标注画布', exact: true }).click()
      const editor = dialog.getByRole('textbox', { name: '修改要求', exact: true })
      await editor.fill(prefix)
      await editor.press('Shift+Digit2')
      await expect(dialog.getByRole('option', { name: '插入标注 1', exact: true })).toBeVisible()
      if (method === '鼠标')
        await dialog.getByRole('option', { name: '插入标注 1', exact: true }).click()
      else await editor.press('Enter')
      await expect(editor.getByRole('button', { name: '标注 1', exact: true })).toBeVisible()
      const tail = await editor.evaluate((element) => {
        const marker = element.querySelector('[role=button]')
        const lineEnd = element.querySelector('br')
        if (!marker || !lineEnd) throw new Error('缺少标注引用或行尾光标占位')
        return {
          referenceBottom: marker.getBoundingClientRect().bottom,
          caretTop: lineEnd.getBoundingClientRect().top,
        }
      })
      expect(tail.caretTop).toBeLessThan(tail.referenceBottom)
      await page.keyboard.insertText('改成蓝色')
      await expect(editor).toHaveText(`${prefix}标注 1改成蓝色`)
      const sameLine = await editor.evaluate((element) => {
        const chip = element.querySelector('[role=button]')
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node && !node.textContent?.includes('改成蓝色')) node = walker.nextNode()
        if (!chip || !node) throw new Error('缺少标注或输入文本')
        const range = document.createRange()
        range.selectNodeContents(node)
        const text = range.getBoundingClientRect()
        const reference = chip.getBoundingClientRect()
        return text.top < reference.bottom && text.bottom > reference.top
      })
      expect(sameLine).toBe(true)
      await expect(editor.locator('p')).toHaveCount(1)
      await expect(editor).toBeFocused()
    })
  }
}

test('普通编辑只填写要求即可提交当前原图', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  const group = page.getByRole('region', { name: '镜头组 1', exact: true })
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  const original = group.getByRole('img', { name: '镜头组 1 第 1 帧' })
  const sourceUrl = await original.getAttribute('src')
  await original.hover()
  await group.getByRole('button', { name: '编辑图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑图片', exact: true })
  await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('将衣服改成蓝色')
  const submission = page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/image') && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '生成编辑结果', exact: true }).click()
  expect((await submission).postDataJSON()).toMatchObject({
    referenceImageUrls: [sourceUrl],
    prompt: '将衣服改成蓝色',
  })
})
