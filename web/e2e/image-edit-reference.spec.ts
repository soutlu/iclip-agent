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
      await page.keyboard.insertText('改成蓝色')
      await expect(editor).toHaveText(`${prefix}标注 1改成蓝色`)
      // 光标落在刚输入的文字里；它与标注同一行，说明插入标注没有把后文挤到下一行。
      const reference = await editor
        .getByRole('button', { name: '标注 1', exact: true })
        .boundingBox()
      if (!reference) throw new Error('标注没有可测量的位置')
      const caret = await editor.evaluate(() => {
        const range = document.getSelection()?.getRangeAt(0)
        if (!range) throw new Error('编辑器没有光标')
        const rect = range.getBoundingClientRect()
        return { bottom: rect.bottom, top: rect.top }
      })
      expect(caret.top).toBeLessThan(reference.y + reference.height)
      expect(caret.bottom).toBeGreaterThan(reference.y)
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
