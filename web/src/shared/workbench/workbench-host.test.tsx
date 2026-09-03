/**
 * 宿主的几何与分派。
 *
 * jsdom 的 matchMedia 恒为不匹配，所以默认跑在「二选一」形态里（窄于并排断点）；要看并排那一档
 * 的按钮，用例自己换掉 matchMedia 再换回来。
 */

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ArtifactRendererProps } from './artifact'
import { ArtifactRegistry } from './registry'
import { WorkbenchHost } from './workbench-host'
import { WorkbenchRegistryProvider } from './workbench-registry-provider'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

/** 两条假条目：分镜自动打开，笔记不自动打开。渲染器只把自己认出来。 */
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

const renderHost = (registry = registryWithTwo()) =>
  renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <WorkbenchHost conversationId={CONVERSATION_ID} />
    </WorkbenchRegistryProvider>,
  )

/** 把视口当成放得下并排的宽度跑一段用例。 */
const asWideViewport = async (run: () => Promise<void>) => {
  const original = window.matchMedia
  window.matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  try {
    await run()
  } finally {
    window.matchMedia = original
  }
}

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

    // 文件列表里笔记在前，但自动打开的是分镜。
    expect(await screen.findByText('画着分镜')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '分镜' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: '笔记' }))

    expect(await screen.findByText('画着笔记')).toBeVisible()
  })

  it('窄屏是二选一形态：只给「回到聊天」，点了退回展开钮', async () => {
    serveFiles(['video_shot.json'])
    await renderHost()

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.queryByRole('button', { name: '放大面板' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '回到聊天' }))

    expect(screen.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
    expect(screen.queryByText('画着分镜')).not.toBeInTheDocument()
  })

  it('放得下并排时给放大与折叠，放大之后钮换成缩小', async () => {
    serveFiles(['video_shot.json'])
    await asWideViewport(async () => {
      await renderHost()

      expect(await screen.findByText('画着分镜')).toBeVisible()
      expect(screen.getByRole('button', { name: '折叠右侧面板' })).toBeVisible()

      await userEvent.click(screen.getByRole('button', { name: '放大面板' }))

      expect(screen.getByRole('button', { name: '缩小面板' })).toBeVisible()
      expect(screen.getByText('画着分镜')).toBeVisible()
    })
  })
})
