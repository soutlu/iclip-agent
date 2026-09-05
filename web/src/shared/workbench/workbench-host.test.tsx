/** 宿主接收壳计算的布局结果；测试直接注入 compact 与 sideBySide。 */

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ArtifactRendererProps } from './artifact'
import { ArtifactRegistry } from './registry'
import { WorkbenchHost } from './workbench-host'
import type { WorkbenchLayout } from './workbench-layout-context'
import { WorkbenchLayoutProvider } from './workbench-layout-provider'
import { WorkbenchRegistryProvider } from './workbench-registry-provider'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const registryWithTwo = () => {
  const registry = new ArtifactRegistry()
  registry.register({
    autoOpen: true,
    component: ({ artifact }: ArtifactRendererProps) => <p>画着{artifact.title}</p>,
    match: { path: 'video_shot.json' },
    title: () => '分镜',
    type: 'storyboard',
  })
  registry.register({
    autoOpen: false,
    component: ({ artifact }: ArtifactRendererProps) => <p>画着{artifact.title}</p>,
    match: { path: 'notes.md' },
    title: () => '笔记',
    type: 'notes',
  })
  return registry
}

const serveFiles = (paths: string[]) => {
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/files', () =>
      HttpResponse.json({
        files: paths.map((path) => ({
          path,
          sizeBytes: 10,
          updatedAt: '2026-09-01T10:00:00Z',
          version: 1,
        })),
      }),
    ),
  )
}

const ROOMY: WorkbenchLayout = { compact: false, sideBySide: true }

const renderHost = (layout: WorkbenchLayout = ROOMY, registry = registryWithTwo()) =>
  renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <WorkbenchLayoutProvider layout={layout}>
        <WorkbenchHost conversationId={CONVERSATION_ID} />
      </WorkbenchLayoutProvider>
    </WorkbenchRegistryProvider>,
  )

describe('WorkbenchHost', () => {
  it('一件产物都没有的对话保持折叠，展开后是空态与一句解释', async () => {
    serveFiles([])
    await renderHost()

    const expand = await screen.findByRole('button', { name: '展开右侧面板' })
    expect(screen.queryByText('还没有产物')).not.toBeInTheDocument()

    await userEvent.click(expand)

    expect(screen.getByText('还没有产物')).toBeVisible()
    expect(screen.getByText(/agent 交付分镜之后/)).toBeVisible()
  })

  it('紧凑屏保持折叠，哪怕有产物', async () => {
    serveFiles(['video_shot.json'])
    await renderHost({ compact: true, sideBySide: false })

    expect(await screen.findByRole('button', { name: '展开右侧面板' })).toBeVisible()
    expect(screen.queryByText('画着分镜')).not.toBeInTheDocument()
  })

  it('只有一件产物时不给切换器，直接画它', async () => {
    serveFiles(['video_shot.json'])
    await renderHost()

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.getByRole('heading', { name: '分镜' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '分镜' })).not.toBeInTheDocument()
  })

  it('产物不止一件时给切换器，默认选 autoOpen 的那件', async () => {
    serveFiles(['notes.md', 'video_shot.json'])
    await renderHost()

    expect(await screen.findByText('画着分镜')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '分镜' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: '笔记' }))

    expect(await screen.findByText('画着笔记')).toBeVisible()
  })

  it('放不下并排时是二选一形态：只给「回到聊天」，点了退回展开钮', async () => {
    serveFiles(['video_shot.json'])
    await renderHost({ compact: false, sideBySide: false })

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.queryByRole('button', { name: '放大面板' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '回到聊天' }))

    expect(screen.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
    expect(screen.queryByText('画着分镜')).not.toBeInTheDocument()
  })

  it('放得下并排时给放大与折叠，放大之后钮换成缩小', async () => {
    serveFiles(['video_shot.json'])
    await renderHost()

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.getByRole('button', { name: '折叠右侧面板' })).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '放大面板' }))

    expect(screen.getByRole('button', { name: '缩小面板' })).toBeVisible()
    expect(screen.getByText('画着分镜')).toBeVisible()
  })

  it('面板占着布局位时报给壳，折叠之后报不占', async () => {
    serveFiles(['video_shot.json'])
    const seen: boolean[] = []
    await renderHost({
      compact: false,
      onPanelVisible: (visible) => {
        seen.push(visible)
      },
      sideBySide: true,
    })

    await screen.findByText('画着分镜')
    expect(seen.at(-1)).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: '折叠右侧面板' }))
    expect(seen.at(-1)).toBe(false)
  })
})
