import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { seedMockWorkspace } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { ArtifactRegistry, WorkbenchRegistryProvider, type ArtifactEntry } from '@/shared/workbench'
import { WorkspaceFilesPanel } from './workspace-files-panel'

const CONVERSATION_ID = '4d3a7f8e-1b2c-4d5e-8f90-a1b2c3d4e5f6'

const artifact = {
  id: 'workspace',
  source: { fileCount: 6, kind: 'workspace' },
  title: '文件',
  type: 'workspace',
} as const

const shotsEntry: ArtifactEntry = {
  autoOpen: true,
  component: () => null,
  icon: 'grid',
  label: '分镜',
  match: { path: 'video_shot.json' },
  title: () => '分镜',
  type: 'storyboard',
}

const renderPanel = (initialPath = `/c/${CONVERSATION_ID}`) => {
  const registry = new ArtifactRegistry()
  registry.register(shotsEntry)
  return renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <WorkspaceFilesPanel artifact={artifact} conversationId={CONVERSATION_ID} />
    </WorkbenchRegistryProvider>,
    { initialPath },
  )
}

describe('WorkspaceFilesPanel 列表', () => {
  it('按目录分组列出文件：根目录在前，行上是文件名、大小与时间', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    const root = await screen.findByRole('region', { name: '根目录' })
    expect(within(root).getByRole('button', { name: /storyboard\.md/ })).toBeVisible()
    expect(within(root).getByRole('button', { name: /video_shot\.json/ })).toHaveTextContent('KB')

    const grids = screen.getByRole('region', { name: 'frames/grids' })
    expect(within(grids).getByRole('button', { name: /8e5263a4/ })).toBeVisible()
  })

  it('没有文件就是空态', async () => {
    server.use(
      http.get('*/api/conversations/:conversationId/workspace/files', () =>
        HttpResponse.json({ files: [] }),
      ),
    )
    await renderPanel()

    expect(await screen.findByText('还没有文件')).toBeVisible()
  })
})

describe('WorkspaceFilesPanel 阅读', () => {
  it('点一行进阅读，地址记下 file；Markdown 排成文档；返回回到列表并清掉 file', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    await userEvent.click(await screen.findByRole('button', { name: /storyboard\.md/ }))

    expect(await screen.findByRole('columnheader', { name: '结构层级' })).toBeVisible()
    expect(screen.getByText('MD')).toBeVisible()
    expect(router.state.location.search).toMatchObject({ file: 'storyboard.md' })

    await userEvent.click(screen.getByRole('button', { name: '返回文件列表' }))

    expect(await screen.findByRole('region', { name: '根目录' })).toBeVisible()
    expect(router.state.location.search).not.toHaveProperty('file')
  })

  it('JSON 排成树，图片地址是缩略图；「看原文」切到带行号的原文', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(
      `/c/${CONVERSATION_ID}?file=anchors%2Fb18d7e94-b199-441a-b14d-86df2cca7945.json`,
    )

    expect(await screen.findByRole('button', { name: '收起 cells' })).toBeVisible()
    expect(screen.getAllByRole('img').length).toBeGreaterThan(0)

    await userEvent.click(screen.getByRole('button', { name: '看原文' }))

    expect(screen.getByText('"anchorRecordVersion": 1,')).toBeVisible()
    expect(screen.getByRole('button', { name: '看结构' })).toBeVisible()
  })

  it('这份文件本身是别的产物时，给一个去那边打开的入口', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel(`/c/${CONVERSATION_ID}?file=video_shot.json`)

    await userEvent.click(await screen.findByRole('button', { name: '在分镜里打开' }))

    expect(router.state.location.search).toMatchObject({ artifact: 'file:video_shot.json' })
  })

  it('文件已经没了就说明白，能回列表', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=gone.md`)

    expect(await screen.findByText('这个文件已经不在了')).toBeVisible()
    expect(screen.getByRole('button', { name: '返回文件列表' })).toBeVisible()
  })
})
