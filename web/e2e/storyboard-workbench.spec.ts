import { expect, test } from '@playwright/test'
import { login } from './login'

// 分镜工作台要在真浏览器里验：右面板是路由声明的槽位，内容来自工作区文件与生成任务，
// 「agent 刚改过」靠 WebSocket 推来的 event.fs.changed 触发重读（src/testing/mocks/workspace.ts）。

// 并排要放得下侧栏 264 + 聊天 400 + 面板 820。
test.use({ viewport: { height: 900, width: 1600 } })

test('点开有分镜的对话：工作台铺开三组，翻组、等 agent 改文件', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  const panel = page.getByRole('complementary', { name: '右侧面板' })
  await expect(panel.getByRole('heading', { name: '分镜' })).toBeVisible()
  await expect(panel.getByText('3 组 · 合计 21 秒')).toBeVisible()

  const film = panel.getByLabel('镜头组')
  await expect(film.getByRole('button')).toHaveCount(3)

  await film.getByRole('button', { name: /硬切，她从长椅间走向镜头/ }).click()
  await expect(page).toHaveURL(/shot=2/)
  await expect(panel.getByText('11 秒 · 2 帧')).toBeVisible()
  await expect(panel.getByText(/走到近处停下微笑/)).toBeVisible()

  // mock 里 agent 在订上文件几秒后改了第 2 组：重读之后描述换了，胶片条标出改动
  await expect(panel.getByText(/台词并成一句/)).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('agent 刚改过').first()).toBeVisible()
})

test('没有工作区文件的对话仍是折叠空态', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await page.getByRole('link', { name: '通勤背包短视频', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  await expect(page.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分镜' })).toBeHidden()
})
