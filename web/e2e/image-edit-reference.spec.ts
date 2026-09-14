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
      const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
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

test('普通编辑只填写要求即可提交编辑底图', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  const group = page.getByRole('region', { name: '镜头组 1', exact: true })
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  const original = group.getByRole('img', { name: '镜头组 1 第 1 帧' })
  const sourceUrl = await original.getAttribute('src')
  await original.hover()
  await group.getByRole('button', { name: '编辑图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
  await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('将衣服改成蓝色')
  const submission = page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/image') && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  expect((await submission).postDataJSON()).toMatchObject({
    referenceImageUrls: [sourceUrl],
    prompt: '将衣服改成蓝色',
  })
})

for (const width of [1600, 390]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`图片编辑 ${width}px ${colorScheme}：键盘展开失败详情，并通过参考图菜单调整提交顺序`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.goto('/')
      await login(page)
      await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
      if (width === 390) await page.getByRole('button', { name: '打开右侧面板' }).click()
      const group = page.getByRole('region', { name: '镜头组 2', exact: true })
      await group.getByRole('button', { name: '镜头 2', exact: true }).click()
      await group.getByRole('button', { name: '预览第 3 帧' }).click()
      await group.getByRole('img', { name: '镜头组 2 第 3 帧' }).hover()
      await group.getByRole('button', { name: '编辑图片', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
      const history = dialog.getByRole('group', { name: '这一帧的图片' })
      await history.getByRole('button', { name: /^生成中 · / }).click()
      await dialog.getByRole('status').scrollIntoViewIfNeeded()
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/frame-image-editor/pending-${width}-${colorScheme}.png`,
      })

      await history.getByRole('button', { name: /^失败 · / }).click()
      const details = dialog.getByText('查看详情', { exact: true })
      await details.focus()
      await expect(details).toBeFocused()
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/frame-image-editor/failed-${width}-${colorScheme}.png`,
      })
      await details.press('Enter')
      const error = dialog.getByText(/^图像服务未能完成编辑（400）/)
      await expect(error).toBeVisible()
      await expect(details).toBeFocused()
      // 长服务响应在详情内换行、滚动，不把弹窗或移动端页面横向撑开。
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      )
      expect(await error.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      )
      await error.hover()
      await page.mouse.wheel(0, 600)
      await expect.poll(() => error.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/frame-image-editor/failed-details-${width}-${colorScheme}.png`,
      })
      await details.press('Enter')

      await dialog.getByRole('button', { name: '选择参考帧', exact: true }).click()
      const picker = page.getByRole('dialog', { name: '选择参考帧', exact: true })
      const reference = picker.getByRole('button', { name: '添加参考帧 2', exact: true })
      const referenceUrl = await reference.getByRole('img').getAttribute('src')
      if (referenceUrl === null) throw new Error('参考帧没有图片地址')
      await reference.click()
      await picker.getByRole('button', { name: '完成选择', exact: true }).click()
      const referenceList = dialog.getByRole('list', { name: '提交图片顺序' })
      const more = dialog.getByRole('button', { name: '参考图 2 更多操作', exact: true })
      await more.focus()
      await more.press('Enter')
      const move = page.getByRole('menuitem', { name: '参考图 2 向前移', exact: true })
      await expect(move).toBeFocused()
      await move.press('Enter')
      await expect(referenceList.getByRole('img').first()).toHaveAttribute('src', referenceUrl)

      // 重新打开第二张图片的菜单，End 直达移除；全过程不依赖悬浮后才出现的鼠标控件。
      await more.focus()
      await more.press('Enter')
      await page.keyboard.press('End')
      const remove = page.getByRole('menuitem', { name: '移除参考图 2', exact: true })
      await expect(remove).toBeFocused()
      await remove.press('Enter')
      await expect(referenceList.getByRole('img')).toHaveCount(1)
      await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('将背景改成暖色')
      const submission = page.waitForRequest(
        (request) =>
          request.url().endsWith('/api/generations/image') && request.method() === 'POST',
      )
      await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
      expect((await submission).postDataJSON()).toMatchObject({
        referenceImageUrls: [referenceUrl],
      })
    })

    test(`提交后关掉编辑器 ${width}px ${colorScheme}：帧上先显示生成中再变成有新结果，点开看过即清`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await page.goto('/')
      await login(page)
      await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
      if (width === 390) await page.getByRole('button', { name: '打开右侧面板' }).click()
      const group = page.getByRole('region', { name: '镜头组 1', exact: true })
      await group.getByRole('button', { name: '镜头 1', exact: true }).click()
      const filmstrip = group.getByRole('navigation', { name: '本组镜头', exact: true })
      await group.getByRole('img', { name: '镜头组 1 第 1 帧' }).hover()
      await group.getByRole('button', { name: '编辑图片', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
      await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('将衣服改成蓝色')
      await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
      await dialog.getByRole('button', { name: '关闭图片编辑', exact: true }).click()
      await expect(dialog).toBeHidden()

      // 关掉编辑器后帧上仍能看到任务在跑；mock 三秒后出图，前端每五秒问一次。
      await expect(group.getByText('生成中', { exact: true })).toBeVisible()
      await expect(
        filmstrip.getByRole('button', { name: '预览第 1 帧（生成中）', exact: true }),
      ).toBeVisible()
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/storyboard-reader/frame-image-running-${width}-${colorScheme}.png`,
      })
      const view = group.getByRole('button', { name: '有新结果 · 查看', exact: true })
      await expect(view).toBeVisible({ timeout: 15_000 })
      await expect(
        filmstrip.getByRole('button', { name: '预览第 1 帧（有新结果）', exact: true }),
      ).toBeVisible()
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/storyboard-reader/frame-image-result-${width}-${colorScheme}.png`,
      })

      await view.click()
      await expect(dialog).toBeVisible()
      // 从角标进来直接落在那条结果上：画布显示结果图，应用就能点。
      await expect(dialog.getByRole('img', { name: '图片编辑结果', exact: true })).toBeVisible()
      await expect(dialog.getByRole('button', { name: '应用到当前帧', exact: true })).toBeEnabled()
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/frame-image-editor/strip-${width}-${colorScheme}.png`,
      })
      await dialog.getByRole('button', { name: '关闭图片编辑', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(view).toBeHidden()
      await expect(
        filmstrip.getByRole('button', { name: '预览第 1 帧', exact: true }),
      ).toBeVisible()
    })
  }
}
